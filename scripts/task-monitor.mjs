/**
 * @fileoverview Multi-task conversation monitor & activity heatmap service
 * Tracks running tasks, completed-but-unread conversations, live checklist/focus
 * progress from local transcripts, and 365-day activity heatmap metrics.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import {
  getLanguageServerAuth,
  runNativeStatsScanAsync,
  formatCompactNumber,
  getModelPricing
} from './context-analyzer.mjs';

const require = createRequire(import.meta.url);
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const APP_DATA_DIR = process.env.ANTIGRAVITY_APP_DATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity');
const PLUGIN_DATA_DIR = path.join(APP_DATA_DIR, 'plugin_data', 'agy-context');
const DISMISSED_UNREAD_FILE = path.join(PLUGIN_DATA_DIR, 'dismissed-unread.json');
const UNREAD_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const UNREAD_TIME_TOLERANCE_MS = 1500;
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

const transcriptProgressCache = new Map();

function ensurePluginDataDir() {
  if (!fs.existsSync(PLUGIN_DATA_DIR)) {
    fs.mkdirSync(PLUGIN_DATA_DIR, { recursive: true });
  }
}

function readDismissedMap() {
  try {
    if (!fs.existsSync(DISMISSED_UNREAD_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(DISMISSED_UNREAD_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeDismissedMap(map) {
  ensurePluginDataDir();
  const entries = Object.entries(map)
    .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))
    .slice(0, 500);
  const tmpPath = `${DISMISSED_UNREAD_FILE}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(entries), null, 2), 'utf8');
  try {
    fs.renameSync(tmpPath, DISMISSED_UNREAD_FILE);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

export function markTaskRead(conversationId, updateTimeMs = Date.now()) {
  if (!conversationId || typeof conversationId !== 'string') {
    return { success: false, error: 'Missing conversationId' };
  }
  const map = readDismissedMap();
  const ts = Number(updateTimeMs) || Date.now();
  map[conversationId] = Math.max(ts, Number(map[conversationId]) || 0);
  writeDismissedMap(map);
  return { success: true, conversationId, readAt: map[conversationId] };
}

export function markAllTasksRead(items = []) {
  const map = readDismissedMap();
  const now = Date.now();
  let count = 0;
  for (const item of items) {
    if (!item?.id) continue;
    const ts = Number(item.updateTimeMs) || now;
    map[item.id] = Math.max(ts, Number(map[item.id]) || 0);
    count++;
  }
  writeDismissedMap(map);
  return { success: true, count };
}

let inflightApiFetch = null;
let cachedApiList = { ts: 0, data: null };
const API_CACHE_TTL_MS = 3000;

/**
 * Call official Connect HTTP+JSON ConversationService/ListConversations
 * @param {{ pageSize?: number }} [options]
 * @returns {Promise<Array|null>}
 */
async function fetchConversationsViaApi({ pageSize = 40 } = {}) {
  const now = Date.now();
  if (cachedApiList.data && (now - cachedApiList.ts) < API_CACHE_TTL_MS) {
    return cachedApiList.data;
  }
  if (inflightApiFetch) return inflightApiFetch;

  const callCandidate = (cand) => new Promise((resolve) => {
    const body = JSON.stringify({ pageSize, includeArchived: false });
    const client = cand.protocol === 'https' ? https : http;
    const req = client.request({
      hostname: cand.hostname || '127.0.0.1',
      port: cand.port,
      path: '/product.v1.ConversationService/ListConversations',
      method: 'POST',
      rejectUnauthorized: false,
      timeout: 6000,
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-antigravity-csrf-token': cand.csrf,
        'Content-Length': Buffer.byteLength(body, 'utf8')
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(Array.isArray(parsed.conversations) ? parsed.conversations : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });

  inflightApiFetch = (async () => {
    try {
      const envAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
      const envCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
      if (envAddr && envCsrf) {
        const [hostPart, portPart] = envAddr.split(':');
        const portNum = Number(portPart);
        if (portNum > 0) {
          const normalizedHost = (!hostPart || hostPart === 'localhost') ? '127.0.0.1' : hostPart;
          const direct = await callCandidate({
            hostname: normalizedHost,
            port: portNum,
            protocol: 'http',
            csrf: envCsrf
          });
          if (direct) {
            cachedApiList = { ts: Date.now(), data: direct };
            return direct;
          }
        }
      }

      const auth = await getLanguageServerAuth();
      for (const c of (auth?.candidates || [])) {
        const res = await callCandidate({
          hostname: '127.0.0.1',
          port: c.port,
          protocol: c.protocol || 'http',
          csrf: c.csrf
        });
        if (res) {
          cachedApiList = { ts: Date.now(), data: res };
          return res;
        }
      }
      return null;
    } finally {
      inflightApiFetch = null;
    }
  })();

  return inflightApiFetch;
}

/**
 * Read conversation_summaries.db for workspace_uris, step_count, subagent tree, and status
 * @param {number} limit
 * @returns {{ byId: Map<string, object>, subagentCounts: Map<string, {total: number, running: number}>, recentRows: Array }}
 */
function readConversationSummaries(limit = 200) {
  const byId = new Map();
  const subagentCounts = new Map();
  const recentRows = [];
  if (!DatabaseSync) return { byId, subagentCounts, recentRows };

  const dbPath = path.join(APP_DATA_DIR, 'conversation_summaries.db');
  if (!fs.existsSync(dbPath)) return { byId, subagentCounts, recentRows };

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(`
      SELECT
        conversation_id,
        title,
        preview,
        step_count,
        last_modified_time,
        workspace_uris,
        status,
        project_id,
        parent_conversation_id,
        nesting_depth,
        not_fully_idle,
        killed,
        last_user_input_time
      FROM conversation_summaries
      ORDER BY last_modified_time DESC
      LIMIT ?
    `).all(Math.max(limit * 3, 400));

    for (const row of rows) {
      const parentId = String(row.parent_conversation_id || '').trim();
      if (parentId) {
        const cur = subagentCounts.get(parentId) || { total: 0, running: 0 };
        cur.total += 1;
        if (row.status === 'CASCADE_RUN_STATUS_RUNNING' || Number(row.not_fully_idle) === 1) {
          cur.running += 1;
        }
        subagentCounts.set(parentId, cur);
        continue;
      }
      byId.set(row.conversation_id, row);
      if (recentRows.length < limit) {
        recentRows.push(row);
      }
    }
  } catch {
    // Fallback gracefully when DB is locked or unavailable
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
  return { byId, subagentCounts, recentRows };
}

/**
 * Parse annotations/<convId>.pbtxt for last_user_view_time, pinned, archived, title
 * @param {string} conversationId
 * @returns {{ lastUserViewTimeMs: number, pinned: boolean, archived: boolean, title: string }}
 */
function readAnnotationMeta(conversationId) {
  const res = { lastUserViewTimeMs: 0, pinned: false, archived: false, title: '' };
  if (!conversationId || !/^[a-zA-Z0-9_-]+$/.test(conversationId)) return res;

  const pbtxtPath = path.join(APP_DATA_DIR, 'annotations', `${conversationId}.pbtxt`);
  if (!fs.existsSync(pbtxtPath)) return res;

  try {
    const text = fs.readFileSync(pbtxtPath, 'utf8');
    const secMatch = text.match(/last_user_view_time\s*:\s*\{[^}]*seconds\s*:\s*(\d+)/);
    if (secMatch) {
      const sec = Number(secMatch[1]) || 0;
      const nanoMatch = text.match(/last_user_view_time\s*:\s*\{[^}]*nanos\s*:\s*(\d+)/);
      const nanos = nanoMatch ? Number(nanoMatch[1]) || 0 : 0;
      res.lastUserViewTimeMs = sec * 1000 + Math.floor(nanos / 1e6);
    }
    if (/\bpinned\s*:\s*true\b/.test(text)) res.pinned = true;
    if (/\barchived\s*:\s*true\b/.test(text)) res.archived = true;
    const titleMatch = text.match(/\btitle\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (titleMatch) {
      try {
        res.title = JSON.parse(`"${titleMatch[1]}"`);
      } catch {
        res.title = titleMatch[1];
      }
    }
  } catch {
    // Ignore unreadable annotation
  }
  return res;
}

function parseWorkspaceInfo(workspaceUrisRaw) {
  if (!workspaceUrisRaw) return { workspaceName: '', workspacePath: '' };
  let uris = [];
  if (Array.isArray(workspaceUrisRaw)) {
    uris = workspaceUrisRaw;
  } else if (typeof workspaceUrisRaw === 'string') {
    const trimmed = workspaceUrisRaw.trim();
    if (trimmed.startsWith('[')) {
      try { uris = JSON.parse(trimmed); } catch {}
    } else if (trimmed) {
      uris = [trimmed];
    }
  }
  const first = String(uris[0] || '').trim();
  if (!first) return { workspaceName: '', workspacePath: '' };
  let decoded = first;
  try {
    decoded = decodeURIComponent(first.replace(/^file:\/\/\/?/i, ''));
  } catch {
    decoded = first.replace(/^file:\/\/\/?/i, '');
  }
  decoded = decoded.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = decoded.split('/').filter(Boolean);
  return {
    workspaceName: parts[parts.length - 1] || decoded,
    workspacePath: decoded
  };
}

function parseTimestampMs(raw) {
  if (!raw) return 0;
  if (typeof raw === 'number') return raw > 1e12 ? raw : raw * 1000;
  const s = String(raw).trim();
  if (!s || s.startsWith('0001-01-01')) return 0;
  // Normalize SQLite datetime format "2026-11-27 09:44:09.2626462+00:00"
  const normalized = s.includes('T') ? s : s.replace(' ', 'T');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

function parseJsonArgValue(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Extract live steps checklist, focus phrase, latest tool activity, and model/token stats
 * from a conversation's transcript.jsonl (tail-read + stat-cached).
 * @param {string} conversationId
 * @returns {object}
 */
export function extractTaskProgress(conversationId) {
  const empty = {
    hasTranscript: false,
    focus: '',
    steps: [],
    stepsDone: 0,
    stepsTotal: 0,
    stepsInProgress: 0,
    stepsFailed: 0,
    progressPercent: null,
    currentModel: '',
    latestTool: '',
    latestActivity: '',
    turnCount: 0,
    latestContextTokens: 0,
    turnStartedAt: 0,
    lastStepAt: 0
  };
  if (!conversationId || !/^[a-zA-Z0-9_-]+$/.test(conversationId)) return empty;

  const transcriptPath = path.join(APP_DATA_DIR, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(transcriptPath)) return empty;

  let st;
  try {
    st = fs.statSync(transcriptPath);
  } catch {
    return empty;
  }
  const cacheKey = `${st.mtimeMs}:${st.size}`;
  const cached = transcriptProgressCache.get(conversationId);
  if (cached && cached.key === cacheKey) return cached.data;

  let text = '';
  try {
    if (st.size <= TRANSCRIPT_TAIL_BYTES) {
      text = fs.readFileSync(transcriptPath, 'utf8');
    } else {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const buf = Buffer.alloc(TRANSCRIPT_TAIL_BYTES);
        const bytesRead = fs.readSync(fd, buf, 0, TRANSCRIPT_TAIL_BYTES, st.size - TRANSCRIPT_TAIL_BYTES);
        text = buf.subarray(0, bytesRead).toString('utf8');
        const firstNl = text.indexOf('\n');
        if (firstNl >= 0) text = text.slice(firstNl + 1);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    return empty;
  }

  const lines = text.split('\n').filter(Boolean);
  let lastUserIdx = -1;
  let turnCount = 0;
  let turnStartedAt = 0;
  let lastStepAt = 0;
  let currentModel = '';
  let latestContextTokens = 0;
  let latestTool = '';
  let latestActivity = '';
  let focus = '';
  let latestSteps = null;
  let latestStepsAfterUser = null;

  const parsedEntries = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      parsedEntries.push(obj);
      if (obj.type === 'USER_INPUT' || obj.source === 'USER_EXPLICIT') {
        lastUserIdx = parsedEntries.length - 1;
        turnCount++;
        const ts = parseTimestampMs(obj.created_at);
        if (ts) turnStartedAt = ts;
      }
    } catch {
      // Skip partial/malformed line
    }
  }

  for (let i = 0; i < parsedEntries.length; i++) {
    const obj = parsedEntries[i];
    const inCurrentTurn = i >= Math.max(0, lastUserIdx);
    const ts = parseTimestampMs(obj.created_at);
    if (ts > lastStepAt) lastStepAt = ts;

    if (obj.model) currentModel = String(obj.model);
    if (obj.type === 'PLANNER_RESPONSE') {
      const inTok = Number(obj.input_tokens) || 0;
      const cacheTok = Number(obj.cache_read_tokens) || 0;
      if (inTok + cacheTok > 0) latestContextTokens = inTok + cacheTok;

      if (Array.isArray(obj.tool_calls)) {
        for (const tc of obj.tool_calls) {
          const name = String(tc?.name || '');
          if (!name) continue;
          if (name === 'update_focus') {
            if (inCurrentTurn) {
              const fVal = parseJsonArgValue(tc.args?.focus);
              if (typeof fVal === 'string' && fVal.trim()) {
                focus = fVal.trim();
              }
            }
          } else if (name === 'update_steps') {
            const sVal = parseJsonArgValue(tc.args?.steps);
            if (Array.isArray(sVal)) {
              const cleaned = sVal
                .filter(item => item && typeof item.title === 'string')
                .map(item => ({
                  title: item.title.trim(),
                  status: String(item.status || 'pending')
                }));
              if (cleaned.length > 0) {
                latestSteps = cleaned;
                if (inCurrentTurn) latestStepsAfterUser = cleaned;
              }
            }
          } else {
            latestTool = name;
            const summary = parseJsonArgValue(tc.args?.toolSummary)
              || parseJsonArgValue(tc.args?.Path)
              || parseJsonArgValue(tc.args?.Role)
              || parseJsonArgValue(tc.args?.query);
            if (typeof summary === 'string' && summary.trim()) {
              latestActivity = `${name}: ${summary.trim().slice(0, 72)}`;
            } else {
              latestActivity = `调用工具 ${name}`;
            }
          }
        }
      }

      if (typeof obj.content === 'string' && obj.content.trim() && (!Array.isArray(obj.tool_calls) || obj.tool_calls.length === 0)) {
        const plain = obj.content.replace(/\s+/g, ' ').trim();
        if (plain) latestActivity = plain.slice(0, 90);
      }
    }
  }

  const activeSteps = latestStepsAfterUser
    || (latestSteps && latestSteps.some(s => s.status === 'in_progress' || s.status === 'pending') ? latestSteps : []);
  const stepsTotal = activeSteps.length;
  const stepsDone = activeSteps.filter(s => s.status === 'done' || s.status === 'skipped').length;
  const stepsInProgress = activeSteps.filter(s => s.status === 'in_progress').length;
  const stepsFailed = activeSteps.filter(s => s.status === 'failed').length;
  const progressPercent = stepsTotal > 0 ? Math.round((stepsDone / stepsTotal) * 100) : null;

  const data = {
    hasTranscript: true,
    focus,
    steps: activeSteps,
    stepsDone,
    stepsTotal,
    stepsInProgress,
    stepsFailed,
    progressPercent,
    currentModel,
    latestTool,
    latestActivity: focus || latestActivity,
    turnCount,
    latestContextTokens,
    turnStartedAt,
    lastStepAt
  };

  transcriptProgressCache.set(conversationId, { key: cacheKey, data });
  if (transcriptProgressCache.size > 120) {
    const firstKey = transcriptProgressCache.keys().next().value;
    transcriptProgressCache.delete(firstKey);
  }
  return data;
}

/**
 * List monitored tasks (running + completed unread) and recent session index.
 * @param {{ sessionLimit?: number }} [options]
 */
export async function getTaskMonitorData({ sessionLimit = 60 } = {}) {
  const apiConversations = await fetchConversationsViaApi({ pageSize: 40 });
  const summaryData = readConversationSummaries(Math.max(sessionLimit, 120));

  const dismissedMap = readDismissedMap();
  const nowMs = Date.now();
  const mergedMap = new Map();

  if (Array.isArray(apiConversations)) {
    for (const c of apiConversations) {
      if (!c?.id) continue;
      if (c.annotations?.archived) continue;
      if (c.metadata?.parentConversationId) continue;

      const sum = summaryData.byId.get(c.id);
      if (Number(sum?.nesting_depth) > 0) continue;
      const ann = readAnnotationMeta(c.id);
      if (ann.archived) continue;

      const updateTimeMs = Math.max(
        parseTimestampMs(c.state?.updateTime),
        parseTimestampMs(sum?.last_modified_time)
      );
      const createTimeMs = parseTimestampMs(c.metadata?.createTime);
      const runState = String(c.state?.runState || 'RUN_STATE_IDLE');
      const isRunning = runState === 'RUN_STATE_RUNNING'
        || runState === 'RUN_STATE_CANCELLING'
        || sum?.status === 'CASCADE_RUN_STATUS_RUNNING'
        || Number(sum?.not_fully_idle) === 1;
      const ws = parseWorkspaceInfo(sum?.workspace_uris);
      const sub = summaryData.subagentCounts.get(c.id) || { total: 0, running: 0 };
      const realTitle = c.annotations?.title || ann.title || sum?.title || '';

      mergedMap.set(c.id, {
        id: c.id,
        title: realTitle || (c.state?.summary ? String(c.state.summary).slice(0, 64) : '未命名会话'),
        hasRealTitle: Boolean(realTitle),
        summary: String(c.state?.summary || sum?.preview || '').slice(0, 140),
        projectId: c.metadata?.projectId || sum?.project_id || '',
        workspaceName: ws.workspaceName,
        workspacePath: ws.workspacePath,
        pinned: Boolean(c.annotations?.pinned || ann.pinned),
        runState,
        isRunning,
        stepCount: Number(sum?.step_count) || 0,
        updateTimeMs,
        createTimeMs,
        lastUserInputMs: parseTimestampMs(sum?.last_user_input_time),
        lastUserViewTimeMs: ann.lastUserViewTimeMs,
        subagentTotal: sub.total,
        subagentRunning: sub.running
      });
    }
  }

  // Only fall back to conversation_summaries.db when ListConversations API is unavailable
  if (!Array.isArray(apiConversations)) {
    for (const sum of summaryData.recentRows) {
      if (!sum?.conversation_id || mergedMap.has(sum.conversation_id)) continue;
      if (Number(sum.nesting_depth) > 0) continue;
      const ann = readAnnotationMeta(sum.conversation_id);
      if (ann.archived) continue;
      const resolvedTitle = ann.title || sum.title || '';
      if (!resolvedTitle) continue;
      const updateTimeMs = parseTimestampMs(sum.last_modified_time);
      const isRunning = sum.status === 'CASCADE_RUN_STATUS_RUNNING' || Number(sum.not_fully_idle) === 1;
      const ws = parseWorkspaceInfo(sum.workspace_uris);
      const sub = summaryData.subagentCounts.get(sum.conversation_id) || { total: 0, running: 0 };

      mergedMap.set(sum.conversation_id, {
        id: sum.conversation_id,
        title: resolvedTitle,
        hasRealTitle: true,
        summary: String(sum.preview || '').slice(0, 140),
        projectId: sum.project_id || '',
        workspaceName: ws.workspaceName,
        workspacePath: ws.workspacePath,
        pinned: ann.pinned,
        runState: isRunning ? 'RUN_STATE_RUNNING' : 'RUN_STATE_IDLE',
        isRunning,
        stepCount: Number(sum.step_count) || 0,
        updateTimeMs,
        createTimeMs: 0,
        lastUserInputMs: parseTimestampMs(sum.last_user_input_time),
        lastUserViewTimeMs: ann.lastUserViewTimeMs,
        subagentTotal: sub.total,
        subagentRunning: sub.running
      });
    }
  }

  const allItems = Array.from(mergedMap.values()).sort((a, b) => b.updateTimeMs - a.updateTimeMs);

  const running = [];
  const unread = [];

  for (const item of allItems) {
    if (item.isRunning) {
      const progress = extractTaskProgress(item.id);
      running.push({
        ...item,
        category: 'running',
        isUnread: false,
        progress
      });
      continue;
    }

    const withinWindow = item.updateTimeMs > 0 && (nowMs - item.updateTimeMs) <= UNREAD_MAX_AGE_MS;
    const viewedAt = item.lastUserViewTimeMs || 0;
    const dismissedAt = Number(dismissedMap[item.id]) || 0;
    const effectiveReadAt = Math.max(viewedAt, dismissedAt);
    const hasSteps = item.stepCount > 0;
    const isUnread = item.hasRealTitle && withinWindow && hasSteps && item.updateTimeMs > effectiveReadAt + UNREAD_TIME_TOLERANCE_MS;

    if (isUnread) {
      const progress = extractTaskProgress(item.id);
      unread.push({
        ...item,
        category: 'unread',
        isUnread: true,
        progress
      });
    }
  }

  const unreadSet = new Set(unread.map(u => u.id));
  const sessions = allItems.slice(0, sessionLimit).map(item => ({
    id: item.id,
    title: item.title,
    workspaceName: item.workspaceName,
    workspacePath: item.workspacePath,
    pinned: item.pinned,
    runState: item.runState,
    isRunning: item.isRunning,
    isUnread: unreadSet.has(item.id),
    stepCount: item.stepCount,
    updateTimeMs: item.updateTimeMs,
    subagentTotal: item.subagentTotal,
    subagentRunning: item.subagentRunning
  }));

  return {
    fetchedAt: nowMs,
    apiConnected: Array.isArray(apiConversations),
    counts: {
      running: running.length,
      unread: unread.length,
      totalMonitored: running.length + unread.length,
      totalSessions: sessions.length
    },
    running,
    unread,
    sessions
  };
}

function formatLocalDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Compute 365-day activity heatmap & summary KPIs from full local SQLite history.
 * @param {{ days?: number, force?: boolean }} [options]
 */
export async function getActivityHeatmapAsync({ days = 365, force = false } = {}) {
  const spanDays = Math.max(30, Math.min(365, Number(days) || 365));
  const raw = await runNativeStatsScanAsync({ force, includeOlderHistory: true });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - (spanDays - 1));
  const todayEnd = new Date(today);
  todayEnd.setHours(23, 59, 59, 999);

  // Align grid start back to Sunday so columns represent complete weeks
  const gridStart = new Date(startDate);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());

  const startSec = Math.floor(startDate.getTime() / 1000);
  const gridStartSec = Math.floor(gridStart.getTime() / 1000);
  const endSec = Math.floor(todayEnd.getTime() / 1000);

  const dailyMap = new Map();
  const modelTotals = new Map();
  const monthlyMap = new Map();

  // Single-pass aggregation from full all_events so 365-day heatmap, KPIs, monthlyTrend, and topModels share identical scope
  if (Array.isArray(raw?.all_events)) {
    for (const ev of raw.all_events) {
      const ts = Number(ev.timestamp_seconds) || 0;
      if (ts < gridStartSec || ts > endSec) continue;

      const dObj = new Date(ts * 1000);
      const dayKey = formatLocalDateKey(dObj);
      const mName = ev.model || '未知模型';
      const inTok = Number(ev.input_tokens) || 0;
      const outTok = Number(ev.output_tokens) || 0;
      const cacheTok = Number(ev.cached_tokens) || 0;
      const totTok = Number(ev.total_tokens) || (inTok + outTok + cacheTok);
      const pricing = getModelPricing(mName);
      const evCost = pricing
        ? (inTok * pricing.input + outTok * pricing.output + cacheTok * pricing.cached) / 1e6
        : 0;

      let dCur = dailyMap.get(dayKey);
      if (!dCur) {
        dCur = { date: dayKey, totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, requests: 0, cost: 0 };
        dailyMap.set(dayKey, dCur);
      }
      dCur.totalTokens += totTok;
      dCur.inputTokens += inTok;
      dCur.outputTokens += outTok;
      dCur.cachedTokens += cacheTok;
      dCur.requests += 1;
      dCur.cost += evCost;

      if (ts >= startSec) {
        const mCur = modelTotals.get(mName) || { model: mName, totalTokens: 0, requests: 0, cost: 0 };
        mCur.totalTokens += totTok;
        mCur.requests += 1;
        mCur.cost += evCost;
        modelTotals.set(mName, mCur);

        const mKey = `${dObj.getFullYear()}-${String(dObj.getMonth() + 1).padStart(2, '0')}`;
        const monCur = monthlyMap.get(mKey) || { month: mKey, totalTokens: 0, requests: 0, cost: 0 };
        monCur.totalTokens += totTok;
        monCur.requests += 1;
        monCur.cost += evCost;
        monthlyMap.set(mKey, monCur);
      }
    }
  } else {
    // Fallback for legacy PS1 scanner without all_events
    for (const row of (raw?.daily || [])) {
      if (!row?.date) continue;
      dailyMap.set(row.date, {
        date: row.date,
        totalTokens: Number(row.total_tokens) || 0,
        inputTokens: Number(row.input_tokens) || 0,
        outputTokens: Number(row.output_tokens) || 0,
        cachedTokens: Number(row.cached_tokens) || 0,
        requests: Number(row.request_count) || 0,
        cost: Number(row.cost) || 0
      });
    }
  }

  const cells = [];
  const activeValues = [];
  let totalTokens = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let totalRequests = 0;
  let totalCost = 0;
  let totalActiveDays = 0;
  let peakDay = null;

  for (let dt = new Date(gridStart); dt <= today; dt.setDate(dt.getDate() + 1)) {
    const key = formatLocalDateKey(dt);
    const inSpan = dt >= startDate;
    const hit = dailyMap.get(key);
    const entry = {
      date: key,
      inSpan,
      totalTokens: hit?.totalTokens || 0,
      inputTokens: hit?.inputTokens || 0,
      outputTokens: hit?.outputTokens || 0,
      cachedTokens: hit?.cachedTokens || 0,
      requests: hit?.requests || 0,
      cost: hit?.cost || 0,
      level: 0
    };
    cells.push(entry);

    if (inSpan && entry.totalTokens > 0) {
      activeValues.push(entry.totalTokens);
      totalActiveDays++;
      totalTokens += entry.totalTokens;
      totalInput += entry.inputTokens;
      totalOutput += entry.outputTokens;
      totalCached += entry.cachedTokens;
      totalRequests += entry.requests;
      totalCost += entry.cost;
      if (!peakDay || entry.totalTokens > peakDay.totalTokens) {
        peakDay = {
          date: key,
          totalTokens: entry.totalTokens,
          compact: formatCompactNumber(entry.totalTokens),
          requests: entry.requests,
          cost: entry.cost
        };
      }
    }
  }

  // Assign intensity levels 1..4 by active-day quartiles
  if (activeValues.length > 0) {
    const sorted = [...activeValues].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q2 = sorted[Math.floor(sorted.length * 0.50)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    for (const c of cells) {
      if (c.totalTokens <= 0) {
        c.level = 0;
      } else if (c.totalTokens <= q1) {
        c.level = 1;
      } else if (c.totalTokens <= q2) {
        c.level = 2;
      } else if (c.totalTokens <= q3) {
        c.level = 3;
      } else {
        c.level = 4;
      }
    }
  }

  // Calculate longest streak & current streak over the span
  let longestStreak = 0;
  let run = 0;
  for (const c of cells) {
    if (!c.inSpan) continue;
    if (c.totalTokens > 0) {
      run++;
      if (run > longestStreak) longestStreak = run;
    } else {
      run = 0;
    }
  }
  let currentStreak = 0;
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i];
    if (!c.inSpan) break;
    if (c.totalTokens > 0) {
      currentStreak++;
    } else if (i === cells.length - 1) {
      // Allow today to have 0 activity yet while still counting streak ending yesterday
      continue;
    } else {
      break;
    }
  }

  const topModels = Array.from(modelTotals.values())
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 6)
    .map(m => ({
      ...m,
      compact: formatCompactNumber(m.totalTokens),
      sharePercent: totalTokens > 0 ? Math.round((m.totalTokens / totalTokens) * 1000) / 10 : 0
    }));

  const monthlyTrend = Array.from(monthlyMap.values())
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-12)
    .map(m => ({
      ...m,
      compact: formatCompactNumber(m.totalTokens)
    }));

  const cacheHitRatio = (totalInput + totalCached) > 0
    ? Math.round((totalCached / (totalInput + totalCached)) * 1000) / 10
    : 0;

  return {
    spanDays,
    startDate: formatLocalDateKey(startDate),
    endDate: formatLocalDateKey(today),
    cells,
    monthlyTrend,
    topModels,
    summary: {
      totalActiveDays,
      totalDays: spanDays,
      activeRatePercent: Math.round((totalActiveDays / spanDays) * 1000) / 10,
      currentStreak,
      longestStreak,
      totalTokens,
      totalTokensCompact: formatCompactNumber(totalTokens),
      totalInputCompact: formatCompactNumber(totalInput),
      totalOutputCompact: formatCompactNumber(totalOutput),
      totalRequests,
      totalCost,
      totalCostFormatted: `$${totalCost.toFixed(2)}`,
      cacheHitRatio,
      avgDailyActiveTokens: totalActiveDays > 0 ? Math.round(totalTokens / totalActiveDays) : 0,
      avgDailyActiveCompact: totalActiveDays > 0 ? formatCompactNumber(Math.round(totalTokens / totalActiveDays)) : '0',
      peakDay,
      topModel: topModels[0] || null,
      databasesScanned: raw?.databases_scanned || 0,
      generationsScanned: raw?.generations_scanned || 0
    }
  };
}
