/**
 * @fileoverview Antigravity Context Analyzer by q1u
 * Parses Antigravity transcripts and produces comprehensive context metrics,
 * token breakdowns, timeline evolution, and aggregated local token usage.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import cp from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let DatabaseSync = null;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch {}

// Known model limits (in tokens) - Antigravity runtime assigns a 256k budget limit (256,000 nominal)
export const MODEL_LIMITS = {
  'gemini-4-neon': 256000,
  'gemini-4-carbon': 256000,
  'gemini-4-hydrogen': 256000,
  'gemini-4-argon': 256000,
  'gemini-3.8-flash': 256000,
  'gemini-3.7-flash': 256000,
  'gemini-3.6-flash': 256000,
  'gemini-3.1-pro': 256000,
  'gemini-3-flash': 256000,
  'gemini-1.5-pro': 256000,
  'gemini-1.5-flash': 256000,
  'gemini-flash': 256000,
  'gemini-pro': 256000,
  'flash': 256000,
  'pro': 256000,
  'flash_lite': 256000,
  'default': 256000
};

/**
 * Estimates token count from string content
 * @param {string} text 
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 3.6));
}

/**
 * Formats large token numbers nicely (e.g. 47.1M, 265.5K)
 * @param {number} num 
 * @returns {string}
 */
export function formatCompactNumber(num) {
  if (num >= 1e6) {
    return (num / 1e6).toFixed(1) + 'M';
  }
  if (num >= 1e3) {
    return (num / 1e3).toFixed(1) + 'K';
  }
  return num.toString();
}

/**
 * Locates the transcript file for a conversation
 * @param {string} [convId]
 * @param {string} [customPath]
 * @returns {string|null}
 */
export function resolveTranscriptPath(convId, customPath) {
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }

  const appDataDir = process.env.ANTIGRAVITY_APP_DATA_DIR || 
    path.join(os.homedir(), '.gemini', 'antigravity');
  const targetConvId = convId || process.env.ANTIGRAVITY_CONVERSATION_ID;

  if (targetConvId) {
    const candidate = path.join(appDataDir, 'brain', targetConvId, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(candidate)) return candidate;
  }

  const brainDir = path.join(appDataDir, 'brain');
  if (fs.existsSync(brainDir)) {
    try {
      const dirs = fs.readdirSync(brainDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .map(d => {
          const tPath = path.join(brainDir, d.name, '.system_generated', 'logs', 'transcript.jsonl');
          return {
            id: d.name,
            path: tPath,
            mtime: fs.existsSync(tPath) ? fs.statSync(tPath).mtimeMs : 0
          };
        })
        .filter(d => d.mtime > 0)
        .sort((a, b) => b.mtime - a.mtime);

      if (dirs.length > 0) {
        return dirs[0].path;
      }
    } catch (e) {
      // Fallback
    }
  }

  return null;
}

// Global in-memory cache for native token scan
let cachedNativeStats = null;
let lastNativeScanMs = 0;
let lastNativeScanDateKey = '';
let lastNativeIncludesOlder = false;
let lastNativeScanSnapshot = null;
let inFlightNativeScanPromise = null;
let inFlightIncludesOlder = false;
let activeNativeScanSeq = 0;
let committedNativeScanSeq = 0;

const DISK_INDEX_VERSION = 1;
const DISK_INDEX_PATH = path.join(os.homedir(), '.gemini', 'antigravity', 'plugin_data', 'agy-context', 'token-index.v1.json');
let diskIndexLoaded = false;
let diskIndexWriteTimer = null;
let diskIndexDirty = false;
let scannedFullHistory = false;

let cachedPricingState = null;
const modelPricingCache = new Map();
let archiveParseCache = null;
const dbParseCache = new Map();
const sessionPerfCache = new Map();
const transcriptParseCache = new Map();

function setBoundedCache(cacheMap, key, value, maxSize) {
  if (!cacheMap.has(key) && cacheMap.size >= maxSize) {
    const oldestKey = cacheMap.keys().next().value;
    if (oldestKey !== undefined) cacheMap.delete(oldestKey);
  }
  cacheMap.set(key, value);
}

// OpenRouter real-time API pricing rates ($ per 1M tokens, synced 2026-11-19)
// Configured for active & recent Antigravity models:
// - Gemini 4 family: Neon (new 2026-11-18), Carbon, Argon, Hydrogen (+ Orchestrator labels)
// - Gemini 3.x family: 3.8 Flash, 3.7 Flash, 3.6 Flash, 3.1 Pro, Nano Banana 2 / 2.1
// - Partner models: Claude Sonnet/Opus 5.5, Claude Sonnet/Opus 4.6, GPT-OSS 120B
export const DEFAULT_MODEL_PRICING = {
  // 0. Gemini 4 Neon series (OpenRouter google/gemini-4-neon, launched 2026-11-18)
  'gemini-4-neon': { input: 3.00, output: 15.00, cached: 0.15 },
  'gemini 4 neon': { input: 3.00, output: 15.00, cached: 0.15 },
  'google/gemini-4-neon': { input: 3.00, output: 15.00, cached: 0.15 },

  // 1. Gemini 3.8 Flash series (OpenRouter google/gemini-3.8-flash)
  'gemini-3.8-flash': { input: 0.825, output: 4.125, cached: 0.0825 },
  'gemini 3.8 flash': { input: 0.825, output: 4.125, cached: 0.0825 },
  'gemini 3.8 flash (high)': { input: 0.825, output: 4.125, cached: 0.0825 },
  'gemini 3.8 flash high': { input: 0.825, output: 4.125, cached: 0.0825 },
  'gemini-3.8-flash-tiered': { input: 0.825, output: 4.125, cached: 0.0825 },
  'gemini-3.8-flash-n': { input: 0.825, output: 4.125, cached: 0.0825 },
  'google/gemini-3.8-flash': { input: 0.825, output: 4.125, cached: 0.0825 },

  // 1b. Gemini 3.7 & 3.6 Flash series (Enterprise, OpenRouter google/gemini-3.7-flash & 3.6-flash)
  'gemini-3.7-flash': { input: 0.75, output: 3.75, cached: 0.075 },
  'gemini 3.7 flash': { input: 0.75, output: 3.75, cached: 0.075 },
  'google/gemini-3.7-flash': { input: 0.75, output: 3.75, cached: 0.075 },
  'gemini-3.6-flash': { input: 0.75, output: 3.75, cached: 0.075 },
  'gemini 3.6 flash': { input: 0.75, output: 3.75, cached: 0.075 },
  'google/gemini-3.6-flash': { input: 0.75, output: 3.75, cached: 0.075 },

  // 1c. Gemini 3.1 Pro series (Enterprise, OpenRouter google/gemini-3.1-pro-preview)
  'gemini-3.1-pro': { input: 2.00, output: 12.00, cached: 0.20 },
  'gemini 3.1 pro': { input: 2.00, output: 12.00, cached: 0.20 },
  'gemini-3.1-pro-preview': { input: 2.00, output: 12.00, cached: 0.20 },
  'google/gemini-3.1-pro-preview': { input: 2.00, output: 12.00, cached: 0.20 },

  // 1d. Nano Banana 2 / 2.1 (Generative image helper models on OpenRouter)
  'gemini-nano-banana-2.1': { input: 1.50, output: 7.50, cached: 0 },
  'nano banana 2.1': { input: 1.50, output: 7.50, cached: 0 },
  'google/gemini-nano-banana-2.1': { input: 1.50, output: 7.50, cached: 0 },
  'gemini-3.1-flash-image': { input: 0.50, output: 3.00, cached: 0 },
  'nano banana 2': { input: 0.50, output: 3.00, cached: 0 },
  'google/gemini-3.1-flash-image': { input: 0.50, output: 3.00, cached: 0 },

  // 2. Gemini 4 Argon series (OpenRouter google/gemini-4-argon)
  'gemini-4-argon': { input: 2.00, output: 10.00, cached: 0.10 },
  'gemini 4 argon': { input: 2.00, output: 10.00, cached: 0.10 },
  'google/gemini-4-argon': { input: 2.00, output: 10.00, cached: 0.10 },

  // 3. Gemini 4 Carbon series (OpenRouter google/gemini-4-carbon)
  'gemini-4-carbon': { input: 2.00, output: 10.00, cached: 0.10 },
  'gemini 4 carbon': { input: 2.00, output: 10.00, cached: 0.10 },
  'google/gemini-4-carbon': { input: 2.00, output: 10.00, cached: 0.10 },

  // 4. Gemini 4 Hydrogen series (OpenRouter google/gemini-4-hydrogen)
  'gemini-4-hydrogen': { input: 1.50, output: 7.50, cached: 0.075 },
  'gemini 4 hydrogen': { input: 1.50, output: 7.50, cached: 0.075 },
  'google/gemini-4-hydrogen': { input: 1.50, output: 7.50, cached: 0.075 },

  // 5. Claude Sonnet 4.6 series (OpenRouter anthropic/claude-sonnet-4.6)
  'claude-sonnet-4.6': { input: 3.00, output: 15.00, cached: 0.30 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, cached: 0.30 },
  'claude sonnet 4.6': { input: 3.00, output: 15.00, cached: 0.30 },
  'claude sonnet 4.6 (thinking)': { input: 3.00, output: 15.00, cached: 0.30 },
  'anthropic/claude-sonnet-4.6': { input: 3.00, output: 15.00, cached: 0.30 },

  // 6. Claude Opus 4.6 series (OpenRouter anthropic/claude-opus-4.6)
  'claude-opus-4.6': { input: 5.00, output: 25.00, cached: 0.50 },
  'claude-opus-4-6': { input: 5.00, output: 25.00, cached: 0.50 },
  'claude opus 4.6': { input: 5.00, output: 25.00, cached: 0.50 },
  'claude opus 4.6 (thinking)': { input: 5.00, output: 25.00, cached: 0.50 },
  'anthropic/claude-opus-4.6': { input: 5.00, output: 25.00, cached: 0.50 },

  // 7. GPT-OSS 120B series (OpenRouter openai/gpt-oss-120b)
  'gpt-oss-120b': { input: 0.15, output: 0.60, cached: 0.075 },
  'gpt-oss 120b': { input: 0.15, output: 0.60, cached: 0.075 },
  'gpt-oss 120b (medium)': { input: 0.15, output: 0.60, cached: 0.075 },
  'openai/gpt-oss-120b': { input: 0.15, output: 0.60, cached: 0.075 },

  // 8. Claude Sonnet 5.5 series (OpenRouter anthropic/claude-sonnet-5.5)
  'claude-sonnet-5.5': { input: 2.00, output: 10.00, cached: 0.10 },
  'claude-sonnet-5-5': { input: 2.00, output: 10.00, cached: 0.10 },
  'claude sonnet 5.5': { input: 2.00, output: 10.00, cached: 0.10 },
  'claude-sonnet-5-5-high': { input: 2.00, output: 10.00, cached: 0.10 },
  'claude sonnet 5.5 (high)': { input: 2.00, output: 10.00, cached: 0.10 },
  'claude sonnet 5.5 (thinking)': { input: 2.00, output: 10.00, cached: 0.10 },
  'anthropic/claude-sonnet-5.5': { input: 2.00, output: 10.00, cached: 0.10 },

  // 9. Claude Opus 5.5 series (OpenRouter anthropic/claude-opus-5.5)
  'claude-opus-5.5': { input: 4.00, output: 20.00, cached: 0.20 },
  'claude-opus-5-5': { input: 4.00, output: 20.00, cached: 0.20 },
  'claude opus 5.5': { input: 4.00, output: 20.00, cached: 0.20 },
  'claude-opus-5-5-high': { input: 4.00, output: 20.00, cached: 0.20 },
  'claude opus 5.5 (high)': { input: 4.00, output: 20.00, cached: 0.20 },
  'claude opus 5.5 (thinking)': { input: 4.00, output: 20.00, cached: 0.20 },
  'anthropic/claude-opus-5.5': { input: 4.00, output: 20.00, cached: 0.20 }
};

/**
 * Loads user custom pricing config from ~/.gemini/antigravity/pricing_config.json
 * Supports user-defined overrides while keeping official defaults as fallback.
 * @returns {object}
 */
function loadPricingState() {
  const now = Date.now();
  if (cachedPricingState && (now - cachedPricingState.checkedAt < 5000)) {
    return cachedPricingState;
  }
  const customConfigPath = path.join(os.homedir(), '.gemini', 'antigravity', 'pricing_config.json');
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(customConfigPath).mtimeMs;
  } catch {}
  if (cachedPricingState && cachedPricingState.mtimeMs === mtimeMs) {
    cachedPricingState.checkedAt = now;
    return cachedPricingState;
  }
  let customRates = {};
  if (mtimeMs >= 0) {
    try {
      const parsed = JSON.parse(fs.readFileSync(customConfigPath, 'utf8'));
      if (parsed && typeof parsed.rates === 'object') {
        customRates = parsed.rates;
      }
    } catch (e) {}
  }
  const merged = { ...DEFAULT_MODEL_PRICING, ...customRates };
  const customOnly = {};
  for (const [k, pRate] of Object.entries(merged)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_MODEL_PRICING, k) || DEFAULT_MODEL_PRICING[k] !== pRate) {
      customOnly[k.toLowerCase().trim()] = pRate;
    }
  }
  modelPricingCache.clear();
  cachedPricingState = { checkedAt: now, mtimeMs, merged, customOnly };
  return cachedPricingState;
}

export function getMergedPricingConfig() {
  return loadPricingState().merged;
}

function matchPricingFromTable(lower, table) {
  if (Object.prototype.hasOwnProperty.call(table, lower)) return table[lower];
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (lower.includes(key)) return table[key];
  }
  return null;
}

const HEURISTIC_PRICING_RULES = [
  { match: l => l.includes('opus') && (l.includes('5.5') || l.includes('5-5')), rate: { input: 4.00, output: 20.00, cached: 0.20 } },
  { match: l => l.includes('sonnet') && (l.includes('5.5') || l.includes('5-5')), rate: { input: 2.00, output: 10.00, cached: 0.10 } },
  { match: l => l.includes('opus') && (l.includes('4.6') || l.includes('4-6')), rate: { input: 5.00, output: 25.00, cached: 0.50 } },
  { match: l => l.includes('sonnet') && (l.includes('4.6') || l.includes('4-6')), rate: { input: 3.00, output: 15.00, cached: 0.30 } },
  { match: l => l.includes('gpt-oss') && l.includes('120b'), rate: { input: 0.15, output: 0.60, cached: 0.075 } },
  { match: l => l.includes('neon'), rate: { input: 3.00, output: 15.00, cached: 0.15 } },
  { match: l => l.includes('carbon'), rate: { input: 2.00, output: 10.00, cached: 0.10 } },
  { match: l => l.includes('hydrogen'), rate: { input: 1.50, output: 7.50, cached: 0.075 } },
  { match: l => l.includes('argon'), rate: { input: 2.00, output: 10.00, cached: 0.10 } },
  { match: l => l.includes('3.8') && l.includes('flash'), rate: { input: 0.825, output: 4.125, cached: 0.0825 } },
  { match: l => (l.includes('3.7') || l.includes('3.6')) && l.includes('flash'), rate: { input: 0.75, output: 3.75, cached: 0.075 } },
  { match: l => l.includes('3.1') && l.includes('pro'), rate: { input: 2.00, output: 12.00, cached: 0.20 } },
  { match: l => l.includes('nano banana 2.1') || l.includes('nano-banana-2.1'), rate: { input: 1.50, output: 7.50, cached: 0 } },
  { match: l => l.includes('nano banana 2') || l.includes('nano-banana-2'), rate: { input: 0.50, output: 3.00, cached: 0 } }
];

export function getModelPricing(modelName) {
  const lower = (modelName || '').toLowerCase().trim();
  if (!lower) return null;

  const pricingState = loadPricingState();
  if (modelPricingCache.has(lower)) {
    return modelPricingCache.get(lower);
  }

  // Explicitly ignore deprecated / discontinued models
  if (lower.includes('1.5') || lower.includes('gemini-3-flash') || lower.includes('gemini 3 flash') || lower.includes('3.5') || lower.includes('3-5')) {
    modelPricingCache.set(lower, null);
    return null;
  }

  // 1. User custom rates take priority, then default pricing table (exact -> longest substring)
  let matched = matchPricingFromTable(lower, pricingState.customOnly);
  if (!matched) {
    matched = matchPricingFromTable(lower, DEFAULT_MODEL_PRICING);
  }

  // 2. Heuristic fallback rules for active model variants (including Orchestrator labels)
  if (!matched) {
    for (const rule of HEURISTIC_PRICING_RULES) {
      if (rule.match(lower)) {
        matched = rule.rate;
        break;
      }
    }
  }

  modelPricingCache.set(lower, matched || null);
  return matched || null;
}

/**
 * Pure JavaScript Protobuf wire format decoding utilities
 * Zero external dependencies.
 */
function decodeVarint(buf, offset) {
  let res = 0n;
  let shift = 0n;
  let o = offset;
  while (o < buf.length) {
    const b = buf[o++];
    res |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { val: Number(res), next: o };
    shift += 7n;
  }
  return null;
}

function getBytesField(fieldNum, buf) {
  if (!buf) return null;
  let o = 0;
  while (o < buf.length) {
    const tag = decodeVarint(buf, o);
    if (!tag) break;
    o = tag.next;
    const num = tag.val >>> 3;
    const wire = tag.val & 7;
    if (wire === 0) {
      const v = decodeVarint(buf, o);
      if (!v) break;
      o = v.next;
    } else if (wire === 1) {
      o += 8;
    } else if (wire === 5) {
      o += 4;
    } else if (wire === 2) {
      const len = decodeVarint(buf, o);
      if (!len) break;
      o = len.next;
      if (num === fieldNum) {
        return buf.subarray(o, o + len.val);
      }
      o += len.val;
    } else {
      break;
    }
  }
  return null;
}

function getVarintField(fieldNum, buf) {
  if (!buf) return null;
  let o = 0;
  while (o < buf.length) {
    const tag = decodeVarint(buf, o);
    if (!tag) break;
    o = tag.next;
    const num = tag.val >>> 3;
    const wire = tag.val & 7;
    if (wire === 0) {
      const v = decodeVarint(buf, o);
      if (!v) break;
      o = v.next;
      if (num === fieldNum) return v.val;
    } else if (wire === 1) {
      o += 8;
    } else if (wire === 5) {
      o += 4;
    } else if (wire === 2) {
      const len = decodeVarint(buf, o);
      if (!len) break;
      o = len.next + len.val;
    } else {
      break;
    }
  }
  return null;
}

function getStringField(fieldNum, buf) {
  const b = getBytesField(fieldNum, buf);
  if (!b || b.length === 0) return null;
  try {
    const raw = Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength);
    const s = raw.toString('utf8').trim();
    return s.length > 0 ? s : null;
  } catch { return null; }
}

function getDuration(buf) {
  if (!buf) return null;
  const sec = getVarintField(1, buf) || 0;
  const nanos = getVarintField(2, buf) || 0;
  if (nanos >= 1e9) return null;
  const val = sec + nanos / 1e9;
  return (val > 0 && Number.isFinite(val)) ? val : null;
}

function isTextCompleteStep(status, payload) {
  if (Number(status) !== 3 || !payload) return false;
  const payBuf = (payload instanceof Uint8Array) ? payload : Buffer.from(payload, 'hex');
  const resp = getBytesField(20, payBuf);
  if (!resp) return false;
  const stopReason = getVarintField(12, resp);
  const textResp = getStringField(1, resp);
  const toolCalls = getBytesField(7, resp);
  return stopReason === 2 && Boolean(textResp) && !toolCalls;
}

function getDbFileSignatureAndMtime(dbPath) {
  try {
    const st = fs.statSync(dbPath);
    let sig = `${st.mtimeMs}:${st.size}`;
    let effectiveMtimeMs = st.mtimeMs;
    try {
      const walSt = fs.statSync(`${dbPath}-wal`);
      sig += `|${walSt.mtimeMs}:${walSt.size}`;
      if (walSt.mtimeMs > effectiveMtimeMs) effectiveMtimeMs = walSt.mtimeMs;
    } catch {}
    return { sig, effectiveMtimeMs };
  } catch {
    return null;
  }
}

function getDbFileSignature(dbPath) {
  const info = getDbFileSignatureAndMtime(dbPath);
  return info ? info.sig : null;
}

function loadDiskTokenIndex() {
  if (diskIndexLoaded) return;
  diskIndexLoaded = true;
  if (!fs.existsSync(DISK_INDEX_PATH)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(DISK_INDEX_PATH, 'utf8'));
    if (!parsed || parsed.version !== DISK_INDEX_VERSION || !parsed.dbs || typeof parsed.dbs !== 'object') return;
    for (const [dbPath, item] of Object.entries(parsed.dbs)) {
      if (!item || typeof item !== 'object' || !item.sig) continue;
      const events = Array.isArray(item.events)
        ? item.events.map(ev => ({
            timestamp_seconds: Number(ev[0]) || 0,
            model: String(ev[1] || '未知模型'),
            input_tokens: Number(ev[2]) || 0,
            output_tokens: Number(ev[3]) || 0,
            cached_tokens: Number(ev[4]) || 0,
            total_tokens: (Number(ev[2]) || 0) + (Number(ev[3]) || 0) + (Number(ev[4]) || 0)
          }))
        : [];
      const samples = Array.isArray(item.samples)
        ? item.samples.map(sm => ({
            model: String(sm[0] || ''),
            source: String(sm[1] || 'antigravity'),
            timestamp: Number(sm[2]) || 0,
            first_text_seconds: Number(sm[3]) || 0,
            body_tokens_per_second: Number(sm[4]) || 0
          }))
        : [];
      const stepRecords = Array.isArray(item.stepRecords)
        ? item.stepRecords.map(sr => ({ ts: sr[0] || null, textComplete: Boolean(sr[1]) }))
        : [];
      dbParseCache.set(dbPath, {
        sig: item.sig,
        archivedCount: Number(item.archivedCount || 0),
        lastGenIdx: item.lastGenIdx !== undefined ? Number(item.lastGenIdx) : -1,
        genRowCount: Number(item.genRowCount || 0),
        lastStepIdx: item.lastStepIdx !== undefined ? Number(item.lastStepIdx) : -1,
        stepCount: Number(item.stepCount !== undefined ? item.stepCount : stepRecords.length),
        lastStepPending: Boolean(item.lastStepPending),
        stepRecords,
        events,
        samples,
        totalGenerations: Number(item.totalGenerations || 0),
        skippedLarge: Number(item.skippedLarge || 0),
        hasPerfScan: Boolean(item.hasPerfScan)
      });
    }
  } catch (err) {
    console.warn('[agy-context] Failed to load disk token index:', err.message);
  }
}

function flushDiskTokenIndexSync() {
  if (!diskIndexDirty) return;
  diskIndexDirty = false;
  const tmpPath = `${DISK_INDEX_PATH}.tmp.${process.pid}.${Date.now()}`;
  try {
    const dir = path.dirname(DISK_INDEX_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const sampleCutoffSec = Math.floor(Date.now() / 1000) - 8 * 24 * 3600;
    const dbsObj = {};
    for (const [dbPath, entry] of dbParseCache.entries()) {
      const prunedSamples = (entry.samples || []).filter(s => s.timestamp >= sampleCutoffSec);
      dbsObj[dbPath] = {
        sig: entry.sig,
        archivedCount: entry.archivedCount,
        lastGenIdx: entry.lastGenIdx ?? -1,
        genRowCount: entry.genRowCount ?? 0,
        lastStepIdx: entry.lastStepIdx ?? -1,
        stepCount: entry.stepCount ?? (entry.stepRecords ? entry.stepRecords.length : 0),
        lastStepPending: Boolean(entry.lastStepPending),
        stepRecords: (entry.stepRecords || []).map(sr => [sr.ts || 0, sr.textComplete ? 1 : 0]),
        events: (entry.events || []).map(e => [
          e.timestamp_seconds,
          e.model,
          e.input_tokens,
          e.output_tokens,
          e.cached_tokens
        ]),
        samples: prunedSamples.map(s => [
          s.model,
          s.source,
          s.timestamp,
          s.first_text_seconds,
          s.body_tokens_per_second
        ]),
        totalGenerations: entry.totalGenerations || 0,
        skippedLarge: entry.skippedLarge || 0,
        hasPerfScan: Boolean(entry.hasPerfScan)
      };
    }
    fs.writeFileSync(tmpPath, JSON.stringify({
      version: DISK_INDEX_VERSION,
      updatedAt: new Date().toISOString(),
      dbs: dbsObj
    }), 'utf8');
    fs.renameSync(tmpPath, DISK_INDEX_PATH);
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    console.warn('[agy-context] Failed to flush disk token index:', err.message);
  }
}

function scheduleSaveDiskTokenIndex() {
  diskIndexDirty = true;
  if (diskIndexWriteTimer) return;
  diskIndexWriteTimer = setTimeout(() => {
    diskIndexWriteTimer = null;
    flushDiskTokenIndexSync();
  }, 1500);
  if (typeof diskIndexWriteTimer.unref === 'function') {
    diskIndexWriteTimer.unref();
  }
}

/**
 * Executes a SQLite query using the system's sqlite3 CLI binary
 * @param {string} dbPath
 * @param {string} sql
 * @param {number} [timeout=8000]
 * @returns {Array} Array of parsed JSON objects
 */
function querySqlite(dbPath, sql, timeout = 8000) {
  if (DatabaseSync) {
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout });
    try {
      return db.prepare(sql).all();
    } finally {
      try { db.close(); } catch {}
    }
  }

  const stdout = cp.execFileSync('sqlite3', ['-batch', '-json', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout,
    windowsHide: true
  });
  return JSON.parse(stdout.trim() || '[]');
}

function parseStepsAndGenRows(stepsRows, genRows, { useRawBlob, source, archivedIds, existingStepRecords = [], startOrdinal = 0, existingLastStepIdx = -1, replaceLastStep = false }) {
  const stepRecords = existingStepRecords.slice();
  if (replaceLastStep && stepRecords.length > 0 && stepsRows.length > 0) {
    stepRecords.pop();
  }

  let maxStepIdx = existingLastStepIdx;
  let lastStepPending = false;
  for (const r of stepsRows) {
    if (r.idx !== undefined && r.idx !== null) {
      const sIdx = Number(r.idx);
      if (sIdx > maxStepIdx) maxStepIdx = sIdx;
    }
    let ts = null;
    if (r.m) {
      const metaBuf = useRawBlob ? r.m : Buffer.from(r.m, 'hex');
      const f1 = getBytesField(1, metaBuf);
      if (f1) {
        const sec = getVarintField(1, f1);
        if (sec && sec > 0) ts = sec;
      }
    }
    const textComplete = r.p ? isTextCompleteStep(r.status, r.p) : false;
    lastStepPending = Number(r.status) !== 3;
    stepRecords.push({ ts, textComplete });
  }

  const events = [];
  const samples = [];
  let dbGenerations = 0;
  let dbSkippedLarge = 0;
  let maxGenIdx = -1;
  let ordinal = startOrdinal;

  for (const r of genRows) {
    const curOrdinal = ordinal++;
    const genIdx = Number(r.idx);
    if (genIdx > maxGenIdx) maxGenIdx = genIdx;
    const isArchived = archivedIds && archivedIds.has(genIdx);
    if (!isArchived) dbGenerations++;

    const blobSize = Number(r.len || 0);
    const rawPayload = useRawBlob ? r.data : r.h;
    if (blobSize > 64 * 1024 * 1024 || !rawPayload) {
      if (!isArchived) dbSkippedLarge++;
      continue;
    }

    const buf = useRawBlob ? rawPayload : Buffer.from(rawPayload, 'hex');
    const stepTs = curOrdinal < stepRecords.length ? stepRecords[curOrdinal].ts : null;
    const isComplete = curOrdinal < stepRecords.length ? stepRecords[curOrdinal].textComplete : false;

    const wrapped = getBytesField(1, buf);
    if (!wrapped) continue;

    // Performance Sample
    if (isComplete && stepTs) {
      const usage = getBytesField(4, wrapped);
      if (usage) {
        const bodyTokens = getVarintField(10, usage);
        const firstTextSec = getDuration(getBytesField(11, wrapped));
        const streamSec = getDuration(getBytesField(12, wrapped));
        if (bodyTokens && bodyTokens >= 100 && streamSec && streamSec >= 1.0 && firstTextSec) {
          const model = getStringField(21, wrapped) || getStringField(19, wrapped);
          if (model) {
            samples.push({
              model,
              source,
              timestamp: stepTs,
              first_text_seconds: firstTextSec,
              body_tokens_per_second: bodyTokens / streamSec
            });
          }
        }
      }
    }

    if (isArchived) continue;

    // Generation Event
    const genUsage = getBytesField(4, wrapped);
    if (genUsage) {
      const sysPrompt = getVarintField(1, genUsage) || 0;
      const rawInp = getVarintField(2, genUsage) || 0;
      const outTok = getVarintField(3, genUsage) || 0;
      const cacheTok = getVarintField(5, genUsage) || 0;
      const inpTok = sysPrompt + rawInp;
      const generated = rawInp !== 0 || outTok !== 0 || cacheTok !== 0;
      const modelId = getStringField(19, wrapped);
      const label = getStringField(21, wrapped);
      if ((modelId || label || generated) && (generated || inpTok !== 0)) {
        const timing = getBytesField(9, wrapped);
        const t4 = timing ? getBytesField(4, timing) : null;
        const embTs = t4 ? getVarintField(1, t4) : null;
        const ts = (embTs && embTs > 0) ? embTs : stepTs;
        if (ts && ts > 0) {
          events.push({
            model: label || modelId || '未知模型',
            input_tokens: inpTok,
            output_tokens: outTok,
            cached_tokens: cacheTok,
            total_tokens: inpTok + cacheTok + outTok,
            timestamp_seconds: ts
          });
        }
      }
    }
  }

  return {
    stepRecords,
    events,
    samples,
    dbGenerations,
    dbSkippedLarge,
    maxGenIdx,
    maxStepIdx,
    lastStepPending
  };
}

function scanSingleConversationDb(dbPath, archivedIds, { needPerfSamples = false, cachedDb = null } = {}) {
  const parentDir = path.dirname(path.dirname(dbPath));
  const source = path.basename(parentDir) || 'antigravity';

  const archivedCount = archivedIds ? archivedIds.size : 0;
  const payloadColJs = needPerfSamples
    ? 'CASE WHEN length(step_payload) <= 1048576 THEN step_payload ELSE NULL END as p'
    : 'NULL as p';
  const payloadColCli = needPerfSamples
    ? 'CASE WHEN length(step_payload) <= 1048576 THEN hex(step_payload) ELSE NULL END as p'
    : 'NULL as p';

  if (DatabaseSync) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });

      // Incremental append-only fast path when last turn's step had already finished
      if (
        cachedDb &&
        !cachedDb.lastStepPending &&
        cachedDb.archivedCount === archivedCount &&
        cachedDb.lastGenIdx !== undefined &&
        cachedDb.lastGenIdx >= 0 &&
        (!needPerfSamples || cachedDb.hasPerfScan)
      ) {
        const genStat = db.prepare('SELECT MAX(idx) as maxIdx, COUNT(*) as cnt FROM gen_metadata WHERE data IS NOT NULL').get();
        const stepStat = db.prepare('SELECT MAX(idx) as maxIdx, COUNT(*) as cnt FROM steps WHERE step_type = 15').get();
        const curMaxIdx = genStat && genStat.maxIdx !== null ? Number(genStat.maxIdx) : -1;
        const curCnt = genStat ? Number(genStat.cnt || 0) : 0;
        const curStepMaxIdx = stepStat && stepStat.maxIdx !== null ? Number(stepStat.maxIdx) : -1;
        const curStepCnt = stepStat ? Number(stepStat.cnt || 0) : 0;
        const prevStepCount = cachedDb.stepCount ?? (cachedDb.stepRecords ? cachedDb.stepRecords.length : 0);
        const prevStepMaxIdx = cachedDb.lastStepIdx ?? -1;

        if (
          curCnt === cachedDb.genRowCount &&
          curMaxIdx === cachedDb.lastGenIdx &&
          curStepCnt === prevStepCount &&
          curStepMaxIdx === prevStepMaxIdx
        ) {
          return { ok: true, unchanged: true, entry: cachedDb };
        }

        if (
          curCnt >= cachedDb.genRowCount &&
          curMaxIdx >= cachedDb.lastGenIdx &&
          curStepCnt >= prevStepCount &&
          curStepMaxIdx >= prevStepMaxIdx
        ) {
          const incSteps = db.prepare(
            `SELECT idx, CASE WHEN length(metadata) <= 65536 THEN metadata ELSE NULL END as m, status, ${payloadColJs} FROM steps WHERE step_type = 15 AND idx > ? ORDER BY idx`
          ).all(prevStepMaxIdx);
          const incGen = db.prepare(
            'SELECT idx, data, length(data) as len FROM gen_metadata WHERE data IS NOT NULL AND idx > ? ORDER BY idx'
          ).all(cachedDb.lastGenIdx);

          const delta = parseStepsAndGenRows(incSteps, incGen, {
            useRawBlob: true,
            source,
            archivedIds,
            existingStepRecords: cachedDb.stepRecords || [],
            startOrdinal: cachedDb.genRowCount,
            existingLastStepIdx: prevStepMaxIdx,
            replaceLastStep: false
          });

          const mergedEntry = {
            sig: '',
            archivedCount,
            lastGenIdx: delta.maxGenIdx >= 0 ? delta.maxGenIdx : cachedDb.lastGenIdx,
            genRowCount: cachedDb.genRowCount + incGen.length,
            lastStepIdx: delta.maxStepIdx,
            stepCount: delta.stepRecords.length,
            lastStepPending: delta.lastStepPending,
            stepRecords: delta.stepRecords,
            events: cachedDb.events.concat(delta.events),
            samples: cachedDb.samples.concat(delta.samples),
            totalGenerations: cachedDb.totalGenerations + delta.dbGenerations,
            skippedLarge: cachedDb.skippedLarge + delta.dbSkippedLarge,
            hasPerfScan: Boolean(cachedDb.hasPerfScan || needPerfSamples)
          };
          return { ok: true, unchanged: false, entry: mergedEntry };
        }
      }

      const stepsRows = db.prepare(
        `SELECT idx, CASE WHEN length(metadata) <= 65536 THEN metadata ELSE NULL END as m, status, ${payloadColJs} FROM steps WHERE step_type = 15 ORDER BY idx`
      ).all();
      const genRows = db.prepare(
        'SELECT idx, data, length(data) as len FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx'
      ).all();

      const parsed = parseStepsAndGenRows(stepsRows, genRows, {
        useRawBlob: true,
        source,
        archivedIds
      });

      return {
        ok: true,
        unchanged: false,
        entry: {
          sig: '',
          archivedCount,
          lastGenIdx: parsed.maxGenIdx,
          genRowCount: genRows.length,
          lastStepIdx: parsed.maxStepIdx,
          stepCount: parsed.stepRecords.length,
          lastStepPending: parsed.lastStepPending,
          stepRecords: parsed.stepRecords,
          events: parsed.events,
          samples: parsed.samples,
          totalGenerations: parsed.dbGenerations,
          skippedLarge: parsed.dbSkippedLarge,
          hasPerfScan: needPerfSamples
        }
      };
    } catch (e) {
      if (e.code === 'ENOENT') throw e;
      return { ok: false };
    } finally {
      if (db) {
        try { db.close(); } catch {}
      }
    }
  }

  let stepsRows = [];
  let genRows = [];
  try {
    const stepsSql = `SELECT idx, CASE WHEN length(metadata) <= 65536 THEN hex(metadata) ELSE NULL END as m, status, ${payloadColCli} FROM steps WHERE step_type = 15 ORDER BY idx`;
    stepsRows = querySqlite(dbPath, stepsSql, 5000);
  } catch (e) {
    if (e.code === 'ENOENT') throw e;
    return { ok: false };
  }
  try {
    const genSql = 'SELECT idx, hex(data) as h, length(data) as len FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx';
    genRows = querySqlite(dbPath, genSql, 10000);
  } catch (e) {
    if (e.code === 'ENOENT') throw e;
    genRows = [];
  }

  const parsed = parseStepsAndGenRows(stepsRows, genRows, {
    useRawBlob: false,
    source,
    archivedIds
  });

  return {
    ok: true,
    unchanged: false,
    entry: {
      sig: '',
      archivedCount,
      lastGenIdx: parsed.maxGenIdx,
      genRowCount: genRows.length,
      lastStepIdx: parsed.maxStepIdx,
      stepCount: parsed.stepRecords.length,
      lastStepPending: parsed.lastStepPending,
      stepRecords: parsed.stepRecords,
      events: parsed.events,
      samples: parsed.samples,
      totalGenerations: parsed.dbGenerations,
      skippedLarge: parsed.dbSkippedLarge,
      hasPerfScan: needPerfSamples
    }
  };
}

function prepareNativeScanContext(includeOlderHistory = false) {
  loadDiskTokenIndex();
  const home = os.homedir();
  const geminiDir = path.join(home, '.gemini');
  const rawDbFiles = [];

  if (fs.existsSync(geminiDir)) {
    try {
      for (const d of fs.readdirSync(geminiDir)) {
        if (d.startsWith('antigravity')) {
          const cDir = path.join(geminiDir, d, 'conversations');
          if (fs.existsSync(cDir)) {
            for (const f of fs.readdirSync(cDir)) {
              if (f.endsWith('.db') && !f.includes('-shm') && !f.includes('-wal')) {
                rawDbFiles.push(path.join(cDir, f));
              }
            }
          }
        }
      }
    } catch {}
  }

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const now = new Date(nowMs);
  const pad = n => String(n).padStart(2, '0');
  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const pricingStateMtime = loadPricingState()?.mtimeMs || 0;
  const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEndSec = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime() / 1000);
  const d30Start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
  const start30Sec = Math.floor(d30Start.getTime() / 1000);
  const d30CutoffMs = (start30Sec - 86400) * 1000;
  const perfCutoffMs = nowMs - 8 * 24 * 3600 * 1000;
  const maxAge = 7 * 24 * 3600;

  const dbItems = [];
  const liveSourceKeys = new Set();
  const liveDbSet = new Set();

  for (const dbPath of rawDbFiles) {
    liveDbSet.add(dbPath);
    let rel = dbPath.replace(/\\/g, '/');
    const idx = rel.indexOf('/.gemini/');
    if (idx >= 0) rel = rel.substring(idx + 9);
    liveSourceKeys.add(rel.toLowerCase());
    const sigInfo = getDbFileSignatureAndMtime(dbPath);
    dbItems.push({
      dbPath,
      sourceKey: rel,
      sig: sigInfo ? sigInfo.sig : null,
      effectiveMtimeMs: sigInfo ? sigInfo.effectiveMtimeMs : 0
    });
  }

  dbItems.sort((a, b) => b.effectiveMtimeMs - a.effectiveMtimeMs);

  for (const cachedPath of dbParseCache.keys()) {
    if (!liveDbSet.has(cachedPath)) {
      dbParseCache.delete(cachedPath);
      diskIndexDirty = true;
    }
  }

  const events = [];
  const samples = [];
  const scannedSources = new Set();
  let totalGenerationsScanned = 0;
  let skippedLarge = 0;
  let unreadable = 0;

  const archivePath = path.join(geminiDir, 'antigravity', 'token_usage_archive.db');
  const archivedIdsBySourceLower = new Map();
  const archiveSig = getDbFileSignature(archivePath);
  let archiveHit = !archiveSig;

  if (archiveSig) {
    try {
      if (archiveParseCache && archiveParseCache.sig === archiveSig) {
        archiveHit = true;
      } else {
        const srcSet = new Set();
        const idsBySourceLower = new Map();
        const archEvents = [];
        let archTotalGen = 0;
        let archSkippedLarge = 0;

        let srcRows = [];
        let genRows = [];
        if (DatabaseSync) {
          const adb = new DatabaseSync(archivePath, { readOnly: true, timeout: 8000 });
          try {
            srcRows = adb.prepare('SELECT source_key FROM archived_sources').all();
            genRows = adb.prepare('SELECT source_key, generation_idx, model, input_tokens, output_tokens, cached_tokens, total_tokens, timestamp_seconds, valid, oversized FROM archived_generations ORDER BY source_key, generation_idx').all();
          } finally {
            try { adb.close(); } catch {}
          }
        } else {
          srcRows = querySqlite(archivePath, 'SELECT source_key FROM archived_sources');
          genRows = querySqlite(
            archivePath,
            'SELECT source_key, generation_idx, model, input_tokens, output_tokens, cached_tokens, total_tokens, timestamp_seconds, valid, oversized FROM archived_generations ORDER BY source_key, generation_idx'
          );
        }

        for (const r of srcRows) {
          if (r.source_key) srcSet.add(r.source_key);
        }
        for (const r of genRows) {
          const src = r.source_key || '';
          const srcLower = src.toLowerCase();
          const genIdx = Number(r.generation_idx);
          srcSet.add(src);
          if (!idsBySourceLower.has(srcLower)) idsBySourceLower.set(srcLower, new Set());
          idsBySourceLower.get(srcLower).add(genIdx);
          archTotalGen++;
          if (Number(r.valid) !== 1) {
            if (Number(r.oversized) === 1) archSkippedLarge++;
            continue;
          }
          const ts = Number(r.timestamp_seconds);
          if (ts > 0) {
            archEvents.push({
              model: r.model || '未知模型',
              input_tokens: Number(r.input_tokens || 0),
              output_tokens: Number(r.output_tokens || 0),
              cached_tokens: Number(r.cached_tokens || 0),
              total_tokens: Number(r.total_tokens || 0),
              timestamp_seconds: ts
            });
          }
        }
        archiveParseCache = {
          sig: archiveSig,
          sources: Array.from(srcSet),
          idsBySourceLower,
          events: archEvents,
          totalGenerations: archTotalGen,
          skippedLarge: archSkippedLarge
        };
      }

      for (const sKey of archiveParseCache.sources) scannedSources.add(sKey);
      for (const [k, setVal] of archiveParseCache.idsBySourceLower.entries()) {
        if (liveSourceKeys.has(k)) archivedIdsBySourceLower.set(k, setVal);
      }
      totalGenerationsScanned += archiveParseCache.totalGenerations;
      skippedLarge += archiveParseCache.skippedLarge;
      for (const ev of archiveParseCache.events) events.push(ev);
    } catch (e) {
      if (e.code === 'ENOENT') throw e;
      archiveHit = false;
    }
  } else {
    archiveParseCache = null;
  }

  return {
    dbItems,
    events,
    samples,
    scannedSources,
    archivedIdsBySourceLower,
    totalGenerationsScanned,
    skippedLarge,
    unreadable,
    nowSec,
    now,
    todayKey,
    pricingStateMtime,
    todayDate,
    todayEndSec,
    d30Start,
    start30Sec,
    d30CutoffMs,
    perfCutoffMs,
    maxAge,
    archiveSig,
    archiveHit,
    includeOlderHistory
  };
}

function finalizeNativeScanAggregation(ctx, dbSigsSummary, allDbHits) {
  const {
    events,
    samples,
    scannedSources,
    totalGenerationsScanned,
    skippedLarge,
    unreadable,
    nowSec,
    now,
    todayKey,
    pricingStateMtime,
    todayDate,
    todayEndSec,
    d30Start,
    start30Sec,
    maxAge,
    archiveSig,
    archiveHit,
    includeOlderHistory
  } = ctx;

  const globalSig = `${todayKey}||${pricingStateMtime}||${includeOlderHistory ? 'all' : '30d'}||${archiveSig || ''}||${dbSigsSummary.join(';')}`;
  if (allDbHits && archiveHit && lastNativeScanSnapshot && lastNativeScanSnapshot.sig === globalSig) {
    return lastNativeScanSnapshot.result;
  }

  // Summarize Performance Samples
  const recentSamples = samples.filter(s => s.timestamp >= nowSec - maxAge && s.timestamp <= nowSec);
  recentSamples.sort((a, b) => b.timestamp - a.timestamp);
  const sampleLimit = Math.min(10, recentSamples.length);
  const recent = recentSamples.slice(0, sampleLimit);

  let perfJson = null;
  if (recent.length > 0) {
    const ttfts = recent.map(s => s.first_text_seconds).sort((a, b) => a - b);
    const speeds = recent.map(s => s.body_tokens_per_second).sort((a, b) => a - b);
    const modelsSet = new Set(recent.map(s => s.model));
    const sourcesSet = new Set(recent.map(s => s.source));

    const medTtft = ttfts.length % 2 === 0
      ? (ttfts[ttfts.length / 2 - 1] + ttfts[ttfts.length / 2]) / 2
      : ttfts[Math.floor(ttfts.length / 2)];
    const medSpeed = speeds.length % 2 === 0
      ? (speeds[speeds.length / 2 - 1] + speeds[speeds.length / 2]) / 2
      : speeds[Math.floor(speeds.length / 2)];

    perfJson = {
      model_count: modelsSet.size,
      source_count: sourcesSet.size,
      sample_count: recent.length,
      first_text_seconds: Number(medTtft.toFixed(7)),
      body_tokens_per_second: Number(medSpeed.toFixed(7)),
      last_activity: recent[0].timestamp
    };
  }

  // Aggregate Token Totals
  events.sort((a, b) => a.timestamp_seconds - b.timestamp_seconds);

  const createTotals = () => ({ input_tokens: 0, output_tokens: 0, cached_tokens: 0, total_tokens: 0, request_count: 0, cost: 0 });
  const addEvent = (t, e, evCost) => {
    t.input_tokens += e.input_tokens;
    t.output_tokens += e.output_tokens;
    t.cached_tokens += e.cached_tokens;
    t.total_tokens += e.total_tokens;
    t.request_count += 1;
    t.cost += evCost;
  };

  const todayTot = createTotals();
  const yestTot = createTotals();
  const d3Tot = createTotals();
  const d7Tot = createTotals();
  const d30Tot = createTotals();

  const pad = n => String(n).padStart(2, '0');
  const yestDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const d3Start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
  const d7Start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const yestTimeMs = yestDate.getTime();
  const todayTimeMs = todayDate.getTime();

  const dailyMap = new Map();
  const hourlyMap = new Map();
  const byModelToday = new Map();
  const byModelYesterday = new Map();
  const byModel3Days = new Map();
  const byModel7Days = new Map();
  const byModel30Days = new Map();

  let lastAct = 0;

  for (const e of events) {
    if (e.timestamp_seconds < start30Sec || e.timestamp_seconds > todayEndSec) continue;

    const dt = new Date(e.timestamp_seconds * 1000);
    const eventDate = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
    if (eventDate < d30Start || eventDate > todayDate) continue;

    const dateStr = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
    const hourStr = `${dateStr} ${pad(dt.getHours())}:00`;
    const eventTimeMs = eventDate.getTime();

    const pricing = getModelPricing(e.model);
    const evCost = pricing
      ? (e.input_tokens / 1e6 * pricing.input) +
        (e.cached_tokens / 1e6 * pricing.cached) +
        (e.output_tokens / 1e6 * pricing.output)
      : 0;

    addEvent(d30Tot, e, evCost);

    if (!dailyMap.has(dateStr)) dailyMap.set(dateStr, createTotals());
    addEvent(dailyMap.get(dateStr), e, evCost);

    if (!hourlyMap.has(hourStr)) hourlyMap.set(hourStr, createTotals());
    addEvent(hourlyMap.get(hourStr), e, evCost);

    if (!byModel30Days.has(e.model)) byModel30Days.set(e.model, createTotals());
    addEvent(byModel30Days.get(e.model), e, evCost);

    if (eventTimeMs === todayTimeMs) {
      addEvent(todayTot, e, evCost);
      if (!byModelToday.has(e.model)) byModelToday.set(e.model, createTotals());
      addEvent(byModelToday.get(e.model), e, evCost);
    }

    if (eventTimeMs === yestTimeMs) {
      addEvent(yestTot, e, evCost);
      if (!byModelYesterday.has(e.model)) byModelYesterday.set(e.model, createTotals());
      addEvent(byModelYesterday.get(e.model), e, evCost);
    }

    if (eventDate >= d3Start && eventDate <= todayDate) {
      addEvent(d3Tot, e, evCost);
      if (!byModel3Days.has(e.model)) byModel3Days.set(e.model, createTotals());
      addEvent(byModel3Days.get(e.model), e, evCost);
    }

    if (eventDate >= d7Start && eventDate <= todayDate) {
      addEvent(d7Tot, e, evCost);
      if (!byModel7Days.has(e.model)) byModel7Days.set(e.model, createTotals());
      addEvent(byModel7Days.get(e.model), e, evCost);
    }

    if (e.timestamp_seconds > lastAct) lastAct = e.timestamp_seconds;
  }

  const mapToModels = (map) => {
    return Array.from(map.entries())
      .map(([model, t]) => ({ model, ...t }))
      .sort((a, b) => b.total_tokens - a.total_tokens);
  };

  const dailyList = Array.from(dailyMap.entries())
    .map(([date, t]) => ({ date, ...t }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const hourlyList = Array.from(hourlyMap.entries())
    .map(([hour, t]) => ({ hour, ...t }))
    .sort((a, b) => a.hour.localeCompare(b.hour));

  const result = {
    recent_performance: perfJson,
    all_events: events,
    today: todayTot,
    yesterday: yestTot,
    last_3_days: d3Tot,
    last_7_days: d7Tot,
    last_30_days: d30Tot,
    daily: dailyList,
    hourly: hourlyList,
    by_model_today: mapToModels(byModelToday),
    by_model_yesterday: mapToModels(byModelYesterday),
    by_model_3_days: mapToModels(byModel3Days),
    by_model_7_days: mapToModels(byModel7Days),
    by_model: mapToModels(byModel30Days),
    databases_scanned: scannedSources.size,
    generations_scanned: totalGenerationsScanned,
    skipped_large_records: skippedLarge,
    unreadable_databases: unreadable,
    last_activity: lastAct > 0 ? lastAct : null,
    generated_at: nowSec
  };

  lastNativeScanSnapshot = { sig: globalSig, result };
  if (includeOlderHistory) scannedFullHistory = true;
  if (!allDbHits || diskIndexDirty) {
    scheduleSaveDiskTokenIndex();
  }
  return result;
}

function processSingleDbItem(item, ctx, perfState) {
  const { dbPath, sourceKey, sig: dbSig, effectiveMtimeMs } = item;
  if (!ctx.includeOlderHistory && effectiveMtimeMs > 0 && effectiveMtimeMs < ctx.d30CutoffMs && !dbParseCache.has(dbPath)) {
    return { scannedFromDisk: false, dbHit: true, sigEntry: null };
  }

  ctx.scannedSources.add(sourceKey);
  const archivedIds = ctx.archivedIdsBySourceLower.get(sourceKey.toLowerCase()) || null;
  const archivedCount = archivedIds ? archivedIds.size : 0;
  const cachedDb = dbSig ? dbParseCache.get(dbPath) : null;

  if (cachedDb && cachedDb.sig === dbSig && cachedDb.archivedCount === archivedCount) {
    ctx.totalGenerationsScanned += cachedDb.totalGenerations;
    ctx.skippedLarge += cachedDb.skippedLarge;
    for (const ev of cachedDb.events) ctx.events.push(ev);
    for (const sm of cachedDb.samples) {
      ctx.samples.push(sm);
      if (sm.timestamp >= ctx.nowSec - ctx.maxAge && sm.timestamp <= ctx.nowSec) {
        perfState.recentSampleCount++;
      }
    }
    return { scannedFromDisk: false, dbHit: true, sigEntry: `${dbPath}|${dbSig || ''}|${archivedCount}` };
  }

  const isWithinPerfWindow = effectiveMtimeMs === 0 || effectiveMtimeMs >= ctx.perfCutoffMs;
  const needPerfSamples = isWithinPerfWindow && perfState.recentSampleCount < 24;
  const scanRes = scanSingleConversationDb(dbPath, archivedIds, { needPerfSamples, cachedDb });

  if (!scanRes.ok) {
    ctx.unreadable++;
    return { scannedFromDisk: true, dbHit: false, sigEntry: `${dbPath}|${dbSig || ''}|${archivedCount}` };
  }

  const entry = scanRes.entry;
  const prevSig = cachedDb?.sig || '';
  const postDbSig = getDbFileSignature(dbPath) || dbSig || '';

  if (!scanRes.unchanged && postDbSig) {
    entry.sig = postDbSig;
    dbParseCache.set(dbPath, entry);
    diskIndexDirty = true;
  } else if (scanRes.unchanged && postDbSig && postDbSig !== prevSig) {
    dbParseCache.set(dbPath, { ...entry, sig: postDbSig });
    diskIndexDirty = true;
  }

  ctx.totalGenerationsScanned += entry.totalGenerations;
  ctx.skippedLarge += entry.skippedLarge;
  for (const ev of entry.events) ctx.events.push(ev);
  for (const sm of entry.samples) {
    ctx.samples.push(sm);
    if (sm.timestamp >= ctx.nowSec - ctx.maxAge && sm.timestamp <= ctx.nowSec) {
      perfState.recentSampleCount++;
    }
  }

  return {
    scannedFromDisk: !scanRes.unchanged,
    dbHit: Boolean(scanRes.unchanged),
    sigEntry: `${dbPath}|${postDbSig || ''}|${archivedCount}`
  };
}

/**
 * Cross-platform Pure JavaScript Native Antigravity SQLite & Protobuf scanner.
 * Supports persistent incremental disk indexing and 7-day step_payload pruning.
 * @param {{ includeOlderHistory?: boolean }} [options]
 * @returns {object}
 */
export function scanNativeStatsJs({ includeOlderHistory = false } = {}) {
  const ctx = prepareNativeScanContext(includeOlderHistory);
  const dbSigsSummary = [];
  const perfState = { recentSampleCount: 0 };
  let allDbHits = true;

  for (const item of ctx.dbItems) {
    const step = processSingleDbItem(item, ctx, perfState);
    if (!step.dbHit) allDbHits = false;
    if (step.sigEntry) dbSigsSummary.push(step.sigEntry);
  }

  return finalizeNativeScanAggregation(ctx, dbSigsSummary, allDbHits);
}

/**
 * Non-blocking chunked async variant of scanNativeStatsJs that yields to the event loop
 * every few SQLite files so live context/quota endpoints stay responsive.
 * @param {{ includeOlderHistory?: boolean }} [options]
 * @returns {Promise<object>}
 */
export async function scanNativeStatsJsAsync({ includeOlderHistory = false } = {}) {
  const ctx = prepareNativeScanContext(includeOlderHistory);
  const dbSigsSummary = [];
  const perfState = { recentSampleCount: 0 };
  let allDbHits = true;
  let diskScansInChunk = 0;

  for (const item of ctx.dbItems) {
    const step = processSingleDbItem(item, ctx, perfState);
    if (!step.dbHit) allDbHits = false;
    if (step.sigEntry) dbSigsSummary.push(step.sigEntry);
    if (step.scannedFromDisk) {
      diskScansInChunk++;
      if (diskScansInChunk >= 4) {
        diskScansInChunk = 0;
        await new Promise(resolve => setImmediate(resolve));
      }
    }
  }

  return finalizeNativeScanAggregation(ctx, dbSigsSummary, allDbHits);
}

/**
 * Fallback scanner for Windows using PowerShell & winsqlite3.dll
 * @returns {object|null}
 */
export function scanNativeStatsPs1() {
  const home = os.homedir();
  const candidates = [
    path.join(__dirname, 'native-token-scanner.ps1'),
    path.join(__dirname, 'scripts', 'native-token-scanner.ps1'),
    path.resolve(__dirname, '..', 'scripts', 'native-token-scanner.ps1'),
    path.join(home, '.gemini', 'config', 'plugins', 'agy-context', 'scripts', 'native-token-scanner.ps1'),
    path.join(home, '.gemini', 'config', 'plugins', 'agy-context', 'sidecars', 'context-panel', 'scripts', 'native-token-scanner.ps1')
  ];

  let scriptPath = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      scriptPath = c;
      break;
    }
  }

  if (!scriptPath) return null;

  try {
    const stdout = cp.execFileSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath
    ], {
      encoding: 'utf8',
      maxBuffer: 30 * 1024 * 1024,
      timeout: 10000,
      windowsHide: true
    });
    return JSON.parse(stdout.trim());
  } catch (err) {
    console.error('[agy-context] PowerShell token scan error:', err.message);
    return null;
  }
}

function getTodayKey(nowMs = Date.now()) {
  const nowDate = new Date(nowMs);
  const pad = n => String(n).padStart(2, '0');
  return `${nowDate.getFullYear()}-${pad(nowDate.getMonth() + 1)}-${pad(nowDate.getDate())}`;
}

/**
 * Runs the native Antigravity token scanner synchronously across all platforms.
 * @param {boolean} [force=false]
 * @param {{ includeOlderHistory?: boolean }} [options]
 * @returns {object|null}
 */
export function runNativeStatsScan(force = false, { includeOlderHistory = false } = {}) {
  const now = Date.now();
  const todayKey = getTodayKey(now);
  const hasNeededHistory = !includeOlderHistory || lastNativeIncludesOlder || scannedFullHistory;
  if (!force && cachedNativeStats && hasNeededHistory && (now - lastNativeScanMs < 60000) && lastNativeScanDateKey === todayKey) {
    return cachedNativeStats;
  }

  try {
    let result = null;
    try {
      result = scanNativeStatsJs({ includeOlderHistory });
    } catch (e) {
      if (process.platform === 'win32') {
        result = scanNativeStatsPs1();
      } else {
        throw e;
      }
    }

    if (process.platform === 'win32' && (!result || (result.databases_scanned > 0 && result.generations_scanned === 0 && result.unreadable_databases === result.databases_scanned))) {
      const psResult = scanNativeStatsPs1();
      if (psResult) {
        result = psResult;
      }
    }

    if (result) {
      cachedNativeStats = result;
      lastNativeScanMs = Date.now();
      lastNativeScanDateKey = todayKey;
      lastNativeIncludesOlder = Boolean(includeOlderHistory || scannedFullHistory);
      return result;
    }
  } catch (err) {
    console.error('[agy-context] Native token scan error:', err.message);
  }

  return cachedNativeStats;
}

async function executeNativeStatsScanAsync({ includeOlderHistory = false, scanSeq = 0 } = {}) {
  let result = null;
  try {
    result = await scanNativeStatsJsAsync({ includeOlderHistory });
  } catch (e) {
    if (process.platform === 'win32') {
      result = scanNativeStatsPs1();
    } else {
      throw e;
    }
  }

  if (process.platform === 'win32' && (!result || (result.databases_scanned > 0 && result.generations_scanned === 0 && result.unreadable_databases === result.databases_scanned))) {
    const psResult = scanNativeStatsPs1();
    if (psResult) {
      result = psResult;
    }
  }

  if (result) {
    const resolvedFull = Boolean(includeOlderHistory || scannedFullHistory);
    const wouldDowngradeHistory = Boolean(
      lastNativeIncludesOlder &&
      !resolvedFull &&
      lastNativeScanDateKey === getTodayKey(Date.now())
    );
    if (scanSeq >= committedNativeScanSeq && !wouldDowngradeHistory) {
      committedNativeScanSeq = scanSeq;
      cachedNativeStats = result;
      lastNativeScanMs = Date.now();
      lastNativeScanDateKey = getTodayKey(lastNativeScanMs);
      lastNativeIncludesOlder = resolvedFull;
    }
  }
  return result || cachedNativeStats;
}

function startSharedNativeScan(includeOlderHistory) {
  const effectiveOlder = Boolean(includeOlderHistory || scannedFullHistory);
  const scanSeq = ++activeNativeScanSeq;
  const work = executeNativeStatsScanAsync({ includeOlderHistory: effectiveOlder, scanSeq });
  inFlightNativeScanPromise = work;
  inFlightIncludesOlder = effectiveOlder;
  work.finally(() => {
    if (inFlightNativeScanPromise === work) {
      inFlightNativeScanPromise = null;
      inFlightIncludesOlder = false;
    }
  });
  return work;
}

/**
 * Non-blocking async token scanner with concurrent request deduplication and
 * Stale-While-Revalidate (SWR) background refresh after 60s TTL.
 * @param {{ force?: boolean, includeOlderHistory?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
export async function runNativeStatsScanAsync({ force = false, includeOlderHistory = false } = {}) {
  const now = Date.now();
  const todayKey = getTodayKey(now);
  const hasNeededHistory = !includeOlderHistory || lastNativeIncludesOlder || scannedFullHistory;

  if (!force && cachedNativeStats && hasNeededHistory && lastNativeScanDateKey === todayKey) {
    if (now - lastNativeScanMs < 60000) {
      return cachedNativeStats;
    }
    if (!inFlightNativeScanPromise) {
      startSharedNativeScan(includeOlderHistory || lastNativeIncludesOlder).catch((err) => {
        console.warn('[agy-context] Background SWR token scan failed:', err.message);
      });
    }
    return cachedNativeStats;
  }

  if (!force && inFlightNativeScanPromise && (!includeOlderHistory || inFlightIncludesOlder)) {
    return inFlightNativeScanPromise;
  }

  try {
    return await startSharedNativeScan(includeOlderHistory);
  } catch (err) {
    console.error('[agy-context] Async native token scan error:', err.message);
    return cachedNativeStats;
  }
}

/**
 * Warms up the token index cache in the background on sidecar startup.
 */
export async function warmupGlobalTokenIndex() {
  if (cachedNativeStats || inFlightNativeScanPromise) return cachedNativeStats;
  return runNativeStatsScanAsync({ force: false, includeOlderHistory: false });
}

/**
 * Returns cached 7-day token summary without triggering any new SQLite scan.
 */
export function getCachedWeeklyTokenSummary() {
  if (!cachedNativeStats || !cachedNativeStats.last_7_days) return null;
  const d7 = cachedNativeStats.last_7_days;
  return {
    totalTokens: Number(d7.total_tokens || 0),
    compactTotal: formatCompactNumber(Number(d7.total_tokens || 0)),
    cost: Number(d7.cost || 0),
    requests: Number(d7.request_count || 0)
  };
}

/**
 * Aggregates local Token metrics across Antigravity records by date range.
 * 100% Native Antigravity SQLite & Protobuf scanning (q1u native, zero external dependencies).
 * @param {string} [range='today'] 'today' | 'yesterday' | '3d' | '7d' | '30d'
 * @returns {object} Aggregated local token usage data
 */
function parseYmdDate(str) {
  if (typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== (mo - 1) || dt.getDate() !== d) return null;
  return dt;
}

function resolveIncludeOlderHistory(range, options) {
  if (range !== 'custom') return false;
  const sDt = parseYmdDate(options.start);
  if (!sDt) return false;
  const now = new Date();
  const d30Start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
  return sDt < d30Start;
}

export function analyzeGlobalTokens(range = 'today', options = {}) {
  const validRanges = new Set(['today', 'yesterday', '3d', '7d', '30d', 'custom']);
  if (!validRanges.has(range)) range = 'today';

  const includeOlderHistory = resolveIncludeOlderHistory(range, options);
  const raw = runNativeStatsScan(Boolean(options.force), { includeOlderHistory }) || {};
  return buildGlobalTokensResponse(raw, range, options);
}

/**
 * Non-blocking async variant of analyzeGlobalTokens used by the Sidecar HTTP server.
 * @param {string} [range='today']
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function analyzeGlobalTokensAsync(range = 'today', options = {}) {
  const validRanges = new Set(['today', 'yesterday', '3d', '7d', '30d', 'custom']);
  if (!validRanges.has(range)) range = 'today';

  const includeOlderHistory = resolveIncludeOlderHistory(range, options);
  const raw = (await runNativeStatsScanAsync({ force: Boolean(options.force), includeOlderHistory })) || {};
  return buildGlobalTokensResponse(raw, range, options);
}

function buildGlobalTokensResponse(raw, range = 'today', options = {}) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayDateObj = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayStr = fmtDate(todayDateObj);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterdayStr = fmtDate(yesterday);

  let startDateStr = todayStr;
  let endDateStr = todayStr;
  let customHourlyMap = null;
  let customDailyMap = null;

  let rangeLabel = '今天';
  let targetTotals = raw.today || { input_tokens: 0, output_tokens: 0, cached_tokens: 0, total_tokens: 0, request_count: 0 };
  let targetModels = raw.by_model_today || [];

  if (range === 'today') {
    rangeLabel = '今天';
    targetTotals = raw.today || targetTotals;
    targetModels = raw.by_model_today || [];
  } else if (range === 'yesterday') {
    rangeLabel = '昨天';
    startDateStr = yesterdayStr;
    endDateStr = yesterdayStr;
    targetTotals = raw.yesterday || targetTotals;
    targetModels = raw.by_model_yesterday || [];
  } else if (range === '3d') {
    rangeLabel = '近 3 天';
    startDateStr = fmtDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2));
    targetTotals = raw.last_3_days || targetTotals;
    targetModels = raw.by_model_3_days || [];
  } else if (range === '7d') {
    rangeLabel = '近 7 天';
    startDateStr = fmtDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
    targetTotals = raw.last_7_days || targetTotals;
    targetModels = raw.by_model_7_days || [];
  } else if (range === '30d') {
    rangeLabel = '近 30 天';
    startDateStr = fmtDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29));
    targetTotals = raw.last_30_days || targetTotals;
    targetModels = raw.by_model || [];
  } else if (range === 'custom') {
    let sDt = parseYmdDate(options.start);
    let eDt = parseYmdDate(options.end);
    if (!eDt) eDt = todayDateObj;
    if (!sDt) sDt = new Date(eDt.getFullYear(), eDt.getMonth(), eDt.getDate() - 6);
    if (sDt > eDt) [sDt, eDt] = [eDt, sDt];
    const spanDays = Math.round((eDt - sDt) / 86400000) + 1;
    if (spanDays > 366) {
      sDt = new Date(eDt.getFullYear(), eDt.getMonth(), eDt.getDate() - 365);
    }
    startDateStr = fmtDate(sDt);
    endDateStr = fmtDate(eDt);
    rangeLabel = startDateStr === endDateStr ? startDateStr : `${startDateStr} ~ ${endDateStr}`;

    const mkTotals = () => ({ input_tokens: 0, output_tokens: 0, cached_tokens: 0, total_tokens: 0, request_count: 0, cost: 0 });
    const cTot = mkTotals();
    const cModels = new Map();
    customHourlyMap = {};
    customDailyMap = new Map();

    if (Array.isArray(raw.all_events)) {
      const startSec = Math.floor(sDt.getTime() / 1000);
      const endSec = Math.floor(new Date(eDt.getFullYear(), eDt.getMonth(), eDt.getDate(), 23, 59, 59, 999).getTime() / 1000);
      for (const e of raw.all_events) {
        if (e.timestamp_seconds < startSec || e.timestamp_seconds > endSec) continue;
        const dt = new Date(e.timestamp_seconds * 1000);
        const dateStr = fmtDate(dt);
        if (dateStr < startDateStr || dateStr > endDateStr) continue;

        const pricing = getModelPricing(e.model);
        const evCost = pricing
          ? (e.input_tokens / 1e6 * pricing.input) + (e.cached_tokens / 1e6 * pricing.cached) + (e.output_tokens / 1e6 * pricing.output)
          : 0;

        const acc = (t) => {
          t.input_tokens += e.input_tokens;
          t.output_tokens += e.output_tokens;
          t.cached_tokens += e.cached_tokens;
          t.total_tokens += e.total_tokens;
          t.request_count += 1;
          t.cost += evCost;
        };
        acc(cTot);
        if (!cModels.has(e.model)) cModels.set(e.model, mkTotals());
        acc(cModels.get(e.model));

        if (!customDailyMap.has(dateStr)) customDailyMap.set(dateStr, mkTotals());
        acc(customDailyMap.get(dateStr));

        if (startDateStr === endDateStr) {
          const hhKey = pad(dt.getHours()) + ':00';
          if (!customHourlyMap[hhKey]) customHourlyMap[hhKey] = mkTotals();
          acc(customHourlyMap[hhKey]);
        }
      }
      targetTotals = cTot;
      targetModels = Array.from(cModels.entries())
        .map(([model, t]) => ({ model, ...t }))
        .sort((a, b) => b.total_tokens - a.total_tokens);
    } else {
      for (const d of (raw.daily || [])) {
        if (!d || !d.date || d.date < startDateStr || d.date > endDateStr) continue;
        cTot.input_tokens += Number(d.input_tokens || 0);
        cTot.output_tokens += Number(d.output_tokens || 0);
        cTot.cached_tokens += Number(d.cached_tokens || 0);
        cTot.total_tokens += Number(d.total_tokens || 0);
        cTot.request_count += Number(d.request_count || 0);
        cTot.cost += Number(d.cost || 0);
        customDailyMap.set(d.date, d);
      }
      if (startDateStr === endDateStr) {
        for (const h of (raw.hourly || [])) {
          if (h.hour && h.hour.startsWith(startDateStr)) {
            customHourlyMap[h.hour.split(' ')[1] || ''] = h;
          }
        }
      }
      targetTotals = cTot;
      targetModels = [];
    }
  }

  const totalInput = Number(targetTotals.input_tokens || 0);
  const totalOutput = Number(targetTotals.output_tokens || 0);
  const totalCache = Number(targetTotals.cached_tokens || 0);
  const totalTokens = Number(targetTotals.total_tokens || (totalInput + totalOutput + totalCache));
  const totalRequests = Number(targetTotals.request_count || 0);

  // Model pricing & items
  let totalCost = 0;
  let unpricedCount = 0;
  const modelList = targetModels.map(m => {
    const rawTot = Number(m.total_tokens || 0);
    const inp = Number(m.input_tokens || 0);
    const out = Number(m.output_tokens || 0);
    const cch = Number(m.cached_tokens || 0);
    const req = Number(m.request_count || 0);

    const pricing = getModelPricing(m.model);
    let cost = 0;
    const isPriced = pricing !== null;
    if (isPriced) {
      cost = (inp / 1e6 * pricing.input) + (cch / 1e6 * pricing.cached) + (out / 1e6 * pricing.output);
      totalCost += cost;
    } else {
      unpricedCount++;
    }

    return {
      model: m.model,
      isPriced,
      cost: '$' + cost.toFixed(2),
      rawCost: Number(cost.toFixed(2)),
      total: rawTot.toLocaleString(),
      compactTotal: formatCompactNumber(rawTot),
      rawTotal: rawTot,
      input: inp.toLocaleString(),
      output: out.toLocaleString(),
      cache: cch.toLocaleString(),
      requests: req
    };
  }).sort((a, b) => b.rawTotal - a.rawTotal);

  modelList.forEach(m => {
    m.percent = totalCost > 0 && m.isPriced ? ((m.rawCost / totalCost) * 100).toFixed(1) + '%' : (m.isPriced ? '100.0%' : '0.0%');
  });

  const cacheHitRatio = (totalInput + totalCache > 0)
    ? Number(((totalCache / (totalInput + totalCache)) * 100).toFixed(1))
    : 0;
  const avgInputTokens = totalRequests ? Math.round((totalInput + totalCache) / totalRequests) : 0;

  // Chart buckets
  const isHourly = (range === 'today' || range === 'yesterday' || (range === 'custom' && startDateStr === endDateStr));
  const buckets = [];
  let xLabels = [];
  let defaultActiveIndex = 0;
  let granularity = isHourly ? 'hourly' : 'daily';

  const appendBucket = (labelTime, bucketStats, rawIdx, state) => {
    const bTot = Number(bucketStats.total_tokens || 0);
    const bInp = Number(bucketStats.input_tokens || 0);
    const bOut = Number(bucketStats.output_tokens || 0);
    const bCch = Number(bucketStats.cached_tokens || 0);
    const bReq = Number(bucketStats.request_count || 0);
    const cost = Number(bucketStats.cost || 0);

    buckets.push({
      time: labelTime,
      rawTotal: bTot,
      compactTotal: formatCompactNumber(bTot),
      fullTotal: bTot.toLocaleString() + ' Token',
      inputCompact: formatCompactNumber(bInp),
      rawInput: bInp,
      outputCompact: formatCompactNumber(bOut),
      rawOutput: bOut,
      cacheCompact: formatCompactNumber(bCch),
      rawCache: bCch,
      requests: bReq,
      cost: '$' + cost.toFixed(2),
      rawCost: Number(cost.toFixed(2))
    });
    if (bTot > 0) state.latestActiveIndex = rawIdx;
  };

  if (isHourly) {
    xLabels = ['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00', '23:00'];
    const targetDate = range === 'today' ? todayStr : (range === 'yesterday' ? yesterdayStr : startDateStr);
    let hourlyMap = customHourlyMap;
    if (!hourlyMap) {
      hourlyMap = {};
      for (const h of (raw.hourly || [])) {
        if (h.hour.startsWith(targetDate)) {
          const hh = h.hour.split(' ')[1] || '';
          hourlyMap[hh] = h;
        }
      }
    }

    const hourState = { latestActiveIndex: 0 };
    for (let h = 0; h < 24; h++) {
      const hh = String(h).padStart(2, '0') + ':00';
      const b = hourlyMap[hh] || { total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, request_count: 0 };
      appendBucket(hh, b, h, hourState);
    }
    defaultActiveIndex = hourState.latestActiveIndex;
  } else {
    // Daily range: always generate the exact calendar day window, then downsample cleanly on long spans
    const dailyByDate = customDailyMap || new Map();
    if (!customDailyMap) {
      for (const d of (raw.daily || [])) {
        if (d && d.date) dailyByDate.set(d.date, d);
      }
    }
    const filteredDaily = [];
    if (range === 'custom') {
      const sDt = parseYmdDate(startDateStr) || todayDateObj;
      const eDt = parseYmdDate(endDateStr) || todayDateObj;
      for (let dt = new Date(sDt); dt <= eDt; dt = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + 1)) {
        const dateStr = fmtDate(dt);
        filteredDaily.push({ date: dateStr, ...(dailyByDate.get(dateStr) || {}) });
      }
    } else {
      const totalDays = range === '3d' ? 3 : (range === '7d' ? 7 : 30);
      for (let offset = totalDays - 1; offset >= 0; offset--) {
        const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
        const dateStr = fmtDate(dt);
        filteredDaily.push({ date: dateStr, ...(dailyByDate.get(dateStr) || {}) });
      }
    }

    const bucketState = { latestActiveIndex: -1 };
    const totalDays = filteredDaily.length;

    if (totalDays <= 31) {
      granularity = 'daily';
      filteredDaily.forEach((d, idx) => {
        xLabels.push(d.date.slice(5)); // MM-DD
        appendBucket(d.date, d, idx, bucketState);
      });
    } else if (totalDays <= 180) {
      granularity = 'weekly';
      const crossYear = startDateStr.slice(0, 4) !== endDateStr.slice(0, 4);
      const weeksMap = new Map();
      for (const d of filteredDaily) {
        const dt = parseYmdDate(d.date);
        const offsetFromMon = (dt.getDay() + 6) % 7;
        const monDt = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - offsetFromMon);
        const weekKey = fmtDate(monDt);
        if (!weeksMap.has(weekKey)) {
          weeksMap.set(weekKey, {
            startDate: d.date,
            endDate: d.date,
            total_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            request_count: 0,
            cost: 0
          });
        }
        const grp = weeksMap.get(weekKey);
        if (d.date < grp.startDate) grp.startDate = d.date;
        if (d.date > grp.endDate) grp.endDate = d.date;
        grp.total_tokens += Number(d.total_tokens || 0);
        grp.input_tokens += Number(d.input_tokens || 0);
        grp.output_tokens += Number(d.output_tokens || 0);
        grp.cached_tokens += Number(d.cached_tokens || 0);
        grp.request_count += Number(d.request_count || 0);
        grp.cost += Number(d.cost || 0);
      }

      Array.from(weeksMap.values()).forEach((grp, idx) => {
        const sameDay = grp.startDate === grp.endDate;
        const endPart = (grp.startDate.slice(0, 4) === grp.endDate.slice(0, 4))
          ? grp.endDate.slice(5)
          : grp.endDate;
        const labelTime = sameDay ? grp.startDate : `${grp.startDate} ~ ${endPart}`;
        xLabels.push(crossYear ? grp.startDate.slice(2, 7) : grp.startDate.slice(5));
        appendBucket(labelTime, grp, idx, bucketState);
      });
    } else {
      granularity = 'monthly';
      const crossYear = startDateStr.slice(0, 4) !== endDateStr.slice(0, 4);
      const distinctMonths = new Set(filteredDaily.map(d => d.date.slice(0, 7)));
      const useQuarter = distinctMonths.size > 36;
      const periodMap = new Map();

      for (const d of filteredDaily) {
        let pKey = d.date.slice(0, 7); // YYYY-MM
        if (useQuarter) {
          const monthNum = Number(d.date.slice(5, 7)) || 1;
          const quarter = Math.ceil(monthNum / 3);
          pKey = `${d.date.slice(0, 4)}-Q${quarter}`;
        }
        if (!periodMap.has(pKey)) {
          periodMap.set(pKey, {
            key: pKey,
            total_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            request_count: 0,
            cost: 0
          });
        }
        const grp = periodMap.get(pKey);
        grp.total_tokens += Number(d.total_tokens || 0);
        grp.input_tokens += Number(d.input_tokens || 0);
        grp.output_tokens += Number(d.output_tokens || 0);
        grp.cached_tokens += Number(d.cached_tokens || 0);
        grp.request_count += Number(d.request_count || 0);
        grp.cost += Number(d.cost || 0);
      }

      Array.from(periodMap.values()).forEach((grp, idx) => {
        let shortTick = grp.key;
        if (!useQuarter) {
          shortTick = crossYear ? `${grp.key.slice(2, 4)}/${grp.key.slice(5, 7)}` : `${Number(grp.key.slice(5, 7))}月`;
        }
        xLabels.push(shortTick);
        appendBucket(grp.key, grp, idx, bucketState);
      });
    }

    defaultActiveIndex = bucketState.latestActiveIndex >= 0
      ? bucketState.latestActiveIndex
      : Math.max(0, buckets.length - 1);
  }

  const perf = raw.recent_performance;
  const hasPerf = perf && typeof perf.first_text_seconds === 'number';

  let latestRecordStr = '--';
  if (raw.last_activity) {
    const actDate = new Date(raw.last_activity * 1000);
    latestRecordStr = actDate.toTimeString().split(' ')[0];
  }

  return {
    range,
    rangeLabel,
    startDate: startDateStr,
    endDate: endDateStr,
    scanTime: now.toTimeString().split(' ')[0],
    latestRecordTime: latestRecordStr,
    totalTokens: {
      compact: formatCompactNumber(totalTokens),
      full: totalTokens.toLocaleString() + ' Token',
      raw: totalTokens
    },
    inputTokens: {
      compact: formatCompactNumber(totalInput),
      full: totalInput.toLocaleString() + ' Token',
      raw: totalInput
    },
    outputTokens: {
      compact: formatCompactNumber(totalOutput),
      full: totalOutput.toLocaleString() + ' Token',
      raw: totalOutput
    },
    cacheHitRatio: {
      percent: cacheHitRatio + '%',
      sub: '输入缓存占比',
      raw: cacheHitRatio
    },
    costEstimate: {
      formatted: `$${totalCost.toFixed(2)}`,
      requests: `${totalRequests} 次请求`,
      raw: totalCost
    },
    ttft: {
      value: hasPerf ? perf.first_text_seconds.toFixed(2) : '--',
      sub: hasPerf ? `最近 ${perf.sample_count} 次回复的中位数` : '暂无交互采样',
      raw: hasPerf ? perf.first_text_seconds : 0
    },
    speed: {
      value: hasPerf ? perf.body_tokens_per_second.toFixed(1) : '--',
      sub: hasPerf ? `最近 ${perf.sample_count} 次回复的中位数` : '暂无交互采样',
      raw: hasPerf ? perf.body_tokens_per_second : 0
    },
    avgInput: {
      formatted: formatCompactNumber(avgInputTokens),
      sub: `${totalRequests} 次请求，含缓存输入`,
      raw: avgInputTokens
    },
    modelCount: modelList.length,
    unpricedCount,
    models: modelList,
    chart: {
      type: isHourly ? 'hourly' : 'daily',
      granularity,
      xLabels,
      buckets,
      defaultActiveIndex
    },
    daily: (raw.daily || []).map(d => ({
      date: d.date,
      requests: d.request_count,
      input: formatCompactNumber(d.input_tokens),
      cache: formatCompactNumber(d.cached_tokens),
      output: formatCompactNumber(d.output_tokens),
      total: formatCompactNumber(d.total_tokens),
      rawTotal: d.total_tokens
    }))
  };
}

// In-memory cache for Language Server auth to prevent process/network spamming
let cachedLsAuth = null;

/**
 * Resolves Antigravity Language Server port and CSRF token
 * Evaluates both the internal Connect-RPC port (HTTP) and Web UI port (HTTPS)
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<{port: number, csrf: string, protocol: string, candidates: Array}|null>}
 */
export async function getLanguageServerAuth(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedLsAuth && (now - cachedLsAuth.timestamp < 300000)) {
    return cachedLsAuth;
  }

  const candidates = [];

  // 1. Check environment variable candidate (Antigravity Connect-RPC, plain HTTP)
  if (process.env.ANTIGRAVITY_LS_ADDRESS) {
    const parts = process.env.ANTIGRAVITY_LS_ADDRESS.split(':');
    if (parts.length === 2) {
      const port = parseInt(parts[1], 10);
      const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN || '';
      candidates.push({ port, protocol: 'http', csrf, source: 'env' });
    }
  }

  // 2. Resolve Language Server Web UI port from main.log across platforms (HTTPS)
  const home = os.homedir();
  const candidateLogPaths = [
    // Windows
    path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Antigravity', 'logs', 'main.log'),
    // macOS
    path.join(home, 'Library', 'Logs', 'Antigravity', 'main.log'),
    path.join(home, 'Library', 'Application Support', 'Antigravity', 'logs', 'main.log'),
    // Linux
    path.join(home, '.config', 'Antigravity', 'logs', 'main.log')
  ];

  let logPort = 0;
  for (const mainLogPath of candidateLogPaths) {
    if (fs.existsSync(mainLogPath)) {
      try {
        const logContent = fs.readFileSync(mainLogPath, 'utf8');
        const matches = [...logContent.matchAll(/Reloading all windows with URL: https:\/\/127\.0\.0\.1:(\d+)/g)];
        if (matches.length > 0) {
          logPort = parseInt(matches[matches.length - 1][1], 10);
          break;
        }
      } catch (e) {}
    }
  }

  let logCsrf = '';
  if (logPort) {
    try {
      logCsrf = await new Promise((resolve) => {
        const req = https.get({
          hostname: '127.0.0.1',
          port: logPort,
          path: '/',
          rejectUnauthorized: false,
          timeout: 1200
        }, res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            const m = data.match(/"csrfToken"\s*:\s*"([^"]+)"/);
            resolve(m ? m[1] : '');
          });
        });
        req.on('error', () => resolve(''));
        req.on('timeout', () => { req.destroy(); resolve(''); });
      });
    } catch (e) {}

    candidates.push({ port: logPort, protocol: 'https', csrf: logCsrf, source: 'main.log' });
  }

  // 3. Fallback: query language_server process command line asynchronously if CSRF is missing
  let anyCsrf = candidates.find(c => c.csrf)?.csrf || '';
  if (!anyCsrf) {
    try {
      if (process.platform === 'win32') {
        const psCmd = 'Get-CimInstance Win32_Process -Filter "Name=\'language_server.exe\'" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty CommandLine -First 1';
        const cmdLine = await new Promise((resolve) => {
          cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
            timeout: 3000,
            encoding: 'utf8',
            windowsHide: true
          }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
        });
        const m = cmdLine.match(/--csrf_token\s+([a-f0-9-]+)/i);
        if (m) anyCsrf = m[1];
      } else {
        const psOutput = await new Promise((resolve) => {
          cp.execFile('ps', ['aux'], { timeout: 3000, encoding: 'utf8' }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
        });
        for (const line of psOutput.split('\n')) {
          if (line.includes('language_server') && !line.includes('grep')) {
            const m = line.match(/--csrf_token\s+([a-f0-9-]+)/i);
            if (m) {
              anyCsrf = m[1];
              break;
            }
          }
        }
      }
    } catch (e) {}
  }

  // Backfill discovered CSRF token across candidates
  if (anyCsrf) {
    for (const c of candidates) {
      if (!c.csrf) c.csrf = anyCsrf;
    }
  }

  const valid = candidates.filter(c => c.port && c.csrf);
  if (valid.length > 0) {
    const primary = valid[0];
    cachedLsAuth = {
      port: primary.port,
      csrf: primary.csrf,
      protocol: primary.protocol || 'http',
      candidates: valid,
      timestamp: now
    };
    return cachedLsAuth;
  }

  return null;
}

/**
 * Connect-RPC client that fetches authoritative real-time contextWindowUsage from Antigravity Language Server
 * @param {string} conversationId
 * @returns {Promise<{maxContextTokens: number, estimatedTokensUsed: number, tokenGroups: Array}|null>}
 */
export async function fetchOfficialContextUsage(conversationId) {
  if (!conversationId) return null;

  const auth = await getLanguageServerAuth();
  if (!auth || !auth.candidates || auth.candidates.length === 0) return null;

  const runRequest = (targetAuth) => new Promise((resolve) => {
    let resolved = false;
    const cleanupAndResolve = (val) => {
      if (!resolved) {
        resolved = true;
        resolve(val);
      }
    };

    const postPayload = JSON.stringify({
      conversationId,
      subscriberId: crypto.randomUUID(),
      trajectoryVerbosity: 'CLIENT_TRAJECTORY_VERBOSITY_PROD_UI'
    });

    const jsonBuf = Buffer.from(postPayload, 'utf8');
    const envelope = Buffer.alloc(5 + jsonBuf.length);
    envelope[0] = 0x00; // uncompressed frame
    envelope.writeUInt32BE(jsonBuf.length, 1);
    jsonBuf.copy(envelope, 5);

    const client = targetAuth.protocol === 'https' ? https : http;
    const req = client.request({
      hostname: '127.0.0.1',
      port: targetAuth.port,
      path: '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates',
      method: 'POST',
      rejectUnauthorized: false,
      timeout: 1800,
      headers: {
        'Content-Type': 'application/connect+json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': targetAuth.csrf,
        'Content-Length': envelope.length
      }
    }, res => {
      if (res.statusCode !== 200) {
        req.destroy();
        cleanupAndResolve(null);
        return;
      }

      let buffer = Buffer.alloc(0);
      res.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 5) {
          const len = buffer.readUInt32BE(1);
          if (buffer.length < 5 + len) break;
          const frameData = buffer.slice(5, 5 + len);
          buffer = buffer.slice(5 + len);

          try {
            const json = JSON.parse(frameData.toString('utf8'));
            function findUsage(obj) {
              if (!obj || typeof obj !== 'object') return null;
              if (obj.contextWindowUsage) return obj.contextWindowUsage;
              for (const k of Object.keys(obj)) {
                const r = findUsage(obj[k]);
                if (r) return r;
              }
              return null;
            }
            const usage = findUsage(json);
            if (usage) {
              req.destroy();
              cleanupAndResolve({
                maxContextTokens: usage.maxContextTokens || 256000,
                estimatedTokensUsed: usage.estimatedTokensUsed || 0,
                tokenGroups: usage.tokenGroups || []
              });
              return;
            }
          } catch (e) {}
        }
      });
      res.on('end', () => cleanupAndResolve(null));
    });

    req.on('error', () => cleanupAndResolve(null));
    req.on('timeout', () => { req.destroy(); cleanupAndResolve(null); });
    req.write(envelope);

    setTimeout(() => {
      req.destroy();
      cleanupAndResolve(null);
    }, 2000);
  });

  // Try each candidate in order until one returns valid usage
  for (const candidate of auth.candidates) {
    try {
      const result = await runRequest(candidate);
      if (result) return result;
    } catch (e) {}
  }

  return null;
}

function calcMedian(nums) {
  if (!nums || nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function findConversationDbPath(conversationId) {
  if (!conversationId || typeof conversationId !== 'string') return null;
  const safeId = conversationId.trim();
  // Reject path separators or traversal segments
  if (!/^[a-zA-Z0-9_-]+$/.test(safeId)) return null;

  const geminiDir = path.join(os.homedir(), '.gemini');
  if (!fs.existsSync(geminiDir)) return null;

  const primary = path.join(geminiDir, 'antigravity', 'conversations', `${safeId}.db`);
  if (fs.existsSync(primary)) return primary;

  try {
    for (const d of fs.readdirSync(geminiDir)) {
      if (d.startsWith('antigravity') && d !== 'antigravity') {
        const candidate = path.join(geminiDir, d, 'conversations', `${safeId}.db`);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {}
  return null;
}

/**
 * 解析当前会话独立 SQLite 库中的 gen_metadata，统计首字延迟与生成速度
 * @param {string} conversationId
 * @returns {object|null}
 */
export function analyzeSessionPerformance(conversationId) {
  const dbPath = findConversationDbPath(conversationId);
  if (!dbPath) return null;

  const dbSig = getDbFileSignature(dbPath);
  const cachedPerf = dbSig ? sessionPerfCache.get(dbPath) : null;
  if (cachedPerf && cachedPerf.sig === dbSig) {
    return cachedPerf.result;
  }

  try {
    let genRows = [];
    let stepRows = null;
    let useRawBlob = false;

    if (DatabaseSync) {
      const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
      try {
        genRows = db.prepare('SELECT idx, data, length(data) as len FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx').all();
        try {
          stepRows = db.prepare('SELECT status, CASE WHEN length(step_payload) <= 1048576 THEN step_payload ELSE NULL END as p FROM steps WHERE step_type = 15 ORDER BY idx').all();
        } catch {}
        useRawBlob = true;
      } finally {
        try { db.close(); } catch {}
      }
    } else {
      genRows = querySqlite(
        dbPath,
        'SELECT idx, hex(data) as h, length(data) as len FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx',
        5000
      );
      try {
        stepRows = querySqlite(
          dbPath,
          'SELECT status, CASE WHEN length(step_payload) <= 1048576 THEN hex(step_payload) ELSE NULL END as p FROM steps WHERE step_type = 15 ORDER BY idx',
          5000
        );
      } catch {}
    }

    if (!genRows || genRows.length === 0) {
      if (dbSig) setBoundedCache(sessionPerfCache, dbPath, { sig: dbSig, result: null }, 32);
      return null;
    }

    let stepCompleteFlags = null;
    if (Array.isArray(stepRows) && stepRows.length >= genRows.length) {
      stepCompleteFlags = stepRows.map(r => isTextCompleteStep(r.status, r.p));
    }

    const ttftValues = [];
    const completePrimaryBodySpeeds = [];
    const completeFallbackBodySpeeds = [];
    const allPrimaryBodySpeeds = [];
    const allFallbackBodySpeeds = [];
    let latestTtft = null;
    let latestCompletePrimaryBodySpeed = null;
    let latestCompleteFallbackBodySpeed = null;
    let latestAllPrimaryBodySpeed = null;
    let latestAllFallbackBodySpeed = null;
    let latestTotalSpeed = null;
    let latestTotalDuration = null;

    let sumOutputTokens = 0;
    let sumTotalDuration = 0;
    let durationTurnCount = 0;

    for (let ordinal = 0; ordinal < genRows.length; ordinal++) {
      const r = genRows[ordinal];
      const blobSize = Number(r.len || 0);
      const rawPayload = useRawBlob ? r.data : r.h;
      if (blobSize > 64 * 1024 * 1024 || !rawPayload) continue;

      const buf = useRawBlob ? rawPayload : Buffer.from(rawPayload, 'hex');
      const wrapped = getBytesField(1, buf);
      if (!wrapped) continue;

      const isComplete = stepCompleteFlags ? stepCompleteFlags[ordinal] : true;
      const usage = getBytesField(4, wrapped);
      const outputTokens = usage ? (getVarintField(3, usage) || 0) : 0;
      const bodyTokens = usage ? (getVarintField(10, usage) || 0) : 0;
      const firstTextSec = getDuration(getBytesField(11, wrapped));
      const streamSec = getDuration(getBytesField(12, wrapped));

      if (firstTextSec && firstTextSec > 0) {
        ttftValues.push(firstTextSec);
        latestTtft = firstTextSec;
      }

      if (bodyTokens >= 100 && streamSec && streamSec >= 1.0) {
        const spd = bodyTokens / streamSec;
        allPrimaryBodySpeeds.push(spd);
        latestAllPrimaryBodySpeed = spd;
        if (isComplete) {
          completePrimaryBodySpeeds.push(spd);
          latestCompletePrimaryBodySpeed = spd;
        }
      } else if (bodyTokens >= 20 && streamSec && streamSec >= 0.2) {
        const spd = bodyTokens / streamSec;
        allFallbackBodySpeeds.push(spd);
        latestAllFallbackBodySpeed = spd;
        if (isComplete) {
          completeFallbackBodySpeeds.push(spd);
          latestCompleteFallbackBodySpeed = spd;
        }
      }

      const turnDuration = (firstTextSec || 0) + (streamSec || 0);
      if (turnDuration > 0 && (firstTextSec || streamSec)) {
        sumOutputTokens += outputTokens;
        sumTotalDuration += turnDuration;
        durationTurnCount++;
        latestTotalDuration = turnDuration;
        latestTotalSpeed = outputTokens > 0 ? (outputTokens / turnDuration) : null;
      }
    }

    const hasCompletePrimary = completePrimaryBodySpeeds.length > 0;
    const hasCompleteFallback = completeFallbackBodySpeeds.length > 0;
    const primaryBodySpeeds = (hasCompletePrimary || hasCompleteFallback) ? completePrimaryBodySpeeds : allPrimaryBodySpeeds;
    const fallbackBodySpeeds = (hasCompletePrimary || hasCompleteFallback) ? completeFallbackBodySpeeds : allFallbackBodySpeeds;
    const latestPrimaryBodySpeed = (hasCompletePrimary || hasCompleteFallback) ? latestCompletePrimaryBodySpeed : latestAllPrimaryBodySpeed;
    const latestFallbackBodySpeed = (hasCompletePrimary || hasCompleteFallback) ? latestCompleteFallbackBodySpeed : latestAllFallbackBodySpeed;

    const useFallbackBody = primaryBodySpeeds.length === 0 && fallbackBodySpeeds.length > 0;
    const bodySpeedList = useFallbackBody ? fallbackBodySpeeds : primaryBodySpeeds;
    const bodySpeedLatest = useFallbackBody ? latestFallbackBodySpeed : latestPrimaryBodySpeed;

    const perfResult = {
      turnCount: genRows.length,
      ttft: {
        latest: latestTtft,
        median: calcMedian(ttftValues),
        sampleCount: ttftValues.length
      },
      bodySpeed: {
        median: calcMedian(bodySpeedList),
        latest: bodySpeedLatest,
        sampleCount: bodySpeedList.length,
        isShortFallback: useFallbackBody
      },
      totalSpeed: {
        avg: sumTotalDuration > 0 ? sumOutputTokens / sumTotalDuration : null,
        latest: latestTotalSpeed,
        sampleCount: durationTurnCount
      },
      latency: {
        totalSeconds: sumTotalDuration > 0 ? sumTotalDuration : null,
        avgSeconds: durationTurnCount > 0 ? sumTotalDuration / durationTurnCount : null,
        latestSeconds: latestTotalDuration,
        sampleCount: durationTurnCount
      }
    };
    const postDbSig = getDbFileSignature(dbPath) || dbSig;
    if (postDbSig) {
      setBoundedCache(sessionPerfCache, dbPath, { sig: postDbSig, result: perfResult }, 32);
    }
    return perfResult;
  } catch (e) {
    return null;
  }
}

export async function analyzeTranscript(transcriptPath, options = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    throw new Error(`Transcript file not found: ${transcriptPath}`);
  }

  let conversationId = options.conversationId || '';
  if (!conversationId) {
    const match = transcriptPath.match(/brain[/\\]([^/\\]+)/);
    if (match) conversationId = match[1];
  }

  const st = fs.statSync(transcriptPath);
  const transcriptSig = `${st.mtimeMs}:${st.size}`;
  let localParsed = transcriptParseCache.get(transcriptPath)?.sig === transcriptSig
    ? transcriptParseCache.get(transcriptPath).data
    : null;

  if (!localParsed) {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);

    let modelName = 'Gemini 3.8 Flash (High)';
    let modelLimit = MODEL_LIMITS.default;
    const resolveModelLimit = (name) => {
      const lower = name.toLowerCase();
      for (const [key, limit] of Object.entries(MODEL_LIMITS)) {
        if (lower.includes(key)) return limit;
      }
      return MODEL_LIMITS.default;
    };

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalModelTurns = 0;

    let systemTokens = 0;
    let toolsTokens = 0;
    let userTokens = 0;
    let assistantTokens = 0;

    const toolStats = {};
    const timeline = [];
    const compactions = [];

    let currentContext = 0;
    let pendingCompaction = null;
    let activePhase = null;
    let pendingSwitchReason = null;
    let prevTurnModel = null;
    let prevTurnTsMs = null;
    const lastTurnByModel = new Map();

    const SWITCH_LABELS = {
      plan_to_exec: 'Plan → Exec',
      plan_review: 'Exec → Plan (Review)',
      exec_to_plan: 'Exec → Plan',
      manual: '手动切模型'
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (e) {
        continue;
      }

      const stepIndex = entry.step_index ?? i;
      const type = entry.type || '';
      const content = entry.content || '';
      const thinking = entry.thinking || '';

      if (type === 'USER_INPUT') {
        const modelMatch = content.match(/Model Selection` from .*? to (.*?)\./);
        if (modelMatch) {
          modelName = modelMatch[1].trim();
          modelLimit = resolveModelLimit(modelName);
          pendingSwitchReason = 'manual';
        } else if (activePhase === 'exec') {
          activePhase = 'plan';
          pendingSwitchReason = 'exec_to_plan';
        }
      } else if (type === 'SYSTEM_MESSAGE') {
        if (/Plan mode is off\b|this turn runs on the execution model/i.test(content)) {
          activePhase = 'exec';
          pendingSwitchReason = 'plan_to_exec';
        } else if (/\[plan review\]|Plan mode is on\b|this turn runs on the planning model/i.test(content)) {
          activePhase = 'plan';
          pendingSwitchReason = /\[plan review\]/i.test(content) ? 'plan_review' : 'exec_to_plan';
        }
      }

      const isCompactionCheckpoint =
        type === 'CHECKPOINT' ||
        (type === 'SYSTEM_MESSAGE' && /Resuming from a compaction/i.test(content));

      if (isCompactionCheckpoint) {
        if (pendingCompaction) {
          compactions.push({
            index: compactions.length + 1,
            step: pendingCompaction.step,
            timestamp: pendingCompaction.timestamp,
            before_turn: pendingCompaction.before_turn,
            turn: null,
            before_tokens: pendingCompaction.before_tokens,
            after_tokens: null,
            saved_tokens: null,
            source: pendingCompaction.source
          });
        }
        pendingCompaction = {
          step: stepIndex,
          timestamp: entry.created_at || null,
          before_turn: totalModelTurns > 0 ? totalModelTurns : null,
          before_tokens: currentContext > 0 ? currentContext : null,
          source: type === 'CHECKPOINT' ? 'CHECKPOINT' : 'SYSTEM_MESSAGE'
        };
      }

      if (type === 'PLANNER_RESPONSE' && typeof entry.input_tokens === 'number') {
        totalModelTurns++;
        const inp = entry.input_tokens;
        const cch = entry.cache_read_tokens || 0;
        const out = entry.output_tokens || 0;
        const prevContext = currentContext;

        totalInputTokens = inp;
        totalCacheReadTokens = cch;
        totalOutputTokens += out;
        currentContext = inp + cch;

        const rawEntryModel = typeof entry.model === 'string' ? entry.model.trim() : '';
        if (rawEntryModel) {
          modelName = rawEntryModel;
          modelLimit = resolveModelLimit(modelName);
        }
        const turnModel = rawEntryModel || modelName;

        const toolCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
        const callsExitPlan = toolCalls.some(c => c && c.name === 'exit_plan_mode');
        const callsEnterPlan = toolCalls.some(c => c && c.name === 'enter_plan_mode');
        if (callsExitPlan && !activePhase) activePhase = 'plan';
        if (callsEnterPlan && !activePhase) activePhase = 'exec';
        const turnPhase = activePhase;

        const modelSwitched = Boolean(prevTurnModel && turnModel !== prevTurnModel);
        const switchLabel = modelSwitched ? (SWITCH_LABELS[pendingSwitchReason] || '模型切换') : null;

        const tsMs = entry.created_at ? Date.parse(entry.created_at) : NaN;
        const validTs = Number.isFinite(tsMs) ? tsMs : null;
        const prevTurnGapSeconds = (validTs !== null && prevTurnTsMs !== null)
          ? Math.max(0, Math.round((validTs - prevTurnTsMs) / 1000))
          : null;
        const modelKey = turnModel.toLowerCase();
        const sameModelPrev = lastTurnByModel.get(modelKey) || null;
        const sameModelPrevTurn = sameModelPrev ? sameModelPrev.turn : null;
        const sameModelGapSeconds = (validTs !== null && sameModelPrev && sameModelPrev.tsMs !== null)
          ? Math.max(0, Math.round((validTs - sameModelPrev.tsMs) / 1000))
          : null;

        let compactionEvent = null;
        if (pendingCompaction) {
          const beforeTok = pendingCompaction.before_tokens ?? (prevContext > 0 ? prevContext : null);
          const savedTok = typeof beforeTok === 'number' ? Math.max(0, beforeTok - currentContext) : null;
          compactionEvent = {
            index: compactions.length + 1,
            step: pendingCompaction.step,
            timestamp: pendingCompaction.timestamp || entry.created_at || null,
            before_turn: pendingCompaction.before_turn,
            turn: totalModelTurns,
            before_tokens: beforeTok,
            after_tokens: currentContext,
            saved_tokens: savedTok,
            source: pendingCompaction.source
          };
          compactions.push(compactionEvent);
          pendingCompaction = null;
        } else if (
          prevContext >= 40000 &&
          currentContext > 0 &&
          currentContext < prevContext * 0.65 &&
          (prevContext - currentContext) >= 25000
        ) {
          compactionEvent = {
            index: compactions.length + 1,
            step: stepIndex,
            timestamp: entry.created_at || null,
            before_turn: totalModelTurns - 1,
            turn: totalModelTurns,
            before_tokens: prevContext,
            after_tokens: currentContext,
            saved_tokens: prevContext - currentContext,
            source: 'TOKEN_DROP'
          };
          compactions.push(compactionEvent);
        }

        timeline.push({
          step: stepIndex,
          turn: totalModelTurns,
          model: turnModel,
          ...(turnPhase ? { phase: turnPhase } : {}),
          ...(modelSwitched ? {
            model_switched: true,
            prev_model: prevTurnModel,
            switch_label: switchLabel
          } : {}),
          prev_turn_gap_seconds: prevTurnGapSeconds,
          same_model_gap_seconds: sameModelGapSeconds,
          same_model_prev_turn: sameModelPrevTurn,
          input_tokens: inp,
          cache_tokens: cch,
          output_tokens: out,
          total_context: currentContext,
          timestamp: entry.created_at || null,
          ...(compactionEvent ? { compaction: compactionEvent } : {})
        });

        prevTurnModel = turnModel;
        if (validTs !== null) prevTurnTsMs = validTs;
        lastTurnByModel.set(modelKey, { turn: totalModelTurns, tsMs: validTs });
        pendingSwitchReason = null;
        if (callsExitPlan) {
          activePhase = 'exec';
          pendingSwitchReason = 'plan_to_exec';
        } else if (callsEnterPlan) {
          activePhase = 'plan';
          pendingSwitchReason = 'plan_review';
        }
      }

      const estTokens = estimateTokens(content) + estimateTokens(thinking);

      if (type === 'USER_INPUT' && content.includes('<system_prompt>')) {
        systemTokens += estTokens;
      } else if (type === 'USER_INPUT') {
        userTokens += estTokens;
      } else if (type === 'PLANNER_RESPONSE') {
        assistantTokens += estTokens;
      }

      if (entry.tool_calls && Array.isArray(entry.tool_calls)) {
        for (const call of entry.tool_calls) {
          const name = call.name || 'unknown_tool';
          const callArgs = JSON.stringify(call.args || {});
          const callTokens = estimateTokens(callArgs);
          toolsTokens += callTokens;

          if (!toolStats[name]) {
            toolStats[name] = { count: 0, estimatedTokens: 0 };
          }
          toolStats[name].count++;
          toolStats[name].estimatedTokens += callTokens;
        }
      }

      if (type === 'TOOL_OUTPUT') {
        toolsTokens += estTokens;
        const toolName = entry.source || 'Tool Result';
        if (!toolStats[toolName]) {
          toolStats[toolName] = { count: 0, estimatedTokens: 0 };
        }
        toolStats[toolName].estimatedTokens += estTokens;
      }
    }

    if (pendingCompaction) {
      compactions.push({
        index: compactions.length + 1,
        step: pendingCompaction.step,
        timestamp: pendingCompaction.timestamp,
        before_turn: pendingCompaction.before_turn,
        turn: null,
        before_tokens: pendingCompaction.before_tokens,
        after_tokens: null,
        saved_tokens: null,
        source: pendingCompaction.source
      });
    }

    if (currentContext === 0) {
      currentContext = systemTokens + toolsTokens + userTokens + assistantTokens;
    }

    localParsed = {
      modelName,
      modelLimit,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalModelTurns,
      systemTokens,
      toolsTokens,
      userTokens,
      assistantTokens,
      currentContext,
      toolStats,
      timeline,
      compactions
    };
    setBoundedCache(transcriptParseCache, transcriptPath, { sig: transcriptSig, data: localParsed }, 16);
  }

  let modelLimit = localParsed.modelLimit;
  let currentContext = localParsed.currentContext;

  // Always fetch live Language Server telemetry & cached session DB performance dynamically
  let officialUsage = null;
  if (conversationId) {
    try {
      officialUsage = await fetchOfficialContextUsage(conversationId);
    } catch {}
  }

  if (officialUsage) {
    if (officialUsage.maxContextTokens) {
      modelLimit = officialUsage.maxContextTokens;
    }
    if (typeof officialUsage.estimatedTokensUsed === 'number' && officialUsage.estimatedTokensUsed > 0) {
      currentContext = officialUsage.estimatedTokensUsed;
    }
  }

  let breakdown = [];
  if (officialUsage && Array.isArray(officialUsage.tokenGroups) && officialUsage.tokenGroups.length > 0) {
    const sysGroup = officialUsage.tokenGroups.find(g =>
      g.type === 'TOKEN_TYPE_SYSTEM_PROMPT' || (g.name && g.name.toLowerCase().includes('system'))
    );
    const toolGroup = officialUsage.tokenGroups.find(g =>
      g.type === 'TOKEN_TYPE_TOOLS' || (g.name && g.name.toLowerCase().includes('tool'))
    );
    const chatGroup = officialUsage.tokenGroups.find(g =>
      g.type === 'TOKEN_TYPE_CHAT_MESSAGES' || (g.name && g.name.toLowerCase().includes('chat'))
    );

    const sysTok = sysGroup ? sysGroup.numTokens : localParsed.systemTokens;
    const toolTok = toolGroup ? toolGroup.numTokens : localParsed.toolsTokens;
    const chatTok = chatGroup ? chatGroup.numTokens : (localParsed.userTokens + localParsed.assistantTokens);

    const totalGroupTok = (sysTok + toolTok + chatTok) || currentContext || 1;
    const sysPct = Math.round((sysTok / totalGroupTok) * 100);
    const toolPct = Math.round((toolTok / totalGroupTok) * 100);
    const chatPct = Math.max(0, 100 - sysPct - toolPct);

    breakdown = [
      { key: 'system', label: 'System Prompt', tokens: sysTok, percent: sysPct },
      { key: 'tools', label: 'Tools', tokens: toolTok, percent: toolPct },
      { key: 'chat', label: 'Chat Messages', tokens: chatTok, percent: chatPct }
    ];
  } else {
    const categorySum = localParsed.systemTokens + localParsed.toolsTokens + localParsed.userTokens + localParsed.assistantTokens || 1;
    const sysPct = Math.round((localParsed.systemTokens / categorySum) * 100);
    const toolPct = Math.round((localParsed.toolsTokens / categorySum) * 100);
    const userPct = Math.round((localParsed.userTokens / categorySum) * 100);
    const modelPct = Math.max(0, 100 - sysPct - toolPct - userPct);

    breakdown = [
      { key: 'system', label: 'System & Guidelines', tokens: localParsed.systemTokens, percent: sysPct },
      { key: 'tools', label: 'Tool Calls & Outputs', tokens: localParsed.toolsTokens, percent: toolPct },
      { key: 'user', label: 'User Instructions', tokens: localParsed.userTokens, percent: userPct },
      { key: 'model', label: 'Model Responses', tokens: localParsed.assistantTokens, percent: modelPct }
    ];
  }

  const usagePercent = Math.min(100, Number(((currentContext / modelLimit) * 100).toFixed(1)));
  const remainingTokens = Math.max(0, modelLimit - currentContext);

  const totalInputWindow = localParsed.totalInputTokens + localParsed.totalCacheReadTokens;
  const cacheHitRatio = totalInputWindow > 0
    ? Number(((localParsed.totalCacheReadTokens / totalInputWindow) * 100).toFixed(1))
    : 0;

  let healthStatus = '良好 (Healthy)';
  let healthLevel = 'info';
  if (usagePercent > 80) {
    healthStatus = '危险 (Critical: >80%)';
    healthLevel = 'critical';
  } else if (usagePercent > 60) {
    healthStatus = '警告 (Warning: >60%)';
    healthLevel = 'warning';
  }

  const performance = conversationId ? analyzeSessionPerformance(conversationId) : null;

  return {
    meta: {
      conversationId,
      model: localParsed.modelName,
      modelLimit,
      isOfficialTelemetry: !!officialUsage,
      analyzedAt: new Date().toISOString()
    },
    overview: {
      currentTotalContext: currentContext,
      modelLimit,
      usagePercent,
      remainingTokens,
      healthStatus,
      healthLevel,
      cacheHitRatio,
      cacheTokens: localParsed.totalCacheReadTokens,
      uncachedTokens: localParsed.totalInputTokens,
      totalOutputTokens: localParsed.totalOutputTokens,
      totalModelTurns: localParsed.totalModelTurns
    },
    performance,
    breakdown,
    toolStats: localParsed.toolStats,
    timeline: localParsed.timeline,
    compactions: localParsed.compactions
  };
}
