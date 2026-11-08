import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { analyzeTranscript, analyzeGlobalTokens, resolveTranscriptPath } from './context-analyzer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(__dirname, '..');
const transcriptPath = resolveTranscriptPath();
const sessionData = await analyzeTranscript(transcriptPath);
const globalData = analyzeGlobalTokens('3d');

const templatePath = path.join(pluginDir, 'sidecars', 'context-panel', 'index.html');
let html = fs.readFileSync(templatePath, 'utf8');

const inlineInjection = `
  <script>
    window.__INITIAL_GLOBAL_DATA__ = ${JSON.stringify(globalData)};
    window.__INITIAL_SESSION_DATA__ = ${JSON.stringify(sessionData)};
    const origFetchGlobalTokens = window.fetchGlobalTokens;
    window.fetchGlobalTokens = async function() {
      if (window.__INITIAL_GLOBAL_DATA__) {
        renderGlobalView(window.__INITIAL_GLOBAL_DATA__);
      }
      try { await origFetchGlobalTokens(); } catch(e) {}
    };
    const origFetchSessionContext = window.fetchSessionContext;
    window.fetchSessionContext = async function() {
      if (window.__INITIAL_SESSION_DATA__) {
        renderSessionView(window.__INITIAL_SESSION_DATA__);
      }
      try { await origFetchSessionContext(); } catch(e) {}
    };
  </script>
`;

html = html.replace('</body>', `${inlineInjection}</body>`);

const appDataDir = process.env.ANTIGRAVITY_APP_DATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity');
const outPath = process.argv[2] || path.join(appDataDir, 'brain', sessionData.meta.conversationId, 'context-dashboard.html');
fs.writeFileSync(outPath, html, 'utf8');
console.log('Artifact written to:', outPath);
