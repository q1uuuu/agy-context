/**
 * @fileoverview Antigravity Context Analyzer by q1u
 * Parses Antigravity transcripts and produces comprehensive context metrics,
 * token breakdowns, timeline evolution, and aggregated local token usage.
 */

import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Known model limits (in tokens) - Antigravity runtime assigns a 256k budget limit (256,000 nominal)
export const MODEL_LIMITS = {
  'gemini-3.8-flash': 256000,
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
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'antigravity');
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
let isNativeScanning = false;

// Google official API pricing rates ($ per 1M tokens)
const MODEL_PRICING = {
  'gemini-3.8-flash': { input: 0.75, output: 3.75, cached: 0.075 },
  'gemini 3.8 flash': { input: 0.75, output: 3.75, cached: 0.075 },
  'gemini 3.8 flash (high)': { input: 0.75, output: 3.75, cached: 0.075 },
  'gemini-3.8-flash-tiered': { input: 0.75, output: 3.75, cached: 0.075 },
  'gemini-3.8-flash-n': { input: 0.75, output: 3.75, cached: 0.075 },
  'gemini-3-flash': { input: 0.75, output: 3.75, cached: 0.075 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30, cached: 0.01875 },
  'gemini-1.5-pro': { input: 1.25, output: 5.00, cached: 0.3125 },
  'gemini-pro': { input: 1.25, output: 5.00, cached: 0.3125 },
  'claude-sonnet-5-5-high': { input: 3.00, output: 15.00, cached: 0.30 },
  'claude-3-5-sonnet': { input: 3.00, output: 15.00, cached: 0.30 }
};

function getModelPricing(modelName) {
  const lower = (modelName || '').toLowerCase().trim();
  for (const [key, p] of Object.entries(MODEL_PRICING)) {
    if (lower === key || lower.includes(key)) return p;
  }
  if (lower.includes('pro')) return { input: 1.25, output: 5.00, cached: 0.3125 };
  if (lower.includes('flash')) return { input: 0.75, output: 3.75, cached: 0.075 };
  if (lower.includes('sonnet') || lower.includes('claude')) return { input: 3.00, output: 15.00, cached: 0.30 };
  return null;
}

/**
 * Runs the native Antigravity token scanner using Windows's built-in winsqlite3 engine
 * and Protobuf decoder. 100% self-calculating, zero external dependencies.
 * @param {boolean} [force=false]
 * @returns {object|null}
 */
export function runNativeStatsScan(force = false) {
  const now = Date.now();
  if (!force && cachedNativeStats && (now - lastNativeScanMs < 30000)) {
    return cachedNativeStats;
  }

  const candidates = [
    path.join(__dirname, 'native-token-scanner.ps1'),
    path.join(__dirname, 'scripts', 'native-token-scanner.ps1'),
    path.join(process.env.USERPROFILE || '', '.gemini', 'config', 'plugins', 'agy-context', 'scripts', 'native-token-scanner.ps1'),
    path.join(process.env.USERPROFILE || '', '.gemini', 'config', 'plugins', 'agy-context', 'sidecars', 'context-panel', 'scripts', 'native-token-scanner.ps1')
  ];

  let scriptPath = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      scriptPath = c;
      break;
    }
  }

  if (!scriptPath) {
    return cachedNativeStats;
  }

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

    const parsed = JSON.parse(stdout.trim());
    cachedNativeStats = parsed;
    lastNativeScanMs = Date.now();
    return parsed;
  } catch (err) {
    console.error('[agy-context] Native token scan error:', err.message);
    return cachedNativeStats;
  }
}

/**
 * Aggregates local Token metrics across Antigravity records by date range.
 * 100% Native Antigravity SQLite & Protobuf scanning (q1u native, zero external dependencies).
 * @param {string} [range='today'] 'today' | 'yesterday' | '3d' | '7d' | '30d'
 * @returns {object} Aggregated local token usage data
 */
export function analyzeGlobalTokens(range = 'today') {
  const raw = runNativeStatsScan() || {};
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const yesterday = new Date(now.getTime() - 86400000);
  const yesterdayStr = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`;

  let rangeLabel = '今天';
  let targetTotals = raw.today || { input_tokens: 0, output_tokens: 0, cached_tokens: 0, total_tokens: 0, request_count: 0 };
  let targetModels = raw.by_model_today || [];

  if (range === 'today') {
    rangeLabel = '今天';
    targetTotals = raw.today || targetTotals;
    targetModels = raw.by_model_today || [];
  } else if (range === 'yesterday') {
    rangeLabel = '昨天';
    targetTotals = raw.yesterday || targetTotals;
    targetModels = raw.by_model_yesterday || [];
  } else if (range === '3d') {
    rangeLabel = '近 3 天';
    targetTotals = raw.last_3_days || targetTotals;
    targetModels = raw.by_model_3_days || [];
  } else if (range === '7d') {
    rangeLabel = '近 7 天';
    targetTotals = raw.last_7_days || targetTotals;
    targetModels = raw.by_model_7_days || [];
  } else if (range === '30d') {
    rangeLabel = '近 30 天';
    targetTotals = raw.last_30_days || targetTotals;
    targetModels = raw.by_model || [];
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
  const isHourly = (range === 'today' || range === 'yesterday');
  const buckets = [];
  let xLabels = [];
  let defaultActiveIndex = 0;

  if (isHourly) {
    xLabels = ['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00', '23:00'];
    const targetDate = range === 'today' ? todayStr : yesterdayStr;
    const hourlyMap = {};
    for (const h of (raw.hourly || [])) {
      if (h.hour.startsWith(targetDate)) {
        const hh = h.hour.split(' ')[1] || '';
        hourlyMap[hh] = h;
      }
    }

    for (let h = 0; h < 24; h++) {
      const hh = String(h).padStart(2, '0') + ':00';
      const b = hourlyMap[hh] || { total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, request_count: 0 };
      const bTot = Number(b.total_tokens || 0);
      const bInp = Number(b.input_tokens || 0);
      const bOut = Number(b.output_tokens || 0);
      const bCch = Number(b.cached_tokens || 0);
      const bReq = Number(b.request_count || 0);
      const cost = (bInp / 1e6 * 0.75) + (bCch / 1e6 * 0.075) + (bOut / 1e6 * 3.75);

      buckets.push({
        time: hh,
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
      if (bTot > 0) defaultActiveIndex = h;
    }
  } else {
    // Daily range
    const dailyList = raw.daily || [];
    let sliceDays = 30;
    if (range === '3d') sliceDays = 3;
    else if (range === '7d') sliceDays = 7;
    const filteredDaily = dailyList.slice(-sliceDays);

    filteredDaily.forEach((d) => {
      const dTot = Number(d.total_tokens || 0);
      const dInp = Number(d.input_tokens || 0);
      const dOut = Number(d.output_tokens || 0);
      const dCch = Number(d.cached_tokens || 0);
      const dReq = Number(d.request_count || 0);
      const cost = (dInp / 1e6 * 0.75) + (dCch / 1e6 * 0.075) + (dOut / 1e6 * 3.75);

      const shortDate = d.date.slice(5); // MM-DD
      xLabels.push(shortDate);
      buckets.push({
        time: d.date,
        rawTotal: dTot,
        compactTotal: formatCompactNumber(dTot),
        fullTotal: dTot.toLocaleString() + ' Token',
        inputCompact: formatCompactNumber(dInp),
        rawInput: dInp,
        outputCompact: formatCompactNumber(dOut),
        rawOutput: dOut,
        cacheCompact: formatCompactNumber(dCch),
        rawCache: dCch,
        requests: dReq,
        cost: '$' + cost.toFixed(2),
        rawCost: Number(cost.toFixed(2))
      });
    });
    defaultActiveIndex = Math.max(0, buckets.length - 1);
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
      value: hasPerf ? `${perf.first_text_seconds.toFixed(2)} 秒` : '--',
      sub: hasPerf ? `最近 ${perf.sample_count} 次回复的中位数` : '暂无交互采样',
      raw: hasPerf ? perf.first_text_seconds : 0
    },
    speed: {
      value: hasPerf ? `${perf.body_tokens_per_second.toFixed(1)} token/s` : '--',
      sub: hasPerf ? `最近 ${perf.sample_count} 次回复的中位数` : '暂无交互采样',
      raw: hasPerf ? perf.body_tokens_per_second : 0
    },
    avgInput: {
      formatted: `${formatCompactNumber(avgInputTokens)} Token`,
      sub: `${totalRequests} 次请求，含缓存输入`,
      raw: avgInputTokens
    },
    modelCount: modelList.length,
    unpricedCount,
    models: modelList,
    chart: {
      type: isHourly ? 'hourly' : 'daily',
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
let cachedLsAuth = { port: 0, csrf: '', timestamp: 0 };

/**
 * Resolves Antigravity Language Server port and CSRF token
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<{port: number, csrf: string}|null>}
 */
export async function getLanguageServerAuth(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedLsAuth.port && cachedLsAuth.csrf && (now - cachedLsAuth.timestamp < 300000)) {
    return cachedLsAuth;
  }

  // 1. Resolve Language Server Port from main.log
  let port = 49671;
  try {
    const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    const mainLogPath = path.join(appData, 'Antigravity', 'logs', 'main.log');
    if (fs.existsSync(mainLogPath)) {
      const content = fs.readFileSync(mainLogPath, 'utf8');
      const matches = [...content.matchAll(/Reloading all windows with URL: https:\/\/127\.0\.0\.1:(\d+)/g)];
      if (matches.length > 0) {
        port = parseInt(matches[matches.length - 1][1], 10);
      }
    }
  } catch (e) {}

  // 2. Resolve CSRF Token via fast HTTPS GET to Language Server Web UI
  let csrf = '';
  try {
    csrf = await new Promise((resolve) => {
      const req = https.get({
        hostname: '127.0.0.1',
        port,
        path: '/',
        rejectUnauthorized: false,
        timeout: 1000
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

  // 3. Fallback: query language_server process command line if HTTP GET didn't get CSRF
  if (!csrf) {
    try {
      const psCmd = 'Get-Process -Name language_server -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id';
      const pid = cp.execSync(`powershell -NoProfile -Command "${psCmd}"`, { timeout: 3000 }).toString().trim().split(/\r?\n/)[0];
      if (pid) {
        const cmdLine = cp.execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId = ${pid}\\").CommandLine"`, { timeout: 3000 }).toString();
        const m = cmdLine.match(/--csrf_token\s+([a-f0-9-]+)/i);
        if (m) csrf = m[1];
      }
    } catch (e) {}
  }

  if (port && csrf) {
    cachedLsAuth = { port, csrf, timestamp: now };
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
  if (!auth || !auth.port || !auth.csrf) return null;

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

    const req = https.request({
      hostname: '127.0.0.1',
      port: targetAuth.port,
      path: '/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates',
      method: 'POST',
      rejectUnauthorized: false,
      timeout: 1500,
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
    }, 1500);
  });

  let result = await runRequest(auth);
  // If first attempt failed, retry once with refreshed auth
  if (!result) {
    const refreshedAuth = await getLanguageServerAuth(true);
    if (refreshedAuth && (refreshedAuth.port !== auth.port || refreshedAuth.csrf !== auth.csrf)) {
      result = await runRequest(refreshedAuth);
    }
  }

  return result;
}

/**
 * Analyzes an individual Antigravity conversation transcript
 * @param {string} transcriptPath 
 * @param {object} [options]
 * @returns {Promise<object>} Full context metrics report
 */
export async function analyzeTranscript(transcriptPath, options = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    throw new Error(`Transcript file not found: ${transcriptPath}`);
  }

  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const lines = raw.trim().split('\n').filter(Boolean);

  let conversationId = options.conversationId || '';
  if (!conversationId) {
    const match = transcriptPath.match(/brain[/\\]([^/\\]+)/);
    if (match) conversationId = match[1];
  }

  let modelName = 'Gemini 3.8 Flash (High)';
  let modelLimit = MODEL_LIMITS.default;

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
  const topConsumers = [];

  let currentContext = 0;

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
        for (const [key, limit] of Object.entries(MODEL_LIMITS)) {
          if (modelName.toLowerCase().includes(key)) {
            modelLimit = limit;
            break;
          }
        }
      }
    }

    if (type === 'PLANNER_RESPONSE' && typeof entry.input_tokens === 'number') {
      totalModelTurns++;
      const inp = entry.input_tokens;
      const cch = entry.cache_read_tokens || 0;
      const out = entry.output_tokens || 0;

      totalInputTokens = inp;
      totalCacheReadTokens = cch;
      totalOutputTokens += out;
      currentContext = inp + cch;

      timeline.push({
        step: stepIndex,
        turn: totalModelTurns,
        input_tokens: inp,
        cache_tokens: cch,
        output_tokens: out,
        total_context: currentContext,
        timestamp: entry.created_at || null
      });
    }

    const estTokens = estimateTokens(content) + estimateTokens(thinking);

    if (type === 'USER_INPUT' && content.includes('<system_prompt>')) {
      systemTokens += estTokens;
      if (estTokens > 1500) {
        topConsumers.push({
          step_index: stepIndex,
          type: 'SYSTEM_INSTRUCTIONS',
          label: 'System Prompt / Guidelines',
          tokens: estTokens,
          details: content.substring(0, 100) + '...'
        });
      }
    } else if (type === 'USER_INPUT') {
      userTokens += estTokens;
      if (estTokens > 1000) {
        topConsumers.push({
          step_index: stepIndex,
          type: 'USER_INPUT',
          label: 'User Message',
          tokens: estTokens,
          details: content.substring(0, 100) + '...'
        });
      }
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

      if (estTokens > 1200) {
        topConsumers.push({
          step_index: stepIndex,
          type: 'TOOL_OUTPUT',
          label: `Tool Output: ${toolName}`,
          tokens: estTokens,
          details: content.substring(0, 100) + '...'
        });
      }
    }
  }

  if (currentContext === 0) {
    currentContext = systemTokens + toolsTokens + userTokens + assistantTokens;
  }

  // Official dynamic telemetry from Antigravity Language Server (Connect-RPC Streaming)
  let officialUsage = null;
  if (conversationId) {
    try {
      officialUsage = await fetchOfficialContextUsage(conversationId);
    } catch (e) {
      // Graceful fallback to transcript
    }
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

    const sysTok = sysGroup ? sysGroup.numTokens : systemTokens;
    const toolTok = toolGroup ? toolGroup.numTokens : toolsTokens;
    const chatTok = chatGroup ? chatGroup.numTokens : (userTokens + assistantTokens);

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
    // Transcript-derived 4-category fallback
    const categorySum = systemTokens + toolsTokens + userTokens + assistantTokens || 1;
    const sysPct = Math.round((systemTokens / categorySum) * 100);
    const toolPct = Math.round((toolsTokens / categorySum) * 100);
    const userPct = Math.round((userTokens / categorySum) * 100);
    const modelPct = Math.max(0, 100 - sysPct - toolPct - userPct);

    breakdown = [
      { key: 'system', label: 'System & Guidelines', tokens: systemTokens, percent: sysPct },
      { key: 'tools', label: 'Tool Calls & Outputs', tokens: toolsTokens, percent: toolPct },
      { key: 'user', label: 'User Instructions', tokens: userTokens, percent: userPct },
      { key: 'model', label: 'Model Responses', tokens: assistantTokens, percent: modelPct }
    ];
  }

  const usagePercent = Math.min(100, Number(((currentContext / modelLimit) * 100).toFixed(1)));
  const remainingTokens = Math.max(0, modelLimit - currentContext);

  const totalInputWindow = totalInputTokens + totalCacheReadTokens;
  const cacheHitRatio = totalInputWindow > 0 
    ? Number(((totalCacheReadTokens / totalInputWindow) * 100).toFixed(1))
    : 0;

  topConsumers.sort((a, b) => b.tokens - a.tokens);

  let healthStatus = '良好 (Healthy)';
  let healthLevel = 'info';
  if (usagePercent > 80) {
    healthStatus = '危险 (Critical: >80%)';
    healthLevel = 'critical';
  } else if (usagePercent > 60) {
    healthStatus = '警告 (Warning: >60%)';
    healthLevel = 'warning';
  }

  const recommendations = [];
  if (usagePercent > 60) {
    recommendations.push({
      level: 'warning',
      title: '上下文占用较高',
      action: '建议在聊天框中输入 `/compact` 压缩上下文，释放空间以维持最高模型推理质量。'
    });
  }
  const toolTokensForCheck = officialUsage ? (breakdown.find(b => b.key === 'tools')?.tokens || 0) : toolsTokens;
  if (toolTokensForCheck > (currentContext * 0.5)) {
    recommendations.push({
      level: 'tip',
      title: '工具输出占比较大 (>50%)',
      action: '阅读大文件或运行大命令产生了较多上下文，建议在工具调用中限制读取行数或使用特定搜索。'
    });
  }
  if (recommendations.length === 0) {
    recommendations.push({
      level: 'healthy',
      title: '上下文状态极佳',
      action: 'Prompt 缓存利用率良好，无需执行额外压缩。'
    });
  }

  return {
    meta: {
      conversationId,
      model: modelName,
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
      cacheTokens: totalCacheReadTokens,
      uncachedTokens: totalInputTokens,
      totalOutputTokens,
      totalModelTurns
    },
    breakdown,
    toolStats,
    topConsumers: topConsumers.slice(0, 10),
    timeline,
    recommendations
  };
}
