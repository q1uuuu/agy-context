/**
 * @fileoverview Zero-dependency single-file bundler for the Antigravity MCP App Dashboard.
 * Combines mcp-app/src/template.html, styles.css, vendor/ext-apps.mjs, and app.js
 * into a self-contained mcp-app/dashboard.html (< 1 MiB, zero CDN dependencies).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'mcp-app', 'src');
const VENDOR_SDK = path.join(ROOT, 'mcp-app', 'vendor', 'ext-apps.mjs');
const OUT_HTML = path.join(ROOT, 'mcp-app', 'dashboard.html');

const template = fs.readFileSync(path.join(SRC_DIR, 'template.html'), 'utf8');
const css = fs.readFileSync(path.join(SRC_DIR, 'styles.css'), 'utf8');
const sdkRaw = fs.readFileSync(VENDOR_SDK, 'utf8');
const appRaw = fs.readFileSync(path.join(SRC_DIR, 'app.js'), 'utf8');

// Transform vendor ESM export block into local destructuring bindings inside a single <script type="module">
const exportMatch = sdkRaw.match(/export\s*\{([^}]+)\}\s*;?\s*$/);
if (!exportMatch) {
  throw new Error('Could not locate ESM export block in mcp-app/vendor/ext-apps.mjs');
}

const exportMap = {};
for (const part of exportMatch[1].split(',')) {
  const m = part.trim().match(/^(\S+)\s+as\s+(\S+)$/);
  if (m) exportMap[m[2]] = m[1];
}

const requiredExports = ['App', 'applyDocumentTheme', 'applyHostStyleVariables'];
for (const key of requiredExports) {
  if (!exportMap[key]) {
    throw new Error(`Missing expected export "${key}" in vendor/ext-apps.mjs`);
  }
}

const sdkBody = sdkRaw.slice(0, exportMatch.index);
const appBody = appRaw.replace(
  /import\s*\{[\s\S]*?\}\s*from\s*['"]@modelcontextprotocol\/ext-apps['"];?\r?\n?/,
  ''
);

const bundledJs = [
  sdkBody,
  `const App = ${exportMap.App};`,
  `const applyDocumentTheme = ${exportMap.applyDocumentTheme};`,
  `const applyHostStyleVariables = ${exportMap.applyHostStyleVariables};`,
  appBody
].join('\n').replace(/<\/script/gi, '<\\/script');

const finalHtml = template
  .replace('/* __INLINE_CSS__ */', () => css)
  .replace('<script>/* __INLINE_JS__ */</script>', () => `<script type="module">\n${bundledJs}\n</script>`);

fs.writeFileSync(OUT_HTML, finalHtml, 'utf8');
const kb = (Buffer.byteLength(finalHtml, 'utf8') / 1024).toFixed(1);
console.log(`[build-mcp-app] Built ${OUT_HTML} (${kb} KB)`);
