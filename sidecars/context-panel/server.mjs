/**
 * @fileoverview Sidecar Web Server for Antigravity Context Inspector
 * Runs in the background continuously when Antigravity starts, providing
 * live real-time context analytics embedded in the Antigravity Auxiliary Pane.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { analyzeTranscript, analyzeGlobalTokens, resolveTranscriptPath } from '../../scripts/context-analyzer.mjs';
import { checkForUpdates, applyOneClickUpdate, getLocalVersion } from '../../scripts/updater.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '5173', 10);
const TOKEN = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
const HOST = '127.0.0.1';

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

function validateToken(req, url) {
  if (url.pathname === '/preload.js') return true;
  if (!TOKEN) return true;
  const provided = req.headers['x-sidecar-token'] || url.searchParams.get('token');
  return provided === TOKEN;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // Token validation
  if (!validateToken(req, url)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized sidecar request' }));
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
      const range = url.searchParams.get('range') || '3d';
      const data = analyzeGlobalTokens(range);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Get Single Conversation Context Metrics
  if (url.pathname === '/api/context') {
    try {
      let convId = url.searchParams.get('conversationId') || process.env.ANTIGRAVITY_CONVERSATION_ID;
      const transcriptPath = resolveTranscriptPath(convId);
      if (!transcriptPath) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No active conversation transcript found' }));
        return;
      }
      if (!convId) {
        const m = transcriptPath.match(/brain[/\\]([^/\\]+)/);
        if (m) convId = m[1];
      }
      const data = await analyzeTranscript(transcriptPath, { conversationId: convId });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Check for Updates
  if (url.pathname === '/api/update/check') {
    try {
      const data = await checkForUpdates();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: One-Click Apply Update
  if (url.pathname === '/api/update/apply' && req.method === 'POST') {
    try {
      const result = await applyOneClickUpdate();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Serve Plugin Logo
  if (url.pathname === '/logo.svg' || url.pathname === '/assets/logo.svg') {
    try {
      const logoPath = join(__dirname, '..', '..', 'assets', 'logo.svg');
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
      res.end(readFileSync(logoPath));
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
      const html = readFileSync(htmlPath, 'utf8');
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
  // Initial warm-up in background
  setTimeout(() => {
    try {
      analyzeGlobalTokens('today');
    } catch (e) {}
  }, 1000);
  // Periodic background refresh every 60s
  setInterval(() => {
    try {
      analyzeGlobalTokens('today');
    } catch (e) {}
  }, 60000);
});
