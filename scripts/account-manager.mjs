/**
 * @fileoverview Account Quota & Encrypted Credential Snapshot Switcher for agy-context
 * Fetches live account plan/model quotas via Antigravity Language Server Connect-RPC,
 * automatically captures encrypted snapshots of officially signed-in accounts,
 * enables fast credential switching, and supports one-click Antigravity App restart.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import cp from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { getLanguageServerAuth } from './context-analyzer.mjs';

const DEFAULT_CRED_SERVICE = 'gemini';
const DEFAULT_CRED_ACCOUNT = 'antigravity';
const DEFAULT_WIN_TARGET = 'gemini:antigravity';
const QUOTA_CACHE_TTL_MS = 10000;
const CRED_CAPTURE_INTERVAL_MS = 15 * 60 * 1000;

let cachedQuotaState = null;
let pendingSwitchState = null;
let inFlightQuotaPromise = null;
let inFlightQuotaForce = false;
let cachedWorkingCandidate = null;
let lastCredCaptureAt = 0;
let lastCredCaptureEmail = '';
let isBackgroundCapturing = false;
const knownWeeklyResetByAccount = new Map();
const vaultLocks = new Map();

function withVaultLock(vaultDir, fn) {
  const key = path.resolve(getVaultDir(vaultDir));
  const prev = vaultLocks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => fn());
  const tail = run.catch(() => {});
  vaultLocks.set(key, tail);
  return run.finally(() => {
    if (vaultLocks.get(key) === tail) {
      vaultLocks.delete(key);
    }
  });
}

function getWindowsPowerShellExe() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Returns the persistent plugin data directory for agy-context.
 * @param {string|null} [vaultDir]
 * @returns {string}
 */
export function getVaultDir(vaultDir = null) {
  return vaultDir || path.join(os.homedir(), '.gemini', 'antigravity', 'plugin_data', 'agy-context');
}

function getVaultFilePath(vaultDir = null) {
  return path.join(getVaultDir(vaultDir), 'accounts.vault.json');
}

function getVaultKeyPath(vaultDir = null) {
  return path.join(getVaultDir(vaultDir), '.vault.key');
}

function ensureVaultDir(vaultDir = null) {
  const dir = getVaultDir(vaultDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform !== 'win32') {
      try { fs.chmodSync(dir, 0o700); } catch {}
    }
  }
  return dir;
}

function writeFileAtomic(filePath, content, mode = 0o600) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode });
    fs.renameSync(tmpPath, filePath);
    if (process.platform !== 'win32') {
      try { fs.chmodSync(filePath, mode); } catch {}
    }
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    throw err;
  }
}

/**
 * Clears the in-memory quota cache (useful after account switch or in tests).
 */
export function clearQuotaCache() {
  cachedQuotaState = null;
  cachedWorkingCandidate = null;
  inFlightQuotaPromise = null;
  inFlightQuotaForce = false;
  lastCredCaptureAt = 0;
  lastCredCaptureEmail = '';
  knownWeeklyResetByAccount.clear();
}

/**
 * Clears the pending switch guard (for tests or after confirmed restart).
 */
export function clearPendingSwitchState() {
  pendingSwitchState = null;
}

/**
 * Computes a stable short ID for an account email.
 * @param {string} email
 * @returns {string}
 */
export function computeAccountId(email) {
  return crypto.createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * Normalizes a fraction [0..1] or percentage [0..100] safely, preserving exact 0.
 * @param {*} rawFraction
 * @returns {number|null}
 */
function normalizeFraction(rawFraction) {
  if (rawFraction === null || rawFraction === undefined || rawFraction === '') return null;
  const num = Number(rawFraction);
  if (!Number.isFinite(num)) return null;
  if (num < 0) return 0;
  if (num > 1 && num <= 100) return num / 100;
  if (num > 100) return 1;
  return num;
}

function classifyModelGroup(id, label, explicitGroup) {
  if (explicitGroup && typeof explicitGroup === 'string') return explicitGroup;
  const lower = `${id} ${label}`.toLowerCase();
  if (lower.includes('claude') || lower.includes('opus') || lower.includes('sonnet')) return 'claude';
  if (lower.includes('gpt') || lower.includes('oss')) return 'gpt';
  if (lower.includes('gemini')) return 'gemini';
  return 'other';
}

function parseCreditsObject(us) {
  const planStatus = us.planStatus || {};
  const planInfo = planStatus.planInfo || {};
  const available =
    typeof planStatus.availablePromptCredits === 'number' ? planStatus.availablePromptCredits :
    typeof us.availableCredits === 'number' ? us.availableCredits :
    typeof us.aiCredits?.available === 'number' ? us.aiCredits.available :
    typeof us.aiCredits === 'number' ? us.aiCredits :
    null;

  const monthly =
    typeof planInfo.monthlyPromptCredits === 'number' ? planInfo.monthlyPromptCredits :
    typeof us.aiCredits?.monthly === 'number' ? us.aiCredits.monthly :
    null;

  const flowAvailable =
    typeof planStatus.availableFlowCredits === 'number' ? planStatus.availableFlowCredits : null;
  const flowMonthly =
    typeof planInfo.monthlyFlowCredits === 'number' ? planInfo.monthlyFlowCredits : null;

  if (available === null && monthly === null && flowAvailable === null && flowMonthly === null) {
    return null;
  }

  return {
    available,
    monthly,
    flowAvailable,
    flowMonthly
  };
}

/**
 * Defensively parses LanguageServerService/GetUserStatus JSON into a stable normalized structure.
 * Handles varied response shapes and preserves remainingFraction === 0 as 0%.
 * @param {object} raw
 * @returns {object}
 */
export function parseUserStatusResponse(raw) {
  const root = raw && typeof raw === 'object' ? raw : {};
  const us = (root.userStatus && typeof root.userStatus === 'object') ? root.userStatus : root;

  const email = String(
    us.email ||
    us.userEmail ||
    us.accountEmail ||
    us.profile?.email ||
    ''
  ).trim();

  const name = String(
    us.name ||
    us.displayName ||
    us.profile?.name ||
    (email ? email.split('@')[0] : '')
  ).trim();

  const planInfo = us.planStatus?.planInfo || {};
  const userTier = us.userTier || {};
  const planName = String(
    planInfo.planName ||
    planInfo.teamsTier ||
    userTier.name ||
    userTier.id ||
    planInfo.planType ||
    ''
  ).trim();

  const planTier = String(
    userTier.id ||
    planInfo.planType ||
    planInfo.teamsTier ||
    ''
  ).trim();

  const credits = parseCreditsObject(us);

  const rawConfigs = Array.isArray(us.cascadeModelConfigData?.clientModelConfigs)
    ? us.cascadeModelConfigData.clientModelConfigs
    : Array.isArray(us.clientModelConfigs)
      ? us.clientModelConfigs
      : Array.isArray(us.cascadeModelConfigs)
        ? us.cascadeModelConfigs
        : [];

  const rawGroups = Array.isArray(us.modelQuotaGroups)
    ? us.modelQuotaGroups
    : Array.isArray(us.quotaGroups)
      ? us.quotaGroups
      : [];

  const models = [];
  const seenKeys = new Set();

  for (const item of rawConfigs) {
    if (!item || typeof item !== 'object') continue;
    const quota = item.quotaInfo || item.quota || null;
    if (!quota || typeof quota !== 'object') continue;

    const frac = normalizeFraction(
      quota.remainingFraction !== undefined ? quota.remainingFraction : quota.remainingPercentage
    );
    if (frac === null) continue;

    const id = String(
      item.modelOrAlias?.model ||
      item.modelOrAlias?.alias ||
      item.modelId ||
      item.model ||
      item.id ||
      item.label ||
      ''
    ).trim();
    const label = String(item.label || item.displayName || item.name || id || 'Unknown Model').trim();
    const dedupeKey = (id || label).toLowerCase();
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);

    const remainingPercent = Math.round(frac * 100);
    const resetTime = quota.resetTime || quota.quotaResetTime || quota.nextResetTime || null;
    const groupKey = classifyModelGroup(id, label, item.quotaGroup || item.groupName);

    // Extract optional embedded secondary/weekly quota window if present on clientModelConfig
    const rawWeeklyQuota = quota.weeklyQuota || quota.weeklyLimit || quota.secondaryQuota || item.weeklyQuota || null;
    let weeklyWindow = rawWeeklyQuota ? normalizeWindowEntry(rawWeeklyQuota) : null;
    if (!weeklyWindow && quota.weeklyRemainingFraction !== undefined) {
      const wFrac = normalizeFraction(quota.weeklyRemainingFraction);
      if (wFrac !== null) {
        const wReset = quota.weeklyResetTime || quota.weeklyQuotaResetTime || null;
        weeklyWindow = {
          remainingFraction: wFrac,
          remainingPercent: Math.round(wFrac * 100),
          resetTime: wReset ? String(wReset) : null,
          isExhausted: wFrac <= 0
        };
      }
    }

    models.push({
      id: id || label,
      label,
      remainingFraction: frac,
      remainingPercent,
      resetTime: resetTime ? String(resetTime) : null,
      isExhausted: frac <= 0,
      groupKey,
      ...(weeklyWindow ? { weeklyWindow } : {}),
      ...(Array.isArray(quota.buckets || quota.windows || quota.limits) ? { quotaBuckets: quota.buckets || quota.windows || quota.limits } : {})
    });
  }

  if (models.length === 0 && rawGroups.length > 0) {
    for (const grp of rawGroups) {
      if (!grp || typeof grp !== 'object') continue;
      const quota = grp.quotaInfo || grp.quota || grp;
      const frac = normalizeFraction(
        quota.remainingFraction !== undefined ? quota.remainingFraction : quota.remainingPercentage
      );
      if (frac === null) continue;

      const id = String(grp.groupId || grp.id || grp.name || grp.label || '').trim();
      const label = String(grp.label || grp.displayName || grp.name || id || 'Model Group').trim();
      const dedupeKey = (id || label).toLowerCase();
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);

      const remainingPercent = Math.round(frac * 100);
      const resetTime = quota.resetTime || quota.quotaResetTime || quota.nextResetTime || null;

      models.push({
        id: id || label,
        label,
        remainingFraction: frac,
        remainingPercent,
        resetTime: resetTime ? String(resetTime) : null,
        isExhausted: frac <= 0,
        groupKey: classifyModelGroup(id, label, grp.groupKey)
      });
    }
  }

  const trackedModels = models.length;
  const minRemainingPercent = trackedModels > 0
    ? Math.min(...models.map(m => m.remainingPercent))
    : null;
  const exhaustedCount = models.filter(m => m.isExhausted).length;

  return {
    account: {
      email,
      name,
      planName,
      planTier
    },
    credits,
    models,
    summary: {
      totalModels: rawConfigs.length || rawGroups.length || trackedModels,
      trackedModels,
      minRemainingPercent,
      exhaustedCount
    }
  };
}

function parseDurationSeconds(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw === 'string') {
    const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks)?$/i);
    if (!m) return null;
    const val = Number(m[1]);
    if (!Number.isFinite(val) || val <= 0) return null;
    const unit = (m[2] || 's').toLowerCase();
    if (unit.startsWith('w')) return val * 7 * 86400;
    if (unit.startsWith('d')) return val * 86400;
    if (unit.startsWith('h')) return val * 3600;
    if (unit.startsWith('m')) return val * 60;
    return val;
  }
  if (raw && typeof raw === 'object' && raw.seconds !== undefined) {
    const sec = Number(raw.seconds);
    return Number.isFinite(sec) && sec > 0 ? sec : null;
  }
  return null;
}

function classifyWindowExplicit(bucket, groupKey = '', knownWeeklyMap = null) {
  const durCandidates = [
    bucket.windowDurationSeconds,
    bucket.durationSeconds,
    bucket.windowSeconds,
    bucket.periodSeconds,
    bucket.windowDuration,
    bucket.duration,
    bucket.resetIntervalSeconds,
    bucket.quotaInfo?.windowDurationSeconds,
    bucket.quotaInfo?.windowDuration
  ];
  for (const dc of durCandidates) {
    const sec = parseDurationSeconds(dc);
    if (sec !== null) {
      if (sec >= 86400) return 'weekly';
      if (sec <= 28800) return 'fiveHour';
    }
  }

  const hint = `${bucket.window || ''} ${bucket.windowType || ''} ${bucket.quotaType || ''} ${bucket.period || ''} ${bucket.type || ''} ${bucket.id || ''} ${bucket.bucketId || ''} ${bucket.displayName || ''} ${bucket.name || ''} ${bucket.label || ''}`.toLowerCase();
  if (/week|7d|168h|weekly|long_?term/.test(hint)) return 'weekly';
  if (/5h|5-?hour|five|session|hourly|short_?term/.test(hint)) return 'fiveHour';

  const resetIso = bucket.resetTime || bucket.quotaResetTime || bucket.nextResetTime || bucket.quotaInfo?.resetTime || null;
  if (resetIso && groupKey && knownWeeklyMap && knownWeeklyMap.has(groupKey)) {
    const ms = Date.parse(resetIso);
    const knownMs = knownWeeklyMap.get(groupKey);
    if (Number.isFinite(ms) && Math.abs(ms - knownMs) <= 10 * 60 * 1000) {
      return 'weekly';
    }
  }

  return null;
}

function classifyWindowType(bucket, groupKey = '', knownWeeklyMap = null) {
  const explicit = classifyWindowExplicit(bucket, groupKey, knownWeeklyMap);
  if (explicit) return explicit;
  const resetIso = bucket.resetTime || bucket.quotaResetTime || bucket.nextResetTime || bucket.quotaInfo?.resetTime || null;
  if (resetIso) {
    const ms = Date.parse(resetIso);
    if (Number.isFinite(ms)) {
      return (ms - Date.now()) > (12 * 3600 * 1000) ? 'weekly' : 'fiveHour';
    }
  }
  return 'fiveHour';
}

function normalizeWindowEntry(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const frac = normalizeFraction(
    bucket.remainingFraction !== undefined
      ? bucket.remainingFraction
      : (bucket.remainingPercentage !== undefined ? bucket.remainingPercentage : bucket.quotaInfo?.remainingFraction)
  );
  if (frac === null) return null;
  const resetTime = bucket.resetTime || bucket.quotaResetTime || bucket.nextResetTime || bucket.quotaInfo?.resetTime || null;
  return {
    remainingFraction: frac,
    remainingPercent: Math.round(frac * 100),
    resetTime: resetTime ? String(resetTime) : null,
    isExhausted: frac <= 0
  };
}

/**
 * Parses RetrieveUserQuotaSummary (or embedded quotaSummary) into the official 2-group structure:
 * Gemini Models & Claude and GPT models, each with weekly and fiveHour windows.
 * @param {object} raw
 * @param {Map<string, number>|null} [knownWeeklyMap=null]
 * @returns {Array<{key: string, title: string, weekly: object|null, fiveHour: object|null}>}
 */
export function parseQuotaSummaryResponse(raw, knownWeeklyMap = null) {
  const root = raw && typeof raw === 'object' ? raw : {};
  const groupsRaw =
    Array.isArray(root.groups) ? root.groups :
    Array.isArray(root.quotaGroups) ? root.quotaGroups :
    Array.isArray(root.modelQuotaGroups) ? root.modelQuotaGroups :
    Array.isArray(root.quotaSummary?.groups) ? root.quotaSummary.groups :
    Array.isArray(root.quotaSummary?.quotaGroups) ? root.quotaSummary.quotaGroups :
    Array.isArray(root.userQuotaSummary?.groups) ? root.userQuotaSummary.groups :
    Array.isArray(root.userQuotaSummary?.quotaGroups) ? root.userQuotaSummary.quotaGroups :
    Array.isArray(root.response?.groups) ? root.response.groups :
    Array.isArray(root.summary?.groups) ? root.summary.groups :
    Array.isArray(root.userStatus?.modelQuotaGroups) ? root.userStatus.modelQuotaGroups :
    Array.isArray(root.userStatus?.quotaGroups) ? root.userStatus.quotaGroups :
    [];

  if (groupsRaw.length === 0) return [];

  const bucketsByKey = {
    gemini: { key: 'gemini', title: 'Gemini Models', weekly: null, fiveHour: null },
    claude_gpt: { key: 'claude_gpt', title: 'Claude and GPT models', weekly: null, fiveHour: null }
  };

  for (const grp of groupsRaw) {
    if (!grp || typeof grp !== 'object') continue;
    const grpBuckets = Array.isArray(grp.buckets)
      ? grp.buckets
      : Array.isArray(grp.limits)
        ? grp.limits
        : Array.isArray(grp.windows)
          ? grp.windows
          : Array.isArray(grp.quotaBuckets)
            ? grp.quotaBuckets
            : Array.isArray(grp.rateLimits)
              ? grp.rateLimits
              : Array.isArray(grp.quotas)
                ? grp.quotas
                : [];

    const bucketText = grpBuckets.map(b => `${b?.id || ''} ${b?.bucketId || ''} ${b?.displayName || ''} ${b?.name || ''}`).join(' ');
    const grpHint = `${grp.id || ''} ${grp.groupId || ''} ${grp.key || ''} ${grp.displayName || ''} ${grp.name || ''} ${grp.label || ''} ${bucketText}`.toLowerCase();

    let targetKey = null;
    if (/3p|claude|gpt|partner|third|anthropic|openai/.test(grpHint)) {
      targetKey = 'claude_gpt';
    } else if (/gemini|1p|google/.test(grpHint)) {
      targetKey = 'gemini';
    } else {
      continue;
    }

    const target = bucketsByKey[targetKey];
    const mergeWindow = (winType, winObj) => {
      if (!winObj) return;
      if (!target[winType] || winObj.remainingPercent < target[winType].remainingPercent) {
        target[winType] = winObj;
      }
      if (winType === 'weekly' && winObj.resetTime && knownWeeklyMap) {
        const ms = Date.parse(winObj.resetTime);
        if (Number.isFinite(ms)) knownWeeklyMap.set(targetKey, ms);
      }
    };

    const explicitWeekly = grp.weekly || grp.weeklyLimit || grp.weeklyQuota || grp.longTermLimit || null;
    const explicitFiveHour = grp.fiveHour || grp.fiveHourLimit || grp.session || grp.sessionLimit || grp.shortTermLimit || null;
    if (explicitWeekly) mergeWindow('weekly', normalizeWindowEntry(explicitWeekly));
    if (explicitFiveHour) mergeWindow('fiveHour', normalizeWindowEntry(explicitFiveHour));

    if (grpBuckets.length > 0) {
      const normalizedEntries = [];
      for (const b of grpBuckets) {
        const winObj = normalizeWindowEntry(b);
        if (!winObj) continue;
        const explicitType = classifyWindowExplicit(b, targetKey, knownWeeklyMap);
        const resetMs = winObj.resetTime ? Date.parse(winObj.resetTime) : NaN;
        normalizedEntries.push({ b, winObj, explicitType, resetMs });
      }

      const ambiguous = normalizedEntries.filter(e => !e.explicitType);
      if (ambiguous.length >= 2) {
        const withReset = ambiguous.filter(e => Number.isFinite(e.resetMs)).sort((a, b) => a.resetMs - b.resetMs);
        if (withReset.length >= 2 && withReset[withReset.length - 1].resetMs > withReset[0].resetMs) {
          withReset[0].inferredType = 'fiveHour';
          withReset[withReset.length - 1].inferredType = 'weekly';
        }
      }

      for (const item of normalizedEntries) {
        const winType = item.explicitType || item.inferredType || classifyWindowType(item.b, targetKey, knownWeeklyMap);
        mergeWindow(winType, item.winObj);
      }
    } else if (!explicitWeekly && !explicitFiveHour) {
      const single = normalizeWindowEntry(grp);
      if (single) {
        mergeWindow(classifyWindowType(grp, targetKey, knownWeeklyMap), single);
      }
    }
  }

  return ['gemini', 'claude_gpt']
    .map(k => bucketsByKey[k])
    .filter(g => g.weekly || g.fiveHour);
}

/**
 * Fallback builder that groups GetUserStatus clientModelConfigs into official
 * Gemini Models and Claude and GPT models buckets with weekly / 5h windows.
 * @param {Array} models
 * @param {Map<string, number>|null} [knownWeeklyMap=null]
 * @returns {Array<{key: string, title: string, weekly: object|null, fiveHour: object|null}>}
 */
export function buildQuotaGroupsFromModels(models, knownWeeklyMap = null) {
  if (!Array.isArray(models) || models.length === 0) return [];

  const groupDefs = [
    { key: 'gemini', title: 'Gemini Models', items: [] },
    { key: 'claude_gpt', title: 'Claude and GPT models', items: [] }
  ];

  for (const m of models) {
    if (!m || typeof m !== 'object') continue;
    const hint = `${m.groupKey || ''} ${m.id || ''} ${m.label || ''}`.toLowerCase();
    if (m.groupKey === 'claude' || m.groupKey === 'gpt' || /claude|gpt|opus|sonnet|oss/.test(hint)) {
      groupDefs[1].items.push(m);
    } else if (m.groupKey === 'gemini' || /gemini/.test(hint)) {
      groupDefs[0].items.push(m);
    }
  }

  const pickMinWindow = (items) => {
    if (!items || items.length === 0) return null;
    let best = items[0];
    for (const item of items) {
      if (item.remainingPercent < best.remainingPercent) {
        best = item;
      }
    }
    return {
      remainingFraction: best.remainingFraction,
      remainingPercent: best.remainingPercent,
      resetTime: best.resetTime || null,
      isExhausted: best.remainingFraction <= 0
    };
  };

  const result = [];
  for (const def of groupDefs) {
    if (def.items.length === 0) continue;
    const weeklyItems = [];
    const fiveHourItems = [];
    for (const m of def.items) {
      if (m.weeklyWindow) {
        weeklyItems.push(m.weeklyWindow);
      }
      if (Array.isArray(m.quotaBuckets)) {
        for (const b of m.quotaBuckets) {
          const w = normalizeWindowEntry(b);
          if (!w) continue;
          if (classifyWindowType(b, def.key, knownWeeklyMap) === 'weekly') weeklyItems.push(w);
          else fiveHourItems.push(w);
        }
      }
      const winType = classifyWindowType({ id: m.id, displayName: m.label, resetTime: m.resetTime }, def.key, knownWeeklyMap);
      if (winType === 'weekly') weeklyItems.push(m);
      else fiveHourItems.push(m);
    }
    const weekly = pickMinWindow(weeklyItems);
    const fiveHour = pickMinWindow(fiveHourItems);
    if (weekly && weekly.resetTime && knownWeeklyMap) {
      const ms = Date.parse(weekly.resetTime);
      if (Number.isFinite(ms)) knownWeeklyMap.set(def.key, ms);
    }
    if (weekly || fiveHour) {
      result.push({ key: def.key, title: def.title, weekly, fiveHour });
    }
  }

  return result;
}

function mergeMissingQuotaGroups(primary, supplement) {
  if (!Array.isArray(primary) || primary.length === 0) return supplement || [];
  if (!Array.isArray(supplement) || supplement.length === 0) return primary;
  const byKey = new Map(primary.map(g => [g.key, { ...g }]));
  for (const s of supplement) {
    const existing = byKey.get(s.key);
    if (!existing) {
      byKey.set(s.key, s);
    } else {
      if (!existing.weekly && s.weekly) existing.weekly = s.weekly;
      if (!existing.fiveHour && s.fiveHour) existing.fiveHour = s.fiveHour;
    }
  }
  return ['gemini', 'claude_gpt'].map(k => byKey.get(k)).filter(Boolean);
}

function buildSanitizedSchema(val, depth = 0) {
  if (val === null) return 'null';
  if (Array.isArray(val)) {
    if (val.length === 0) return 'Array(0)';
    return depth >= 4 ? `Array(${val.length})` : [buildSanitizedSchema(val[0], depth + 1)];
  }
  if (typeof val === 'object') {
    if (depth >= 4) return 'Object';
    const out = {};
    for (const k of Object.keys(val)) {
      if (/token|secret|password|email|key/i.test(k)) {
        out[k] = `<redacted:${typeof val[k]}>`;
      } else {
        out[k] = buildSanitizedSchema(val[k], depth + 1);
      }
    }
    return out;
  }
  if (typeof val === 'string') return `string(${val.length})`;
  return typeof val;
}

/**
 * Calls a LanguageServerService Connect-RPC method on a single candidate.
 * @param {{port: number, protocol?: string, csrf: string}} candidate
 * @param {string} methodName
 * @param {object} [payloadObj]
 * @param {number} [timeoutMs=3500]
 * @returns {Promise<object>}
 */
function callLanguageServerRpc(candidate, methodName, payloadObj = {}, timeoutMs = 3500) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(payloadObj || {});

    const client = candidate.protocol === 'https' ? https : http;
    const req = client.request({
      hostname: '127.0.0.1',
      port: candidate.port,
      path: `/exa.language_server_pb.LanguageServerService/${methodName}`,
      method: 'POST',
      rejectUnauthorized: false,
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': candidate.csrf || '',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          return reject(new Error(`${methodName} HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(body || '{}'));
        } catch (err) {
          reject(new Error(`${methodName} invalid JSON: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`${methodName} timeout`));
    });
    req.write(payload);
    req.end();
  });
}

// ============================================================================
// Cross-Platform OS Credential Adapter (Zero External Dependencies)
// ============================================================================

const WIN_CRED_PS_READ = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class AgyWinCredRead {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", EntryPoint = "CredEnumerateW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredEnumerate(string filter, UInt32 flags, out UInt32 count, out IntPtr credentialsPtr);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);

  public static string ReadJson(string primaryTarget) {
    IntPtr credPtr = IntPtr.Zero;
    try {
      if (!CredRead(primaryTarget, 1, 0, out credPtr)) {
        UInt32 count = 0;
        IntPtr listPtr = IntPtr.Zero;
        if (CredEnumerate("gemini:*", 0, out count, out listPtr) && listPtr != IntPtr.Zero) {
          try {
            for (int i = 0; i < count; i++) {
              IntPtr itemPtr = Marshal.ReadIntPtr(listPtr, i * IntPtr.Size);
              if (itemPtr == IntPtr.Zero) continue;
              CREDENTIAL c = Marshal.PtrToStructure<CREDENTIAL>(itemPtr);
              string tName = c.TargetName != IntPtr.Zero ? Marshal.PtrToStringUni(c.TargetName) : "";
              if (tName.IndexOf("antigravity", StringComparison.OrdinalIgnoreCase) >= 0) {
                return FormatCred(c);
              }
            }
          } finally {
            CredFree(listPtr);
          }
        }
        return "{\\"found\\":false}";
      }
      CREDENTIAL cred = Marshal.PtrToStructure<CREDENTIAL>(credPtr);
      return FormatCred(cred);
    } finally {
      if (credPtr != IntPtr.Zero) CredFree(credPtr);
    }
  }

  private static string FormatCred(CREDENTIAL cred) {
    byte[] blob = new byte[cred.CredentialBlobSize];
    if (cred.CredentialBlobSize > 0 && cred.CredentialBlob != IntPtr.Zero) {
      Marshal.Copy(cred.CredentialBlob, blob, 0, (int)cred.CredentialBlobSize);
    }
    string tName = cred.TargetName != IntPtr.Zero ? Marshal.PtrToStringUni(cred.TargetName) : "";
    string uName = cred.UserName != IntPtr.Zero ? Marshal.PtrToStringUni(cred.UserName) : "";
    string b64 = Convert.ToBase64String(blob);
    return "{\\"found\\":true,\\"targetName\\":\\"" + Escape(tName) + "\\",\\"userName\\":\\"" + Escape(uName) + "\\",\\"persist\\":" + cred.Persist + ",\\"blobBase64\\":\\"" + b64 + "\\"}";
  }

  private static string Escape(string s) {
    if (s == null) return "";
    return s.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"");
  }
}
"@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[AgyWinCredRead]::ReadJson('${DEFAULT_WIN_TARGET}')
`;

const WIN_CRED_PS_WRITE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$rawInput = [Console]::In.ReadToEnd()
$payload = $rawInput | ConvertFrom-Json
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class AgyWinCredWrite {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite(ref CREDENTIAL userCredential, UInt32 flags);

  public static void WriteBlob(string targetName, string userName, UInt32 persist, string blobBase64) {
    byte[] blob = string.IsNullOrEmpty(blobBase64) ? new byte[0] : Convert.FromBase64String(blobBase64);
    IntPtr targetPtr = IntPtr.Zero;
    IntPtr userPtr = IntPtr.Zero;
    IntPtr blobPtr = IntPtr.Zero;
    try {
      targetPtr = Marshal.StringToHGlobalUni(targetName);
      userPtr = string.IsNullOrEmpty(userName) ? IntPtr.Zero : Marshal.StringToHGlobalUni(userName);
      if (blob.Length > 0) {
        blobPtr = Marshal.AllocHGlobal(blob.Length);
        Marshal.Copy(blob, 0, blobPtr, blob.Length);
      }
      CREDENTIAL cred = new CREDENTIAL();
      cred.Flags = 0;
      cred.Type = 1;
      cred.TargetName = targetPtr;
      cred.Comment = IntPtr.Zero;
      cred.CredentialBlobSize = (UInt32)blob.Length;
      cred.CredentialBlob = blobPtr;
      cred.Persist = persist > 0 ? persist : 2;
      cred.AttributeCount = 0;
      cred.Attributes = IntPtr.Zero;
      cred.TargetAlias = IntPtr.Zero;
      cred.UserName = userPtr;

      if (!CredWrite(ref cred, 0)) {
        int err = Marshal.GetLastWin32Error();
        throw new System.ComponentModel.Win32Exception(err, "CredWriteW failed with Win32 error " + err);
      }
    } finally {
      if (targetPtr != IntPtr.Zero) Marshal.FreeHGlobal(targetPtr);
      if (userPtr != IntPtr.Zero) Marshal.FreeHGlobal(userPtr);
      if (blobPtr != IntPtr.Zero) Marshal.FreeHGlobal(blobPtr);
    }
  }
}
"@
$t = if ($payload.targetName) { [string]$payload.targetName } else { '${DEFAULT_WIN_TARGET}' }
$u = if ($payload.userName) { [string]$payload.userName } else { '${DEFAULT_CRED_ACCOUNT}' }
$p = if ($payload.persist) { [UInt32]$payload.persist } else { [UInt32]2 }
$b = [string]$payload.blobBase64
[AgyWinCredWrite]::WriteBlob($t, $u, $p, $b)
Write-Output '{"written":true}'
`;

function runPowerShellEncoded(script, stdinData = null, timeoutMs = 8000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return cp.execFileSync(
    process.platform === 'win32' ? getWindowsPowerShellExe() : 'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      input: stdinData,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true
    }
  ).trim();
}

function runPowerShellEncodedAsync(script, stdinData = null, timeoutMs = 10000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const psExe = process.platform === 'win32' ? getWindowsPowerShellExe() : 'powershell.exe';
  return new Promise((resolve, reject) => {
    const child = cp.execFile(
      psExe,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message || 'PowerShell failed').trim();
          return reject(new Error(detail));
        }
        resolve(String(stdout || '').trim());
      }
    );
    if (child.stdin) {
      if (stdinData !== null && stdinData !== undefined) {
        child.stdin.end(stdinData);
      } else {
        child.stdin.end();
      }
    }
  });
}

const WIN_CRED_PS_SWITCH_BATCH = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Security
$rawInput = [Console]::In.ReadToEnd()
$payload = $rawInput | ConvertFrom-Json
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class AgyWinCredBatch {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", EntryPoint = "CredEnumerateW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredEnumerate(string filter, UInt32 flags, out UInt32 count, out IntPtr credentialsPtr);

  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite(ref CREDENTIAL userCredential, UInt32 flags);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);

  public static string ReadJson(string primaryTarget) {
    IntPtr credPtr = IntPtr.Zero;
    try {
      if (!CredRead(primaryTarget, 1, 0, out credPtr)) {
        UInt32 count = 0;
        IntPtr listPtr = IntPtr.Zero;
        if (CredEnumerate("gemini:*", 0, out count, out listPtr) && listPtr != IntPtr.Zero) {
          try {
            for (int i = 0; i < count; i++) {
              IntPtr itemPtr = Marshal.ReadIntPtr(listPtr, i * IntPtr.Size);
              if (itemPtr == IntPtr.Zero) continue;
              CREDENTIAL c = Marshal.PtrToStructure<CREDENTIAL>(itemPtr);
              string tName = c.TargetName != IntPtr.Zero ? Marshal.PtrToStringUni(c.TargetName) : "";
              if (tName.IndexOf("antigravity", StringComparison.OrdinalIgnoreCase) >= 0) {
                return FormatCred(c);
              }
            }
          } finally {
            CredFree(listPtr);
          }
        }
        return "{\\"found\\":false}";
      }
      CREDENTIAL cred = Marshal.PtrToStructure<CREDENTIAL>(credPtr);
      return FormatCred(cred);
    } finally {
      if (credPtr != IntPtr.Zero) CredFree(credPtr);
    }
  }

  public static void WriteBlob(string targetName, string userName, UInt32 persist, byte[] blob) {
    if (blob == null) blob = new byte[0];
    IntPtr targetPtr = IntPtr.Zero;
    IntPtr userPtr = IntPtr.Zero;
    IntPtr blobPtr = IntPtr.Zero;
    try {
      targetPtr = Marshal.StringToHGlobalUni(targetName);
      userPtr = string.IsNullOrEmpty(userName) ? IntPtr.Zero : Marshal.StringToHGlobalUni(userName);
      if (blob.Length > 0) {
        blobPtr = Marshal.AllocHGlobal(blob.Length);
        Marshal.Copy(blob, 0, blobPtr, blob.Length);
      }
      CREDENTIAL cred = new CREDENTIAL();
      cred.Flags = 0;
      cred.Type = 1;
      cred.TargetName = targetPtr;
      cred.Comment = IntPtr.Zero;
      cred.CredentialBlobSize = (UInt32)blob.Length;
      cred.CredentialBlob = blobPtr;
      cred.Persist = persist > 0 ? persist : 2;
      cred.AttributeCount = 0;
      cred.Attributes = IntPtr.Zero;
      cred.TargetAlias = IntPtr.Zero;
      cred.UserName = userPtr;

      if (!CredWrite(ref cred, 0)) {
        int err = Marshal.GetLastWin32Error();
        throw new System.ComponentModel.Win32Exception(err, "CredWriteW failed with Win32 error " + err);
      }
    } finally {
      if (targetPtr != IntPtr.Zero) Marshal.FreeHGlobal(targetPtr);
      if (userPtr != IntPtr.Zero) Marshal.FreeHGlobal(userPtr);
      if (blobPtr != IntPtr.Zero) Marshal.FreeHGlobal(blobPtr);
    }
  }

  private static string FormatCred(CREDENTIAL cred) {
    byte[] blob = new byte[cred.CredentialBlobSize];
    if (cred.CredentialBlobSize > 0 && cred.CredentialBlob != IntPtr.Zero) {
      Marshal.Copy(cred.CredentialBlob, blob, 0, (int)cred.CredentialBlobSize);
    }
    string tName = cred.TargetName != IntPtr.Zero ? Marshal.PtrToStringUni(cred.TargetName) : "";
    string uName = cred.UserName != IntPtr.Zero ? Marshal.PtrToStringUni(cred.UserName) : "";
    string b64 = Convert.ToBase64String(blob);
    return "{\\"found\\":true,\\"targetName\\":\\"" + Escape(tName) + "\\",\\"userName\\":\\"" + Escape(uName) + "\\",\\"persist\\":" + cred.Persist + ",\\"blobBase64\\":\\"" + b64 + "\\"}";
  }

  private static string Escape(string s) {
    if (s == null) return "";
    return s.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"");
  }
}
"@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$outgoingResult = $null
if ($payload.checkCurrent) {
  $primaryT = if ($payload.primaryTarget) { [string]$payload.primaryTarget } else { '${DEFAULT_WIN_TARGET}' }
  $curObj = [AgyWinCredBatch]::ReadJson($primaryT) | ConvertFrom-Json
  if ($curObj.found -and $curObj.blobBase64) {
    $curBytes = [Convert]::FromBase64String([string]$curObj.blobBase64)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $hashBytes = $sha.ComputeHash($curBytes)
    } finally {
      $sha.Dispose()
    }
    $curHash = ([BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
    if ($payload.rejectHash -and $curHash -eq [string]$payload.rejectHash) {
      @{ ok = $false; reason = 'duplicate_credential_hash'; currentHash = $curHash } | ConvertTo-Json -Compress
      exit 0
    }
    $protectedB64 = ''
    $rawB64Out = ''
    if ($payload.captureOutgoing) {
      if ($payload.preferDpapi) {
        $protBytes = [System.Security.Cryptography.ProtectedData]::Protect($curBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        $protectedB64 = [Convert]::ToBase64String($protBytes)
      } else {
        $rawB64Out = [string]$curObj.blobBase64
      }
    }
    $outgoingResult = @{
      found = $true
      targetName = [string]$curObj.targetName
      userName = [string]$curObj.userName
      persist = [UInt32]$curObj.persist
      credentialHash = $curHash
      protectedBase64 = $protectedB64
      rawBase64 = $rawB64Out
    }
  } else {
    $outgoingResult = @{ found = $false }
  }
}

$targetBytes = $null
if ($payload.targetScheme -eq 'win-dpapi-v1') {
  $protBytes = [Convert]::FromBase64String([string]$payload.targetData)
  $targetBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
} else {
  $targetBytes = [Convert]::FromBase64String([string]$payload.targetBlobBase64)
}

$tName = if ($payload.targetName) { [string]$payload.targetName } else { '${DEFAULT_WIN_TARGET}' }
$uName = if ($payload.userName) { [string]$payload.userName } else { '${DEFAULT_CRED_ACCOUNT}' }
$persist = if ($payload.persist) { [UInt32]$payload.persist } else { [UInt32]2 }
[AgyWinCredBatch]::WriteBlob($tName, $uName, $persist, $targetBytes)

@{
  ok = $true
  written = $true
  outgoing = $outgoingResult
} | ConvertTo-Json -Compress -Depth 4
`;

/**
 * Creates the default OS credential adapter for Windows, macOS, or Linux.
 * Supports dependency injection via options in unit tests.
 */
export function createDefaultCredentialAdapter() {
  const platform = process.platform;

  if (platform === 'win32') {
    return {
      platform,
      supported: true,
      read() {
        const out = runPowerShellEncoded(WIN_CRED_PS_READ, null, 8000);
        const parsed = JSON.parse(out || '{"found":false}');
        if (!parsed.found) return { found: false };
        return {
          found: true,
          targetName: parsed.targetName || DEFAULT_WIN_TARGET,
          userName: parsed.userName || DEFAULT_CRED_ACCOUNT,
          persist: parsed.persist || 2,
          blobBase64: parsed.blobBase64 || ''
        };
      },
      async readAsync() {
        const out = await runPowerShellEncodedAsync(WIN_CRED_PS_READ, null, 8000);
        const parsed = JSON.parse(out || '{"found":false}');
        if (!parsed.found) return { found: false };
        return {
          found: true,
          targetName: parsed.targetName || DEFAULT_WIN_TARGET,
          userName: parsed.userName || DEFAULT_CRED_ACCOUNT,
          persist: parsed.persist || 2,
          blobBase64: parsed.blobBase64 || ''
        };
      },
      write(cred) {
        const payload = JSON.stringify({
          targetName: cred.targetName || DEFAULT_WIN_TARGET,
          userName: cred.userName || DEFAULT_CRED_ACCOUNT,
          persist: cred.persist || 2,
          blobBase64: cred.blobBase64 || ''
        });
        runPowerShellEncoded(WIN_CRED_PS_WRITE, payload, 8000);
        return { written: true };
      },
      async writeAsync(cred) {
        const payload = JSON.stringify({
          targetName: cred.targetName || DEFAULT_WIN_TARGET,
          userName: cred.userName || DEFAULT_CRED_ACCOUNT,
          persist: cred.persist || 2,
          blobBase64: cred.blobBase64 || ''
        });
        await runPowerShellEncodedAsync(WIN_CRED_PS_WRITE, payload, 8000);
        return { written: true };
      }
    };
  }

  if (platform === 'darwin') {
    return {
      platform,
      supported: true,
      read() {
        try {
          const raw = cp.execFileSync(
            'security',
            ['find-generic-password', '-s', DEFAULT_CRED_SERVICE, '-a', DEFAULT_CRED_ACCOUNT, '-w'],
            { encoding: 'utf8', timeout: 5000 }
          );
          const trimmed = raw.replace(/\r?\n$/, '');
          const buf = /^0x[0-9a-fA-F]+$/.test(trimmed)
            ? Buffer.from(trimmed.slice(2), 'hex')
            : Buffer.from(trimmed, 'utf8');
          return {
            found: true,
            targetName: `${DEFAULT_CRED_SERVICE}:${DEFAULT_CRED_ACCOUNT}`,
            userName: DEFAULT_CRED_ACCOUNT,
            persist: 2,
            blobBase64: buf.toString('base64')
          };
        } catch (err) {
          return { found: false };
        }
      },
      write(cred) {
        const hex = Buffer.from(cred.blobBase64 || '', 'base64').toString('hex');
        const cmd = `add-generic-password -U -s ${DEFAULT_CRED_SERVICE} -a ${DEFAULT_CRED_ACCOUNT} -X ${hex}\n`;
        cp.execFileSync('security', ['-i'], {
          input: cmd,
          encoding: 'utf8',
          timeout: 5000
        });
        return { written: true };
      }
    };
  }

  if (platform === 'linux') {
    return {
      platform,
      supported: true,
      read() {
        const queries = [
          ['lookup', 'service', DEFAULT_CRED_SERVICE, 'username', DEFAULT_CRED_ACCOUNT],
          ['lookup', 'service', DEFAULT_CRED_SERVICE, 'account', DEFAULT_CRED_ACCOUNT]
        ];
        for (const args of queries) {
          try {
            const raw = cp.execFileSync('secret-tool', args, { encoding: 'utf8', timeout: 5000 });
            const clean = raw.replace(/\r?\n$/, '');
            return {
              found: true,
              targetName: `${DEFAULT_CRED_SERVICE}:${DEFAULT_CRED_ACCOUNT}`,
              userName: DEFAULT_CRED_ACCOUNT,
              persist: 2,
              blobBase64: Buffer.from(clean, 'utf8').toString('base64')
            };
          } catch {}
        }
        return { found: false };
      },
      write(cred) {
        const buf = Buffer.from(cred.blobBase64 || '', 'base64');
        cp.execFileSync(
          'secret-tool',
          ['store', '--label=Antigravity', 'service', DEFAULT_CRED_SERVICE, 'username', DEFAULT_CRED_ACCOUNT],
          { input: buf, timeout: 5000 }
        );
        return { written: true };
      }
    };
  }

  return {
    platform,
    supported: false,
    read() { return { found: false }; },
    write() { throw new Error(`Unsupported platform for OS credential storage: ${platform}`); }
  };
}

// ============================================================================
// Vault Encryption (Windows DPAPI + Cross-Platform AES-256-GCM)
// ============================================================================

const WIN_DPAPI_PROTECT_PS = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($b64)
$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($protected))
`;

const WIN_DPAPI_UNPROTECT_PS = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd().Trim()
$protected = [Convert]::FromBase64String($b64)
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($bytes))
`;

function getOrCreateAesKey(vaultDir = null) {
  ensureVaultDir(vaultDir);
  const keyPath = getVaultKeyPath(vaultDir);
  if (fs.existsSync(keyPath)) {
    const hex = fs.readFileSync(keyPath, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      return Buffer.from(hex, 'hex');
    }
  }
  const key = crypto.randomBytes(32);
  writeFileAtomic(keyPath, key.toString('hex'), 0o600);
  return key;
}

function encryptWithAes(normalizedB64, vaultDir = null) {
  const key = getOrCreateAesKey(vaultDir);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(normalizedB64, 'base64')),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return {
    scheme: 'aes-256-gcm-v1',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64')
  };
}

/**
 * Encrypts a base64 credential blob using Windows DPAPI (on Windows by default) or AES-256-GCM.
 * @param {string} rawBase64
 * @param {{ vaultDir?: string|null, preferDpapi?: boolean }} [options]
 * @returns {{ scheme: string, data: string, iv?: string, tag?: string }}
 */
export function encryptCredentialBlob(rawBase64, { vaultDir = null, preferDpapi = (process.platform === 'win32') } = {}) {
  const normalizedB64 = Buffer.from(rawBase64 || '', 'base64').toString('base64');

  if (preferDpapi && process.platform === 'win32') {
    try {
      const protectedB64 = runPowerShellEncoded(WIN_DPAPI_PROTECT_PS, normalizedB64, 6000);
      if (protectedB64) {
        return {
          scheme: 'win-dpapi-v1',
          data: protectedB64
        };
      }
    } catch {}
  }

  return encryptWithAes(normalizedB64, vaultDir);
}

/**
 * Async variant of encryptCredentialBlob to avoid blocking the Node event loop.
 * @param {string} rawBase64
 * @param {{ vaultDir?: string|null, preferDpapi?: boolean }} [options]
 * @returns {Promise<{ scheme: string, data: string, iv?: string, tag?: string }>}
 */
export async function encryptCredentialBlobAsync(rawBase64, { vaultDir = null, preferDpapi = (process.platform === 'win32') } = {}) {
  const normalizedB64 = Buffer.from(rawBase64 || '', 'base64').toString('base64');

  if (preferDpapi && process.platform === 'win32') {
    try {
      const protectedB64 = await runPowerShellEncodedAsync(WIN_DPAPI_PROTECT_PS, normalizedB64, 6000);
      if (protectedB64) {
        return {
          scheme: 'win-dpapi-v1',
          data: protectedB64
        };
      }
    } catch {}
  }

  return encryptWithAes(normalizedB64, vaultDir);
}

/**
 * Decrypts an encrypted credential object back to a raw base64 blob.
 * @param {{ scheme: string, data: string, iv?: string, tag?: string }} encObj
 * @param {{ vaultDir?: string|null }} [options]
 * @returns {string} base64 raw credential blob
 */
export function decryptCredentialBlob(encObj, { vaultDir = null } = {}) {
  if (!encObj || typeof encObj !== 'object' || !encObj.scheme || !encObj.data) {
    throw new Error('凭据密文结构无效');
  }

  if (encObj.scheme === 'win-dpapi-v1') {
    if (process.platform !== 'win32') {
      throw new Error('DPAPI 加密凭据只能在当前 Windows 用户下解密');
    }
    return runPowerShellEncoded(WIN_DPAPI_UNPROTECT_PS, encObj.data, 6000);
  }

  if (encObj.scheme === 'aes-256-gcm-v1') {
    const keyPath = getVaultKeyPath(vaultDir);
    if (!fs.existsSync(keyPath)) {
      throw new Error('缺少本地解密密钥 (.vault.key)');
    }
    const keyHex = fs.readFileSync(keyPath, 'utf8').trim();
    const key = Buffer.from(keyHex, 'hex');
    const iv = Buffer.from(encObj.iv, 'base64');
    const tag = Buffer.from(encObj.tag, 'base64');
    const ciphertext = Buffer.from(encObj.data, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('base64');
  }

  throw new Error(`不支持的凭据加密方案: ${encObj.scheme}`);
}

// ============================================================================
// Vault Persistence & Account Snapshot Operations
// ============================================================================

function readVault(vaultDir = null) {
  const filePath = getVaultFilePath(vaultDir);
  if (!fs.existsSync(filePath)) {
    return { version: 1, accounts: [] };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.accounts)) {
    throw new Error('凭据库格式异常，已中止操作以防止账号快照被意外覆盖');
  }
  return { version: parsed.version || 1, accounts: parsed.accounts };
}

function writeVault(vault, vaultDir = null) {
  ensureVaultDir(vaultDir);
  const filePath = getVaultFilePath(vaultDir);
  writeFileAtomic(filePath, JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    accounts: vault.accounts || []
  }, null, 2), 0o600);
}

function resolveWindowResetState(win, nowMs) {
  if (!win || typeof win !== 'object' || typeof win.remainingPercent !== 'number') return null;
  const resetIso = win.resetTime || null;
  const resetMs = resetIso ? Date.parse(resetIso) : NaN;
  if (Number.isFinite(resetMs) && nowMs >= resetMs) {
    return {
      remainingFraction: 1,
      remainingPercent: 100,
      resetTime: null,
      isExhausted: false,
      isEstimatedReset: true,
      originalPercent: win.remainingPercent,
      originalResetTime: resetIso
    };
  }
  return {
    ...win,
    isEstimatedReset: false
  };
}

/**
 * Pure estimator that resolves effective quota for a stored account snapshot,
 * automatically resetting windows to 100% once their resetTime has elapsed while
 * respecting active weekly exhaustion caps.
 * @param {object|null} lastQuota
 * @param {number} [nowMs=Date.now()]
 * @returns {object|null}
 */
export function resolveEffectiveAccountQuota(lastQuota, nowMs = Date.now()) {
  if (!lastQuota || typeof lastQuota !== 'object') return null;

  const rawGroups = Array.isArray(lastQuota.quotaGroups) ? lastQuota.quotaGroups : [];
  const effectiveGroups = [];
  const allEffectivePercents = [];
  const fiveHourPercents = [];
  const weeklyPercents = [];
  let hasWeeklyExhausted = false;
  let resetApplied = false;
  let nextResetMs = Infinity;
  let nextResetTime = null;

  const trackReset = (win) => {
    if (!win || !win.resetTime) return;
    const ms = Date.parse(win.resetTime);
    if (Number.isFinite(ms) && ms > nowMs && ms < nextResetMs) {
      nextResetMs = ms;
      nextResetTime = win.resetTime;
    }
  };

  for (const g of rawGroups) {
    if (!g || typeof g !== 'object') continue;
    const effWeekly = resolveWindowResetState(g.weekly, nowMs);
    const baseFiveHour = resolveWindowResetState(g.fiveHour, nowMs);

    if (effWeekly?.isEstimatedReset) resetApplied = true;
    if (baseFiveHour?.isEstimatedReset) resetApplied = true;

    const weeklyDepleted = Boolean(effWeekly && !effWeekly.isEstimatedReset && effWeekly.remainingPercent <= 0);
    if (weeklyDepleted) hasWeeklyExhausted = true;

    let effFiveHour = baseFiveHour;
    if (baseFiveHour) {
      const effectivePct = weeklyDepleted ? 0 : baseFiveHour.remainingPercent;
      effFiveHour = {
        ...baseFiveHour,
        cappedByWeekly: weeklyDepleted,
        effectivePercent: effectivePct
      };
      fiveHourPercents.push(effectivePct);
      allEffectivePercents.push(effectivePct);
      trackReset(effFiveHour);
    }

    if (effWeekly) {
      weeklyPercents.push(effWeekly.remainingPercent);
      allEffectivePercents.push(effWeekly.remainingPercent);
      trackReset(effWeekly);
    }

    effectiveGroups.push({
      key: g.key,
      title: g.title,
      weekly: effWeekly,
      fiveHour: effFiveHour
    });
  }

  const minRemainingPercent = allEffectivePercents.length > 0
    ? Math.min(...allEffectivePercents)
    : (typeof lastQuota.minRemainingPercent === 'number' ? lastQuota.minRemainingPercent : null);
  const minFiveHourPercent = fiveHourPercents.length > 0 ? Math.min(...fiveHourPercents) : null;
  const minWeeklyPercent = weeklyPercents.length > 0 ? Math.min(...weeklyPercents) : null;

  return {
    fetchedAt: lastQuota.fetchedAt || null,
    capturedOnSwitch: Boolean(lastQuota.capturedOnSwitch),
    quotaGroups: effectiveGroups,
    minRemainingPercent,
    minFiveHourPercent,
    minWeeklyPercent,
    hasWeeklyExhausted,
    resetApplied,
    allFullOrReset: allEffectivePercents.length > 0 && minRemainingPercent >= 100,
    nextResetTime
  };
}

/**
 * Strips all secret fields before returning account entries to API/UI.
 * @param {object} acct
 * @param {string} [currentEmail='']
 * @returns {object}
 */
export function sanitizeAccountForClient(acct, currentEmail = '') {
  const normalizedCurrent = String(currentEmail || '').trim().toLowerCase();
  const acctEmail = String(acct.email || '').trim().toLowerCase();
  const lastQuota = acct.lastQuota || null;
  return {
    id: acct.id,
    email: acct.email,
    name: acct.name || '',
    alias: acct.alias || '',
    planName: acct.planName || '',
    planTier: acct.planTier || '',
    targetName: acct.targetName || DEFAULT_WIN_TARGET,
    capturedAt: acct.capturedAt || null,
    lastUsedAt: acct.lastUsedAt || null,
    lastQuota,
    effectiveQuota: resolveEffectiveAccountQuota(lastQuota),
    isCurrent: Boolean(normalizedCurrent && acctEmail === normalizedCurrent)
  };
}

/**
 * Lists all captured account snapshots (safe display fields only).
 * @param {{ currentEmail?: string, vaultDir?: string|null }} [options]
 */
export function listAccounts({ currentEmail = '', vaultDir = null } = {}) {
  const resolvedEmail = currentEmail || cachedQuotaState?.data?.account?.email || '';
  let vault;
  try {
    vault = readVault(vaultDir);
  } catch (err) {
    console.warn('[agy-context] listAccounts readVault failed:', err.message);
    return {
      accounts: [],
      currentEmail: resolvedEmail,
      platform: process.platform,
      supported: ['win32', 'darwin', 'linux'].includes(process.platform),
      vaultError: err.message
    };
  }
  const sanitized = vault.accounts.map(a => sanitizeAccountForClient(a, resolvedEmail));

  sanitized.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    const tA = Date.parse(a.lastUsedAt || a.capturedAt || 0) || 0;
    const tB = Date.parse(b.lastUsedAt || b.capturedAt || 0) || 0;
    return tB - tA;
  });

  return {
    accounts: sanitized,
    currentEmail: resolvedEmail,
    platform: process.platform,
    supported: ['win32', 'darwin', 'linux'].includes(process.platform)
  };
}

function buildCompactQuotaSnapshot(quotaData, capturedOnSwitch = false) {
  if (!quotaData) return null;
  return {
    fetchedAt: quotaData.fetchedAt || new Date().toISOString(),
    capturedOnSwitch: Boolean(capturedOnSwitch),
    minRemainingPercent: quotaData.summary?.minRemainingPercent ?? null,
    exhaustedCount: quotaData.summary?.exhaustedCount ?? 0,
    credits: quotaData.credits || null,
    quotaGroups: Array.isArray(quotaData.quotaGroups) ? quotaData.quotaGroups : []
  };
}

function quotaGroupSignature(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.quotaGroups)) return '';
  return snapshot.quotaGroups.map(g =>
    `${g.key}:${g.fiveHour?.remainingPercent ?? ''}:${g.fiveHour?.resetTime ?? ''}:${g.weekly?.remainingPercent ?? ''}:${g.weekly?.resetTime ?? ''}`
  ).join('|');
}

/**
 * Lightweight quota snapshot update without spawning any OS credential child process.
 * Persists only when quota values/resetTimes change, plan changes, or forced on switch.
 * @param {object} quotaData
 * @param {{ vaultDir?: string|null, capturedOnSwitch?: boolean }} [options]
 */
export function updateAccountQuotaSnapshot(quotaData, { vaultDir = null, capturedOnSwitch = false } = {}) {
  const email = String(quotaData?.account?.email || '').trim();
  if (!email) return { updated: false, reason: 'missing_email' };

  if (
    !capturedOnSwitch &&
    pendingSwitchState &&
    pendingSwitchState.targetEmail &&
    email.toLowerCase() !== String(pendingSwitchState.targetEmail).toLowerCase()
  ) {
    return { updated: false, reason: 'pending_restart' };
  }

  const vault = readVault(vaultDir);
  const id = computeAccountId(email);
  const idx = vault.accounts.findIndex(a => a.id === id || String(a.email || '').toLowerCase() === email.toLowerCase());
  if (idx < 0) return { updated: false, reason: 'not_in_vault' };

  const existing = vault.accounts[idx];
  const nextSnapshot = buildCompactQuotaSnapshot(quotaData, capturedOnSwitch || existing.lastQuota?.capturedOnSwitch);
  const nextPlanName = quotaData.account.planName || existing.planName || '';
  const nextPlanTier = quotaData.account.planTier || existing.planTier || '';

  if (!capturedOnSwitch && existing.lastQuota) {
    const prevSig = quotaGroupSignature(existing.lastQuota);
    const nextSig = quotaGroupSignature(nextSnapshot);
    const prevTs = Date.parse(existing.lastQuota.fetchedAt || 0) || 0;
    if (
      prevSig === nextSig &&
      existing.planName === nextPlanName &&
      existing.planTier === nextPlanTier &&
      (Date.now() - prevTs < 300000)
    ) {
      return { updated: false, reason: 'unchanged' };
    }
  }

  vault.accounts[idx] = {
    ...existing,
    name: quotaData.account.name || existing.name || '',
    planName: nextPlanName,
    planTier: nextPlanTier,
    lastUsedAt: new Date().toISOString(),
    lastQuota: nextSnapshot
  };
  writeVault(vault, vaultDir);
  return { updated: true, account: sanitizeAccountForClient(vault.accounts[idx], email) };
}

function validateCapturePreconditions(quotaData, adapter) {
  const email = String(quotaData?.account?.email || '').trim();
  if (!email) {
    return { ok: false, result: { captured: false, reason: 'missing_email' } };
  }

  if (
    pendingSwitchState &&
    pendingSwitchState.targetEmail &&
    email.toLowerCase() !== String(pendingSwitchState.targetEmail).toLowerCase()
  ) {
    return { ok: false, result: { captured: false, reason: 'pending_restart' } };
  }

  if (!adapter.supported) {
    return { ok: false, result: { captured: false, reason: 'unsupported_platform' } };
  }

  return { ok: true, email };
}

function findCaptureTargetInVault(vault, email, credentialHash) {
  const id = computeAccountId(email);
  const idx = vault.accounts.findIndex(a => a.id === id || String(a.email || '').toLowerCase() === email.toLowerCase());
  const existing = idx >= 0 ? vault.accounts[idx] : null;
  const duplicateOther = vault.accounts.find(a =>
    a.credentialHash === credentialHash &&
    a.id !== id &&
    String(a.email || '').toLowerCase() !== email.toLowerCase()
  );
  return { id, idx, existing, duplicateOther };
}

function commitCapturedAccountEntry(vault, { id, idx, existing, email, quotaData, cred, credentialHash, encryptedBlob, vaultDir, capturedOnSwitch = false }) {
  const nowIso = new Date().toISOString();
  const entry = {
    id,
    email,
    name: quotaData.account.name || existing?.name || '',
    alias: existing?.alias || '',
    planName: quotaData.account.planName || existing?.planName || '',
    planTier: quotaData.account.planTier || existing?.planTier || '',
    targetName: cred.targetName || existing?.targetName || DEFAULT_WIN_TARGET,
    userName: cred.userName || existing?.userName || DEFAULT_CRED_ACCOUNT,
    persist: cred.persist || existing?.persist || 2,
    credentialHash,
    encryptedBlob,
    capturedAt: existing?.capturedAt || nowIso,
    lastUsedAt: nowIso,
    lastQuota: buildCompactQuotaSnapshot(quotaData, capturedOnSwitch || existing?.lastQuota?.capturedOnSwitch)
  };

  if (idx >= 0) {
    vault.accounts[idx] = entry;
  } else {
    vault.accounts.push(entry);
  }
  writeVault(vault, vaultDir);
  return entry;
}

/**
 * Captures the currently active OS credential into the encrypted local vault.
 * Updates encryptedBlob automatically when tokens rotate.
 * @param {object} quotaData
 * @param {{ credAdapter?: object|null, vaultDir?: string|null, preferDpapi?: boolean, capturedOnSwitch?: boolean }} [options]
 */
export function captureCurrentAccountSnapshot(quotaData, { credAdapter = null, vaultDir = null, preferDpapi = (process.platform === 'win32'), capturedOnSwitch = false } = {}) {
  const adapter = credAdapter || createDefaultCredentialAdapter();
  const check = validateCapturePreconditions(quotaData, adapter);
  if (!check.ok) return check.result;
  const email = check.email;

  const cred = adapter.read();
  if (!cred || !cred.found || !cred.blobBase64) {
    return { captured: false, reason: 'no_credential' };
  }

  const rawBuf = Buffer.from(cred.blobBase64, 'base64');
  const credentialHash = crypto.createHash('sha256').update(rawBuf).digest('hex');
  const vault = readVault(vaultDir);
  const { id, idx, existing, duplicateOther } = findCaptureTargetInVault(vault, email, credentialHash);
  if (duplicateOther) {
    return { captured: false, reason: 'duplicate_credential_hash' };
  }

  let encryptedBlob = existing?.encryptedBlob || null;
  const hashChanged = !existing || existing.credentialHash !== credentialHash || !encryptedBlob;
  if (hashChanged) {
    encryptedBlob = encryptCredentialBlob(cred.blobBase64, { vaultDir, preferDpapi });
  }

  const entry = commitCapturedAccountEntry(vault, {
    id, idx, existing, email, quotaData, cred, credentialHash, encryptedBlob, vaultDir, capturedOnSwitch
  });
  return {
    captured: true,
    updated: hashChanged,
    isNew: idx < 0,
    account: sanitizeAccountForClient(entry, email)
  };
}

/**
 * Non-blocking async variant of captureCurrentAccountSnapshot.
 * Serialized under per-vault async lock and re-validates vault & pendingSwitchState right before write.
 * @param {object} quotaData
 * @param {{ credAdapter?: object|null, vaultDir?: string|null, preferDpapi?: boolean, capturedOnSwitch?: boolean }} [options]
 */
export function captureCurrentAccountSnapshotAsync(quotaData, { credAdapter = null, vaultDir = null, preferDpapi = (process.platform === 'win32'), capturedOnSwitch = false } = {}) {
  return withVaultLock(vaultDir, async () => {
    const adapter = credAdapter || createDefaultCredentialAdapter();
    const check = validateCapturePreconditions(quotaData, adapter);
    if (!check.ok) return check.result;
    const email = check.email;

    const cred = typeof adapter.readAsync === 'function' ? await adapter.readAsync() : adapter.read();
    if (!cred || !cred.found || !cred.blobBase64) {
      return { captured: false, reason: 'no_credential' };
    }

    const rawBuf = Buffer.from(cred.blobBase64, 'base64');
    const credentialHash = crypto.createHash('sha256').update(rawBuf).digest('hex');

    // Re-check preconditions after async read in case a switch started/finished in the meantime
    const postReadCheck = validateCapturePreconditions(quotaData, adapter);
    if (!postReadCheck.ok) return postReadCheck.result;

    const preVault = readVault(vaultDir);
    const preTarget = findCaptureTargetInVault(preVault, email, credentialHash);
    if (preTarget.duplicateOther) {
      return { captured: false, reason: 'duplicate_credential_hash' };
    }

    let encryptedBlob = preTarget.existing?.encryptedBlob || null;
    const hashChanged = !preTarget.existing || preTarget.existing.credentialHash !== credentialHash || !encryptedBlob;
    if (hashChanged) {
      encryptedBlob = await encryptCredentialBlobAsync(cred.blobBase64, { vaultDir, preferDpapi });
    }

    // Re-validate pendingSwitchState and re-read vault immediately prior to atomic write
    const postEncryptCheck = validateCapturePreconditions(quotaData, adapter);
    if (!postEncryptCheck.ok) return postEncryptCheck.result;

    const latestVault = readVault(vaultDir);
    const latestTarget = findCaptureTargetInVault(latestVault, email, credentialHash);
    if (latestTarget.duplicateOther) {
      return { captured: false, reason: 'duplicate_credential_hash' };
    }

    const entry = commitCapturedAccountEntry(latestVault, {
      id: latestTarget.id,
      idx: latestTarget.idx,
      existing: latestTarget.existing,
      email,
      quotaData,
      cred,
      credentialHash,
      encryptedBlob,
      vaultDir,
      capturedOnSwitch
    });
    return {
      captured: true,
      updated: hashChanged,
      isNew: latestTarget.idx < 0,
      account: sanitizeAccountForClient(entry, email)
    };
  });
}

function shouldScheduleBackgroundCredCapture(email, vaultDir) {
  if (!email || isBackgroundCapturing) return false;
  const lower = email.toLowerCase();
  if (lastCredCaptureEmail !== lower) return true;
  if (Date.now() - lastCredCaptureAt >= CRED_CAPTURE_INTERVAL_MS) return true;
  try {
    const vault = readVault(vaultDir);
    const id = computeAccountId(email);
    return !vault.accounts.some(a => a.id === id || String(a.email || '').toLowerCase() === lower);
  } catch (err) {
    console.warn('[agy-context] Skip background capture check due to vault read error:', err.message);
    return false;
  }
}

async function queryCandidateQuota(cand, rpcMeta) {
  const [statusRes, summaryRes] = await Promise.allSettled([
    callLanguageServerRpc(cand, 'GetUserStatus', rpcMeta, 3500),
    callLanguageServerRpc(cand, 'RetrieveUserQuotaSummary', rpcMeta, 3000)
  ]);

  if (statusRes.status !== 'fulfilled' || !statusRes.value) {
    throw statusRes.status === 'rejected' ? statusRes.reason : new Error('GetUserStatus empty response');
  }

  return {
    cand,
    rawResp: statusRes.value,
    summaryResp: summaryRes.status === 'fulfilled' ? summaryRes.value : null,
    summaryError: summaryRes.status === 'rejected' ? String(summaryRes.reason?.message || summaryRes.reason || '') : null
  };
}

async function executeFetchAccountQuota({ forceRefresh = false, autoCapture = true, debug = false, lsAuthOverride = null, credAdapter = null, vaultDir = null } = {}) {
  const hasOverrides = Boolean(lsAuthOverride || credAdapter || vaultDir);
  const now = Date.now();

  let auth = lsAuthOverride || await getLanguageServerAuth(forceRefresh);
  const buildCandidates = (authObj) => authObj?.candidates?.length
    ? authObj.candidates
    : (authObj?.port ? [{ port: authObj.port, protocol: authObj.protocol || 'http', csrf: authObj.csrf || '' }] : []);

  let candidates = buildCandidates(auth);
  if (candidates.length === 0) {
    return {
      available: false,
      error: '未检测到运行中的 Antigravity Language Server',
      account: null,
      credits: null,
      models: [],
      quotaGroups: [],
      summary: null
    };
  }

  const rpcMeta = {
    metadata: {
      ideName: 'antigravity',
      extensionName: 'antigravity',
      locale: 'en'
    }
  };

  let probeResult = null;
  let lastErr = null;

  if (!lsAuthOverride && cachedWorkingCandidate) {
    try {
      probeResult = await queryCandidateQuota(cachedWorkingCandidate, rpcMeta);
    } catch (err) {
      lastErr = err;
      cachedWorkingCandidate = null;
    }
  }

  if (!probeResult) {
    for (const cand of candidates) {
      try {
        probeResult = await queryCandidateQuota(cand, rpcMeta);
        if (!lsAuthOverride) cachedWorkingCandidate = cand;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
  }

  // Re-discover LS port once if cached auth failed on non-forced call
  if (!probeResult && !lsAuthOverride && !forceRefresh) {
    try {
      auth = await getLanguageServerAuth(true);
      candidates = buildCandidates(auth);
      for (const cand of candidates) {
        try {
          probeResult = await queryCandidateQuota(cand, rpcMeta);
          cachedWorkingCandidate = cand;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
    } catch {}
  }

  if (!probeResult) {
    return {
      available: false,
      error: lastErr ? lastErr.message : 'GetUserStatus 请求失败',
      account: null,
      credits: null,
      models: [],
      quotaGroups: [],
      summary: null
    };
  }

  const { rawResp, summaryResp, summaryError } = probeResult;
  const parsed = parseUserStatusResponse(rawResp);
  const accountKey = String(parsed.account.email || '').trim().toLowerCase() || '__default__';
  let knownWeeklyMap = knownWeeklyResetByAccount.get(accountKey);
  if (!knownWeeklyMap) {
    knownWeeklyMap = new Map();
    knownWeeklyResetByAccount.set(accountKey, knownWeeklyMap);
  }

  // Parse RetrieveUserQuotaSummary first so confirmed weekly reset timestamps populate knownWeeklyMap
  let quotaSource = 'models_fallback';
  let quotaGroups = summaryResp ? parseQuotaSummaryResponse(summaryResp, knownWeeklyMap) : [];
  const embeddedGroups = parseQuotaSummaryResponse(rawResp?.userStatus || rawResp, knownWeeklyMap);
  const modelFallbackGroups = buildQuotaGroupsFromModels(parsed.models, knownWeeklyMap);

  if (quotaGroups.length > 0) {
    quotaSource = 'summary_rpc';
    if (embeddedGroups.length > 0) {
      quotaGroups = mergeMissingQuotaGroups(quotaGroups, embeddedGroups);
    }
    if (modelFallbackGroups.length > 0) {
      quotaGroups = mergeMissingQuotaGroups(quotaGroups, modelFallbackGroups);
    }
  } else if (embeddedGroups.length > 0) {
    quotaGroups = mergeMissingQuotaGroups(embeddedGroups, modelFallbackGroups);
    quotaSource = 'user_status_embedded';
  } else {
    quotaGroups = modelFallbackGroups;
  }

  const groupPercents = [];
  let groupExhausted = 0;
  let hasWeeklyData = false;
  for (const g of quotaGroups) {
    if (g.weekly) hasWeeklyData = true;
    for (const w of [g.weekly, g.fiveHour]) {
      if (w && typeof w.remainingPercent === 'number') {
        groupPercents.push(w.remainingPercent);
        if (w.isExhausted) groupExhausted++;
      }
    }
  }

  const summary = {
    ...parsed.summary,
    minRemainingPercent: groupPercents.length > 0 ? Math.min(...groupPercents) : parsed.summary.minRemainingPercent,
    exhaustedCount: groupPercents.length > 0 ? groupExhausted : parsed.summary.exhaustedCount
  };

  const fetchedAt = new Date().toISOString();
  const quotaPayload = {
    available: true,
    cached: false,
    fetchedAt,
    quotaSource,
    hasWeeklyData,
    ...(summaryError ? { summaryRpcError: summaryError } : {}),
    account: parsed.account,
    credits: parsed.credits,
    models: parsed.models,
    quotaGroups,
    summary
  };

  if (
    pendingSwitchState &&
    parsed.account.email &&
    parsed.account.email.toLowerCase() === String(pendingSwitchState.targetEmail || '').toLowerCase()
  ) {
    pendingSwitchState = null;
  }

  let captureStatus = null;
  if (autoCapture !== false && parsed.account.email) {
    if (hasOverrides) {
      try {
        captureStatus = captureCurrentAccountSnapshot(quotaPayload, { credAdapter, vaultDir });
      } catch (err) {
        captureStatus = { captured: false, error: err.message };
      }
    } else {
      withVaultLock(vaultDir, () => {
        updateAccountQuotaSnapshot(quotaPayload, { vaultDir });
      }).catch((err) => {
        console.warn('[agy-context] Failed to update lightweight quota snapshot:', err.message);
      });

      if (shouldScheduleBackgroundCredCapture(parsed.account.email, vaultDir)) {
        isBackgroundCapturing = true;
        const capEmail = parsed.account.email.toLowerCase();
        captureCurrentAccountSnapshotAsync(quotaPayload, { vaultDir })
          .then((res) => {
            if (res && res.captured) {
              lastCredCaptureAt = Date.now();
              lastCredCaptureEmail = capEmail;
            }
          })
          .catch((err) => {
            console.warn('[agy-context] Background credential capture failed:', err.message);
          })
          .finally(() => {
            isBackgroundCapturing = false;
          });
        captureStatus = { captured: false, scheduled: true };
      } else {
        captureStatus = { captured: false, reason: 'snapshot_only' };
      }
    }
  }

  const finalData = {
    ...quotaPayload,
    captureStatus,
    ...(debug ? {
      debugSchema: {
        getUserStatus: buildSanitizedSchema(rawResp),
        retrieveUserQuotaSummary: summaryResp ? buildSanitizedSchema(summaryResp) : null
      }
    } : {})
  };

  if (!hasOverrides && !debug) {
    cachedQuotaState = { ts: now, data: finalData };
  }

  return finalData;
}

/**
 * Fetches live quota from Language Server GetUserStatus & RetrieveUserQuotaSummary.
 * Decouples slow OS credential capture into background tasks so quota responses stay fast.
 * @param {object} [options]
 */
export async function fetchAccountQuota(options = {}) {
  const { forceRefresh = false, debug = false, lsAuthOverride = null, credAdapter = null, vaultDir = null } = options;
  const hasOverrides = Boolean(lsAuthOverride || credAdapter || vaultDir);
  const now = Date.now();

  if (!forceRefresh && !hasOverrides && !debug && cachedQuotaState && (now - cachedQuotaState.ts < QUOTA_CACHE_TTL_MS)) {
    return {
      ...cachedQuotaState.data,
      cached: true
    };
  }

  if (!hasOverrides && !debug && inFlightQuotaPromise && (!forceRefresh || inFlightQuotaForce)) {
    return inFlightQuotaPromise;
  }

  const work = executeFetchAccountQuota(options);
  if (!hasOverrides && !debug) {
    inFlightQuotaPromise = work;
    inFlightQuotaForce = Boolean(forceRefresh);
    try {
      return await work;
    } finally {
      if (inFlightQuotaPromise === work) {
        inFlightQuotaPromise = null;
        inFlightQuotaForce = false;
      }
    }
  }

  return work;
}

function resolveSwitchTargets(accountId, vaultDir) {
  if (!accountId) {
    return { ok: false, result: { success: false, error: '缺少目标账号 ID' } };
  }
  const vault = readVault(vaultDir);
  const targetIdx = vault.accounts.findIndex(a => a.id === accountId);
  if (targetIdx < 0) {
    return { ok: false, result: { success: false, error: '未在本地凭据库中找到该账号快照' } };
  }
  return { ok: true, vault, targetIdx, target: vault.accounts[targetIdx] };
}

function finalizeAccountSwitch(accountId, outgoingQuota, backedUpOutgoing, vaultDir) {
  const latestVault = readVault(vaultDir);
  const latestIdx = latestVault.accounts.findIndex(a => a.id === accountId);
  if (latestIdx < 0) {
    return { success: false, error: '账号快照状态异常，请刷新后重试' };
  }
  const latestTarget = latestVault.accounts[latestIdx];
  latestTarget.lastUsedAt = new Date().toISOString();
  latestVault.accounts[latestIdx] = latestTarget;
  writeVault(latestVault, vaultDir);

  pendingSwitchState = {
    targetEmail: latestTarget.email,
    targetId: latestTarget.id,
    targetHash: latestTarget.credentialHash || null,
    switchedAt: Date.now()
  };

  return {
    success: true,
    needsRestart: true,
    backedUpOutgoing,
    outgoingSnapshotSaved: Boolean(outgoingQuota?.account?.email),
    account: sanitizeAccountForClient(latestTarget, latestTarget.email),
    message: `已切换至 ${latestTarget.alias || latestTarget.email}`
  };
}

/**
 * Switches the OS credential to the specified vault account (synchronous variant for tests/CLI).
 * Backs up the outgoing account's latest OS credential and quota snapshot before overwriting.
 * @param {string} accountId
 * @param {{ currentQuota?: object|null, credAdapter?: object|null, vaultDir?: string|null }} [options]
 */
export function switchAccount(accountId, { currentQuota = null, credAdapter = null, vaultDir = null } = {}) {
  const resolved = resolveSwitchTargets(accountId, vaultDir);
  if (!resolved.ok) return resolved.result;

  const adapter = credAdapter || createDefaultCredentialAdapter();
  if (!adapter.supported) {
    return { success: false, error: `当前系统暂不支持凭据写入: ${process.platform}` };
  }

  const target = resolved.target;
  const outgoingQuota = currentQuota || cachedQuotaState?.data || null;
  const isSwitchingToDifferentEmail = Boolean(
    outgoingQuota?.account?.email &&
    outgoingQuota.account.email.toLowerCase() !== String(target.email || '').toLowerCase()
  );
  const skipDuplicateCheck = Boolean(pendingSwitchState && pendingSwitchState.targetId === target.id);

  if (isSwitchingToDifferentEmail && !skipDuplicateCheck) {
    const curCred = adapter.read();
    if (curCred && curCred.found && curCred.blobBase64) {
      const curHash = crypto.createHash('sha256').update(Buffer.from(curCred.blobBase64, 'base64')).digest('hex');
      if (target.credentialHash && target.credentialHash === curHash) {
        return {
          success: false,
          error: '该账号本地凭据快照与当前登录账号相同（可能因旧版本切换前未重启导致覆盖），请先在 Antigravity 中退出并重新登录该账号一次以重新捕获独立凭据。'
        };
      }
    }
  }

  let backedUpOutgoing = false;
  if (!pendingSwitchState && isSwitchingToDifferentEmail) {
    try {
      updateAccountQuotaSnapshot(outgoingQuota, { vaultDir, capturedOnSwitch: true });
      const cap = captureCurrentAccountSnapshot(outgoingQuota, { credAdapter: adapter, vaultDir, capturedOnSwitch: true });
      backedUpOutgoing = Boolean(cap?.captured);
    } catch (err) {
      console.warn('[agy-context] Outgoing account backup failed before switch:', err.message);
    }
  }

  const latestVault = readVault(vaultDir);
  const latestIdx = latestVault.accounts.findIndex(a => a.id === accountId);
  if (latestIdx < 0) {
    return { success: false, error: '账号快照状态异常，请刷新后重试' };
  }
  const latestTarget = latestVault.accounts[latestIdx];

  const rawBlobBase64 = decryptCredentialBlob(latestTarget.encryptedBlob, { vaultDir });
  adapter.write({
    targetName: latestTarget.targetName || DEFAULT_WIN_TARGET,
    userName: latestTarget.userName || DEFAULT_CRED_ACCOUNT,
    persist: latestTarget.persist || 2,
    blobBase64: rawBlobBase64
  });

  return finalizeAccountSwitch(accountId, outgoingQuota, backedUpOutgoing, vaultDir);
}

/**
 * Non-blocking async account switch serialized under per-vault lock.
 * On Windows, executes outgoing check, backup, target DPAPI decrypt, and CredWriteW
 * inside a single PowerShell invocation.
 * @param {string} accountId
 * @param {{ currentQuota?: object|null, credAdapter?: object|null, vaultDir?: string|null, preferDpapi?: boolean }} [options]
 */
export function switchAccountAsync(accountId, { currentQuota = null, credAdapter = null, vaultDir = null, preferDpapi = (process.platform === 'win32') } = {}) {
  return withVaultLock(vaultDir, async () => {
    const resolved = resolveSwitchTargets(accountId, vaultDir);
    if (!resolved.ok) return resolved.result;

    const adapter = credAdapter || createDefaultCredentialAdapter();
    if (!adapter.supported) {
      return { success: false, error: `当前系统暂不支持凭据写入: ${process.platform}` };
    }

    const target = resolved.target;
    const outgoingQuota = currentQuota || cachedQuotaState?.data || null;
    const outgoingEmail = String(outgoingQuota?.account?.email || '').trim();
    const isSwitchingToDifferentEmail = Boolean(
      outgoingEmail &&
      outgoingEmail.toLowerCase() !== String(target.email || '').toLowerCase()
    );
    const skipDuplicateCheck = Boolean(pendingSwitchState && pendingSwitchState.targetId === target.id);

    // Fast Windows single-PowerShell batch path when using default OS adapter
    if (process.platform === 'win32' && !credAdapter) {
      const enc = target.encryptedBlob;
      if (!enc || typeof enc !== 'object' || !enc.scheme || !enc.data) {
        return { success: false, error: '目标账号凭据密文结构无效' };
      }

      const useInScriptDpapiDecrypt = enc.scheme === 'win-dpapi-v1';
      const targetBlobBase64 = useInScriptDpapiDecrypt ? '' : decryptCredentialBlob(enc, { vaultDir });
      const shouldCheckCurrent = isSwitchingToDifferentEmail && !skipDuplicateCheck;
      const shouldCaptureOutgoing = Boolean(!pendingSwitchState && isSwitchingToDifferentEmail);

      const batchPayload = JSON.stringify({
        checkCurrent: shouldCheckCurrent,
        captureOutgoing: shouldCaptureOutgoing,
        preferDpapi: Boolean(preferDpapi),
        primaryTarget: DEFAULT_WIN_TARGET,
        rejectHash: shouldCheckCurrent ? (target.credentialHash || '') : '',
        targetScheme: enc.scheme,
        targetData: useInScriptDpapiDecrypt ? enc.data : '',
        targetBlobBase64,
        targetName: target.targetName || DEFAULT_WIN_TARGET,
        userName: target.userName || DEFAULT_CRED_ACCOUNT,
        persist: target.persist || 2
      });

      const outRaw = await runPowerShellEncodedAsync(WIN_CRED_PS_SWITCH_BATCH, batchPayload, 12000);
      const out = JSON.parse(outRaw || '{}');

      if (!out.ok) {
        if (out.reason === 'duplicate_credential_hash') {
          return {
            success: false,
            error: '该账号本地凭据快照与当前登录账号相同（可能因旧版本切换前未重启导致覆盖），请先在 Antigravity 中退出并重新登录该账号一次以重新捕获独立凭据。'
          };
        }
        throw new Error(out.error || 'Windows 凭据批处理切换失败');
      }

      let backedUpOutgoing = false;
      if (shouldCaptureOutgoing) {
        if (out.outgoing && out.outgoing.found && out.outgoing.credentialHash) {
          const vault = readVault(vaultDir);
          const { id, idx, existing, duplicateOther } = findCaptureTargetInVault(vault, outgoingEmail, out.outgoing.credentialHash);
          if (!duplicateOther) {
            let outgoingEnc = existing?.encryptedBlob || null;
            const hashChanged = !existing || existing.credentialHash !== out.outgoing.credentialHash || !outgoingEnc;
            if (hashChanged) {
              if (out.outgoing.protectedBase64) {
                outgoingEnc = { scheme: 'win-dpapi-v1', data: out.outgoing.protectedBase64 };
              } else if (out.outgoing.rawBase64) {
                outgoingEnc = encryptWithAes(Buffer.from(out.outgoing.rawBase64, 'base64').toString('base64'), vaultDir);
              }
            }
            if (outgoingEnc) {
              commitCapturedAccountEntry(vault, {
                id,
                idx,
                existing,
                email: outgoingEmail,
                quotaData: outgoingQuota,
                cred: {
                  targetName: out.outgoing.targetName || DEFAULT_WIN_TARGET,
                  userName: out.outgoing.userName || DEFAULT_CRED_ACCOUNT,
                  persist: out.outgoing.persist || 2
                },
                credentialHash: out.outgoing.credentialHash,
                encryptedBlob: outgoingEnc,
                vaultDir,
                capturedOnSwitch: true
              });
              backedUpOutgoing = true;
            }
          }
        }
        if (!backedUpOutgoing) {
          updateAccountQuotaSnapshot(outgoingQuota, { vaultDir, capturedOnSwitch: true });
        }
      }

      return finalizeAccountSwitch(accountId, outgoingQuota, backedUpOutgoing, vaultDir);
    }

    // Non-Windows or injected test adapter async path: verify duplicate hash before modifying anything
    if (isSwitchingToDifferentEmail && !skipDuplicateCheck) {
      const curCred = typeof adapter.readAsync === 'function' ? await adapter.readAsync() : adapter.read();
      if (curCred && curCred.found && curCred.blobBase64) {
        const curHash = crypto.createHash('sha256').update(Buffer.from(curCred.blobBase64, 'base64')).digest('hex');
        if (target.credentialHash && target.credentialHash === curHash) {
          return {
            success: false,
            error: '该账号本地凭据快照与当前登录账号相同（可能因旧版本切换前未重启导致覆盖），请先在 Antigravity 中退出并重新登录该账号一次以重新捕获独立凭据。'
          };
        }
      }
    }

    let backedUpOutgoing = false;
    if (!pendingSwitchState && isSwitchingToDifferentEmail) {
      try {
        updateAccountQuotaSnapshot(outgoingQuota, { vaultDir, capturedOnSwitch: true });
        const curCred = typeof adapter.readAsync === 'function' ? await adapter.readAsync() : adapter.read();
        if (curCred && curCred.found && curCred.blobBase64) {
          const rawBuf = Buffer.from(curCred.blobBase64, 'base64');
          const credentialHash = crypto.createHash('sha256').update(rawBuf).digest('hex');
          const vault = readVault(vaultDir);
          const { id, idx, existing, duplicateOther } = findCaptureTargetInVault(vault, outgoingEmail, credentialHash);
          if (!duplicateOther) {
            let encryptedBlob = existing?.encryptedBlob || null;
            if (!existing || existing.credentialHash !== credentialHash || !encryptedBlob) {
              encryptedBlob = await encryptCredentialBlobAsync(curCred.blobBase64, { vaultDir, preferDpapi });
            }
            commitCapturedAccountEntry(vault, {
              id, idx, existing, email: outgoingEmail, quotaData: outgoingQuota, cred: curCred, credentialHash, encryptedBlob, vaultDir, capturedOnSwitch: true
            });
            backedUpOutgoing = true;
          }
        }
      } catch (err) {
        console.warn('[agy-context] Outgoing account async backup failed before switch:', err.message);
      }
    }

    const latestVault = readVault(vaultDir);
    const latestIdx = latestVault.accounts.findIndex(a => a.id === accountId);
    if (latestIdx < 0) {
      return { success: false, error: '账号快照状态异常，请刷新后重试' };
    }
    const latestTarget = latestVault.accounts[latestIdx];

    const rawBlobBase64 = decryptCredentialBlob(latestTarget.encryptedBlob, { vaultDir });
    const writePayload = {
      targetName: latestTarget.targetName || DEFAULT_WIN_TARGET,
      userName: latestTarget.userName || DEFAULT_CRED_ACCOUNT,
      persist: latestTarget.persist || 2,
      blobBase64: rawBlobBase64
    };
    if (typeof adapter.writeAsync === 'function') {
      await adapter.writeAsync(writePayload);
    } else {
      adapter.write(writePayload);
    }

    return finalizeAccountSwitch(accountId, outgoingQuota, backedUpOutgoing, vaultDir);
  });
}

/**
 * Lock-protected async wrappers for alias update and account deletion.
 */
export function updateAccountAliasAsync(accountId, alias, options = {}) {
  return withVaultLock(options?.vaultDir, () => updateAccountAlias(accountId, alias, options));
}

export function deleteAccountAsync(accountId, options = {}) {
  return withVaultLock(options?.vaultDir, () => deleteAccount(accountId, options));
}

/**
 * Updates user alias for a stored account snapshot.
 * @param {string} accountId
 * @param {string} alias
 * @param {{ vaultDir?: string|null }} [options]
 */
export function updateAccountAlias(accountId, alias, { vaultDir = null } = {}) {
  const vault = readVault(vaultDir);
  const idx = vault.accounts.findIndex(a => a.id === accountId);
  if (idx < 0) {
    return { success: false, error: '未找到指定账号' };
  }
  const trimmed = String(alias || '').trim().slice(0, 128);
  const email = String(vault.accounts[idx].email || '').trim();
  vault.accounts[idx].alias = (trimmed && trimmed.toLowerCase() !== email.toLowerCase()) ? trimmed : '';
  writeVault(vault, vaultDir);
  return {
    success: true,
    account: sanitizeAccountForClient(vault.accounts[idx], cachedQuotaState?.data?.account?.email || '')
  };
}

/**
 * Removes an account snapshot from the local encrypted vault.
 * @param {string} accountId
 * @param {{ vaultDir?: string|null }} [options]
 */
export function deleteAccount(accountId, { vaultDir = null } = {}) {
  const vault = readVault(vaultDir);
  const before = vault.accounts.length;
  vault.accounts = vault.accounts.filter(a => a.id !== accountId);
  if (vault.accounts.length === before) {
    return { success: false, error: '未找到指定账号' };
  }
  writeVault(vault, vaultDir);
  return {
    success: true,
    remaining: vault.accounts.length
  };
}

// ============================================================================
// Cross-Platform One-Click Antigravity App Restart
// ============================================================================

/**
 * Resolves the Antigravity Desktop application executable path across platforms.
 * @returns {string|null}
 */
export function resolveAntigravityAppExecutable() {
  if (process.platform === 'win32') {
    const psExe = getWindowsPowerShellExe();
    try {
      const psOut = cp.execFileSync(
        psExe,
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -First 1'],
        { timeout: 3000, encoding: 'utf8', windowsHide: true }
      ).trim();
      if (psOut && fs.existsSync(psOut)) return psOut;
    } catch {}

    const candidates = [
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'antigravity', 'Antigravity.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Antigravity', 'Antigravity.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Antigravity', 'Antigravity.exe')
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Antigravity.app',
      path.join(os.homedir(), 'Applications', 'Antigravity.app')
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    try {
      const psOut = cp.execFileSync('ps', ['-axo', 'comm='], { encoding: 'utf8', timeout: 2500 });
      for (const line of psOut.split(/\r?\n/)) {
        const m = line.match(/^(.*?\/Antigravity\.app)\//i);
        if (m && m[1] && fs.existsSync(m[1])) return m[1];
      }
    } catch {}
    return null;
  }

  if (process.platform === 'linux') {
    try {
      const whichOut = cp.execFileSync('which', ['antigravity'], { encoding: 'utf8', timeout: 2500 }).trim();
      if (whichOut && fs.existsSync(whichOut)) return whichOut;
    } catch {}
    const candidates = [
      '/usr/bin/antigravity',
      '/opt/antigravity/antigravity',
      '/usr/local/bin/antigravity',
      path.join(os.homedir(), '.local', 'bin', 'antigravity'),
      '/snap/bin/antigravity'
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    try {
      const pidsOut = cp.execFileSync('pgrep', ['-x', 'antigravity'], { encoding: 'utf8', timeout: 2500 }).trim();
      for (const pid of pidsOut.split(/\s+/).filter(Boolean)) {
        try {
          const realExe = fs.readlinkSync(`/proc/${pid}/exe`);
          if (realExe && fs.existsSync(realExe)) return realExe;
        } catch {}
      }
    } catch {}
    return null;
  }

  return null;
}

/**
 * Spawns a detached OS-specific helper that stops Antigravity and relaunches it cleanly.
 * Delays briefly (~600-700ms) so the HTTP response can reach the UI before processes terminate.
 * @returns {{ success: boolean, restarting?: boolean, launchMethod?: string, wmiError?: string, executablePath?: string, error?: string }}
 */
export function restartAntigravityApp() {
  const exePath = resolveAntigravityAppExecutable();
  if (!exePath) {
    return {
      success: false,
      error: '未检测到 Antigravity 客户端路径，请手动完全退出并重新打开。'
    };
  }

  if (process.platform === 'win32') {
    const comSpec = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    const psExe = getWindowsPowerShellExe();
    const exeDir = path.dirname(exePath).replace(/%/g, '%%');
    const safeExePath = exePath.replace(/%/g, '%%');
    const batPath = path.join(os.tmpdir(), `agy-restart-${Date.now()}-${process.pid}.cmd`);

    const batLines = [
      '@echo off',
      'chcp 65001 >nul 2>&1',
      'ping 127.0.0.1 -n 2 >nul',
      'set /a count=0',
      ':waitloop',
      '"%SystemRoot%\\System32\\taskkill.exe" /F /IM Antigravity.exe >nul 2>&1',
      '"%SystemRoot%\\System32\\taskkill.exe" /F /IM language_server.exe >nul 2>&1',
      '"%SystemRoot%\\System32\\tasklist.exe" /NH /FI "IMAGENAME eq Antigravity.exe" 2>nul | "%SystemRoot%\\System32\\findstr.exe" /I "Antigravity.exe" >nul 2>&1',
      'if not errorlevel 1 goto keepwaiting',
      '"%SystemRoot%\\System32\\tasklist.exe" /NH /FI "IMAGENAME eq language_server.exe" 2>nul | "%SystemRoot%\\System32\\findstr.exe" /I "language_server.exe" >nul 2>&1',
      'if not errorlevel 1 goto keepwaiting',
      'goto launch',
      ':keepwaiting',
      'set /a count+=1',
      'if %count% GEQ 30 goto launch',
      'ping 127.0.0.1 -n 2 >nul',
      'goto waitloop',
      ':launch',
      'ping 127.0.0.1 -n 2 >nul',
      `start "" /D "${exeDir}" "${safeExePath}"`,
      'del "%~f0" >nul 2>&1'
    ];
    fs.writeFileSync(batPath, batLines.join('\r\n') + '\r\n', 'utf8');

    const cmdLine = `"${comSpec}" /d /c "${batPath}"`;

    const escapedCmd = cmdLine.replace(/'/g, "''");

    // Spawn via WMI Win32_Process so the restart helper runs in Session 1 outside Antigravity's Job Object
    // and survives when Antigravity & language_server are terminated.
    let wmiLaunched = false;
    let wmiError = '';
    try {
      const launcherScript = `$ErrorActionPreference = 'Stop'; $cmd = '${escapedCmd}'; try { $si = New-CimInstance -ClassName Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0 } -ClientOnly; $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; ProcessStartupInformation = $si } } catch { $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd } }; if ($res.ReturnValue -ne 0) { throw ('WMI ReturnValue=' + $res.ReturnValue) }`;
      cp.execFileSync(
        psExe,
        ['-NoProfile', '-NonInteractive', '-Command', launcherScript],
        { timeout: 4000, encoding: 'utf8', windowsHide: true }
      );
      wmiLaunched = true;
    } catch (err) {
      wmiError = String(err?.stderr || err?.message || err || 'unknown').trim();
    }

    if (!wmiLaunched) {
      const child = cp.spawn(
        comSpec,
        ['/d', '/c', 'start', '', '/b', comSpec, '/d', '/c', batPath],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
      child.unref();
    }
    return {
      success: true,
      restarting: true,
      launchMethod: wmiLaunched ? 'wmi' : 'fallback',
      ...(wmiError ? { wmiError } : {}),
      executablePath: exePath
    };
  }

  if (process.platform === 'darwin') {
    const escaped = exePath.replace(/'/g, "'\\''");
    const sh = `sleep 0.7; osascript -e 'tell application "Antigravity" to quit' >/dev/null 2>&1 || true; sleep 1.2; pkill -9 -f 'Antigravity\\.app' >/dev/null 2>&1 || true; pkill -9 -f 'language_server' >/dev/null 2>&1 || true; i=0; while [ $i -lt 25 ]; do pgrep -f 'Antigravity\\.app|language_server' >/dev/null 2>&1 || break; sleep 0.2; i=$((i+1)); done; sleep 0.4; open -n -a '${escaped}'`;
    const child = cp.spawn('sh', ['-c', sh], { detached: true, stdio: 'ignore' });
    child.unref();
    return { success: true, restarting: true, launchMethod: 'sh', executablePath: exePath };
  }

  if (process.platform === 'linux') {
    const escaped = exePath.replace(/'/g, "'\\''");
    const sh = `sleep 0.7; pkill -TERM -x antigravity >/dev/null 2>&1 || true; pkill -TERM -f 'language_server' >/dev/null 2>&1 || true; sleep 1.2; pkill -KILL -x antigravity >/dev/null 2>&1 || true; pkill -KILL -f 'language_server' >/dev/null 2>&1 || true; i=0; while [ $i -lt 25 ]; do pgrep -x antigravity >/dev/null 2>&1 || pgrep -f 'language_server' >/dev/null 2>&1 || break; sleep 0.2; i=$((i+1)); done; sleep 0.4; nohup '${escaped}' >/dev/null 2>&1 &`;
    let launchMethod = 'sh';
    try {
      const child = cp.spawn('setsid', ['sh', '-c', sh], { detached: true, stdio: 'ignore' });
      child.unref();
      launchMethod = 'setsid';
    } catch {
      const child = cp.spawn('sh', ['-c', sh], { detached: true, stdio: 'ignore' });
      child.unref();
    }
    return { success: true, restarting: true, launchMethod, executablePath: exePath };
  }

  return {
    success: false,
    error: `当前平台 (${process.platform}) 暂不支持一键重启，请手动重启客户端。`
  };
}
