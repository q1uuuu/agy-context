/**
 * @fileoverview Sidecar Web Server for Antigravity Context Inspector
 * Runs in the background continuously when Antigravity starts, providing
 * live real-time context analytics embedded in the Antigravity Auxiliary Pane.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';
import {
  analyzeTranscript,
  analyzeGlobalTokensAsync,
  resolveTranscriptPath,
  warmupGlobalTokenIndex,
  getCachedWeeklyTokenSummary
} from '../../scripts/context-analyzer.mjs';
import { checkForUpdates, applyOneClickUpdate } from '../../scripts/updater.mjs';
import { getOverallUnlockStatus, applyUnlock, restoreOriginal, savePreset, getSavedPreset } from '../../scripts/context-unlocker.mjs';
import {
  fetchAccountQuota,
  listAccounts,
  captureCurrentAccountSnapshotAsync,
  switchAccountAsync,
  updateAccountAliasAsync,
  deleteAccountAsync,
  restartAntigravityApp
} from '../../scripts/account-manager.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '5173', 10);
const TOKEN = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
const HOST = '127.0.0.1';

const staticFileCache = new Map();

function readStaticCached(filePath, encoding = null) {
  const mtimeMs = statSync(filePath).mtimeMs;
  const cached = staticFileCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.content;
  }
  const content = encoding ? readFileSync(filePath, encoding) : readFileSync(filePath);
  staticFileCache.set(filePath, { mtimeMs, content });
  return content;
}

// Read preload.js if available from sidecar_sdk, or use fallback
let preloadJs = '';
const sdkPreload = join(os.homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js');
if (existsSync(sdkPreload)) {
  preloadJs = readFileSync(sdkPreload, 'utf8');
} else {
  preloadJs = `
    window.sidecar = {
      conversationId: new URLSearchParams(window.location.search).get('conversationId') || '',
      fetch: (url, opts = {}) => fetch(url, opts)
    };
  `;
}

// Ensure preload.js adopts official Google Sans Flex & Google Sans Code typography
preloadJs = preloadJs.replace(
  /document\.body\.style\.fontFamily\s*=\s*['"][^'"]+['"]/g,
  `document.body.style.fontFamily = '"Google Sans Flex", "Google Sans", system-ui, sans-serif'`
);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)
    || /^vscode-webview:\/\//i.test(origin)
    || /^antigravity:\/\//i.test(origin)
    || /^file:\/\//i.test(origin);
}

function getCorsHeaders(req) {
  const origin = req?.headers?.origin;
  if (!origin || !isAllowedOrigin(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin'
  };
}

function validateToken(req, url) {
  if (url.pathname === '/preload.js') return true;
  if (!TOKEN) return true;
  const provided = req.headers['x-sidecar-token'] || url.searchParams.get('token');
  return provided === TOKEN;
}

function sendJson(res, status, data, req = null, cacheNoStore = true) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...getCorsHeaders(req)
  };
  if (cacheNoStore) {
    headers['Cache-Control'] = 'no-cache';
  }
  if (status === 413) {
    headers['Connection'] = 'close';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function createHttpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    let tooLarge = false;

    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    req.on('data', (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        tooLarge = true;
        settled = true;
        req.pause();
        reject(createHttpError(413, 'Request body exceeds limit'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled || tooLarge) return;
      settled = true;
      const bodyStr = Buffer.concat(chunks).toString('utf8').trim();
      if (!bodyStr) return resolve({});
      let parsed;
      try {
        parsed = JSON.parse(bodyStr);
      } catch {
        reject(createHttpError(400, 'Invalid JSON request body'));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(createHttpError(400, 'JSON request body must be an object'));
        return;
      }
      resolve(parsed);
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const origin = req.headers.origin;

  if (origin && !isAllowedOrigin(origin)) {
    sendJson(res, 403, { error: 'Forbidden origin' }, req);
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...getCorsHeaders(req),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Sidecar-Token'
    });
    res.end();
    return;
  }

  // Token validation
  if (!validateToken(req, url)) {
    sendJson(res, 401, { error: 'Unauthorized sidecar request' }, req);
    return;
  }

  // Preload script route
  if (url.pathname === '/preload.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(preloadJs);
    return;
  }

  // API: Get Global Tokens (Aggregated local metrics)
  if (url.pathname === '/api/global-tokens') {
    try {
      const range = url.searchParams.get('range') || 'today';
      const start = url.searchParams.get('start') || '';
      const end = url.searchParams.get('end') || '';
      const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
      const data = await analyzeGlobalTokensAsync(range, { start, end, force });
      sendJson(res, 200, data, req);
    } catch (err) {
      sendJson(res, 500, { error: err.message }, req);
    }
    return;
  }

  // API: Get Single Conversation Context Metrics
  if (url.pathname === '/api/context') {
    try {
      let convId = url.searchParams.get('conversationId') || process.env.ANTIGRAVITY_CONVERSATION_ID;
      const transcriptPath = resolveTranscriptPath(convId);
      if (!transcriptPath) {
        sendJson(res, 404, { error: 'No active conversation transcript found' }, req);
        return;
      }
      if (!convId) {
        const m = transcriptPath.match(/brain[/\\]([^/\\]+)/);
        if (m) convId = m[1];
      }
      const data = await analyzeTranscript(transcriptPath, { conversationId: convId });

      // Inject saved preset & budget limit into response
      try {
        const presetInfo = getSavedPreset();
        if (data && data.overview) {
          data.overview.activePreset = presetInfo.preset;
          data.overview.targetLimit = presetInfo.targetLimit;
          if (presetInfo.targetLimit) {
            data.overview.effectiveLimit = presetInfo.targetLimit;
          }
        }
      } catch {}

      sendJson(res, 200, data, req);
    } catch (err) {
      sendJson(res, 500, { error: err.message }, req);
    }
    return;
  }

  // API: Check for Updates
  if (url.pathname === '/api/update/check') {
    try {
      const data = await checkForUpdates();
      sendJson(res, 200, data, req);
    } catch (err) {
      sendJson(res, 500, { error: err.message }, req);
    }
    return;
  }

  // API: One-Click Apply Update
  if (url.pathname === '/api/update/apply' && req.method === 'POST') {
    try {
      const result = await applyOneClickUpdate();
      sendJson(res, 200, result, req, false);
    } catch (err) {
      sendJson(res, 500, { error: err.message }, req);
    }
    return;
  }

  // API: Get Context Unlock Status & Preset
  if (url.pathname === '/api/context/unlock-status') {
    try {
      const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
      const data = await getOverallUnlockStatus({ forceRefresh: force });
      sendJson(res, 200, data, req);
    } catch (err) {
      sendJson(res, 500, { error: err.message }, req);
    }
    return;
  }

  // API: Apply Context Unlock (hot patch binary & resign)
  if (url.pathname === '/api/context/unlock' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const result = await applyUnlock(payload.target || 'desktop');
      sendJson(res, 200, result, req, false);
    } catch (err) {
      sendJson(res, err.statusCode || 500, { error: err.message }, req);
    }
    return;
  }

  // API: Restore Original Binary from Backup
  if (url.pathname === '/api/context/restore' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const result = await restoreOriginal(payload.target || 'desktop');
      sendJson(res, 200, result, req, false);
    } catch (err) {
      sendJson(res, err.statusCode || 500, { error: err.message }, req);
    }
    return;
  }

  // API: Set Context Preset (e.g. 900k, 512k, 256k)
  if (url.pathname === '/api/context/preset' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const result = savePreset(payload.preset || '512k');
      sendJson(res, 200, result, req, false);
    } catch (err) {
      sendJson(res, err.statusCode || 500, { error: err.message }, req);
    }
    return;
  }

  // API: Get Context Preset
  if (url.pathname === '/api/context/preset' && req.method === 'GET') {
    try {
      const data = getSavedPreset();
      sendJson(res, 200, data, req);
    } catch (err) {
      sendJson(res, 500, { error: err.message }, req);
    }
    return;
  }

  // API: Get Live Account & Model Quotas
  if (url.pathname === '/api/quota' && req.method === 'GET') {
    try {
      const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
      const debug = url.searchParams.get('debug') === '1' || url.searchParams.get('debug') === 'true';
      const data = await fetchAccountQuota({ forceRefresh: force, debug });
      sendJson(res, 200, data, req);
    } catch (err) {
      sendJson(res, 500, { available: false, error: err.message }, req);
    }
    return;
  }

  // API: List Captured Account Snapshots
  if (url.pathname === '/api/accounts' && req.method === 'GET') {
    try {
      const quota = await fetchAccountQuota({ forceRefresh: false, autoCapture: false }).catch(() => null);
      const currentEmail = quota?.account?.email || '';
      const data = listAccounts({ currentEmail });
      data.weeklyTokenSummary = getCachedWeeklyTokenSummary();
      sendJson(res, 200, data, req);
    } catch (err) {
      sendJson(res, 500, { error: err.message }, req);
    }
    return;
  }

  // API: Capture Current Account Snapshot Manually
  if (url.pathname === '/api/accounts/capture' && req.method === 'POST') {
    try {
      const quota = await fetchAccountQuota({ forceRefresh: true, autoCapture: false });
      if (!quota?.available || !quota?.account?.email) {
        sendJson(res, 200, {
          captured: false,
          error: quota?.error || '未能识别当前登录账号，请确认 Antigravity 已登录并运行中。'
        }, req);
        return;
      }
      const captureStatus = await captureCurrentAccountSnapshotAsync(quota);
      const list = listAccounts({ currentEmail: quota.account.email });
      sendJson(res, 200, { ...captureStatus, ...list }, req);
    } catch (err) {
      sendJson(res, 500, { captured: false, error: err.message }, req);
    }
    return;
  }

  // API: Switch Active Account Credential Snapshot
  if (url.pathname === '/api/accounts/switch' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      let quota = await Promise.race([
        fetchAccountQuota({ forceRefresh: true, autoCapture: false }).catch(() => null),
        new Promise(resolve => setTimeout(() => resolve(null), 2500))
      ]);
      if (!quota?.available) {
        const cachedQuota = await fetchAccountQuota({ forceRefresh: false, autoCapture: false }).catch(() => null);
        if (cachedQuota?.available) quota = cachedQuota;
        else quota = null;
      }
      const result = await switchAccountAsync(payload.accountId, { currentQuota: quota });
      sendJson(res, result.success ? 200 : 400, result, req);
    } catch (err) {
      sendJson(res, err.statusCode || 500, { success: false, error: err.message }, req);
    }
    return;
  }

  // API: Update Account Alias
  if (url.pathname === '/api/accounts/alias' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const result = await updateAccountAliasAsync(payload.accountId, payload.alias);
      sendJson(res, result.success ? 200 : 400, result, req);
    } catch (err) {
      sendJson(res, err.statusCode || 500, { success: false, error: err.message }, req);
    }
    return;
  }

  // API: Delete Stored Account Snapshot
  if (url.pathname === '/api/accounts/delete' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const result = await deleteAccountAsync(payload.accountId);
      sendJson(res, result.success ? 200 : 400, result, req);
    } catch (err) {
      sendJson(res, err.statusCode || 500, { success: false, error: err.message }, req);
    }
    return;
  }

  // API: One-Click Restart Antigravity Client
  if (url.pathname === '/api/app/restart' && req.method === 'POST') {
    try {
      const result = restartAntigravityApp();
      sendJson(res, result.success ? 200 : 400, result, req);
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message }, req);
    }
    return;
  }

  // Serve Plugin Logo
  if (url.pathname === '/logo.svg' || url.pathname === '/assets/logo.svg') {
    try {
      const logoPath = join(__dirname, '..', '..', 'assets', 'logo.svg');
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
      res.end(readStaticCached(logoPath));
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Logo not found');
    }
    return;
  }

  // Serve Main Dashboard HTML
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const htmlPath = join(__dirname, 'index.html');
      const html = readStaticCached(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading dashboard: ' + err.message);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  console.log(`[agy-context] Background Sidecar daemon listening on http://${HOST}:${PORT}`);
  const warmupTimer = setTimeout(() => {
    warmupGlobalTokenIndex().catch(() => {});
  }, 500);
  if (typeof warmupTimer.unref === 'function') {
    warmupTimer.unref();
  }
});
