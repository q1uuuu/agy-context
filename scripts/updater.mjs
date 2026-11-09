/**
 * @fileoverview Auto-Update Engine for Antigravity Context Inspector (agy-context)
 * Supports zero-dependency checking, downloading, extracting, atomic updating, and hot restart.
 * @author q1u
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getLanguageServerAuth } from './context-analyzer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(__dirname, '..');
export const GITHUB_REPO = 'q1uuuu/agy-context';

/**
 * Compares two Semver version strings (e.g. "1.1.0" vs "1.0.0")
 * @param {string} v1
 * @param {string} v2
 * @returns {number} 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
export function compareSemver(v1, v2) {
  const parse = v => (v || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const p1 = parse(v1);
  const p2 = parse(v2);
  for (let i = 0; i < 3; i++) {
    const a = p1[i] || 0;
    const b = p2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

/**
 * Reads local version from plugin.json
 * @returns {string}
 */
export function getLocalVersion() {
  try {
    const pPath = path.join(PLUGIN_ROOT, 'plugin.json');
    if (fs.existsSync(pPath)) {
      const data = JSON.parse(fs.readFileSync(pPath, 'utf8'));
      return data.version || '1.0.0';
    }
  } catch (e) {}
  return '1.0.0';
}

/**
 * Performs HTTPS GET request with automatic redirect following
 * @param {string} targetUrl
 * @param {object} [options]
 * @param {number} [redirectCount=0]
 * @returns {Promise<{statusCode: number, headers: object, data: Buffer}>}
 */
export function fetchUrl(targetUrl, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      return reject(new Error('Too many HTTP redirects'));
    }

    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'http:' ? http : https;

    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'agy-context-updater',
        'Accept': 'application/json, text/plain, */*',
        ...(options.headers || {})
      },
      timeout: options.timeout || 6000
    };

    const req = client.request(reqOpts, res => {
      // Follow redirects
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        let redirectTarget = res.headers.location;
        if (!redirectTarget.startsWith('http://') && !redirectTarget.startsWith('https://')) {
          redirectTarget = new URL(redirectTarget, targetUrl).toString();
        }
        res.resume();
        return resolve(fetchUrl(redirectTarget, options, redirectCount + 1));
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: Buffer.concat(chunks)
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Connection timeout (${reqOpts.timeout}ms)`));
    });
    req.end();
  });
}

/**
 * Downloads a file to local disk with redirect support
 * @param {string} url
 * @param {string} destPath
 * @param {Function} [onProgress]
 * @returns {Promise<void>}
 */
export async function downloadFile(url, destPath, onProgress) {
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const followDownload = (targetUrl, redirectCount = 0) => {
    return new Promise((resolve, reject) => {
      if (redirectCount > 6) return reject(new Error('Too many download redirects'));

      const parsed = new URL(targetUrl);
      const client = parsed.protocol === 'http:' ? http : https;

      const req = client.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { 'User-Agent': 'agy-context-updater' },
        timeout: 25000
      }, res => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          let nextUrl = res.headers.location;
          if (!nextUrl.startsWith('http')) {
            nextUrl = new URL(nextUrl, targetUrl).toString();
          }
          res.resume();
          return resolve(followDownload(nextUrl, redirectCount + 1));
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download failed with HTTP ${res.statusCode}`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;
        const fileStream = fs.createWriteStream(destPath);

        res.on('data', chunk => {
          downloadedBytes += chunk.length;
          if (onProgress && totalBytes > 0) {
            onProgress(Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)));
          }
        });

        res.pipe(fileStream);
        fileStream.on('finish', () => fileStream.close(() => resolve()));
        fileStream.on('error', err => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
      req.end();
    });
  };

  return followDownload(url);
}

/**
 * Checks for latest updates from GitHub Releases API with graceful fallbacks
 * @returns {Promise<object>}
 */
export async function checkForUpdates() {
  const currentVersion = getLocalVersion();
  let latestVersion = currentVersion;
  let releaseName = `v${currentVersion}`;
  let changelog = '';
  let releaseDate = '';
  let downloadUrl = `https://github.com/${GITHUB_REPO}/archive/refs/heads/main.zip`;
  let htmlUrl = `https://github.com/${GITHUB_REPO}`;

  // 1. Primary Channel: GitHub Releases API
  let apiSuccess = false;
  try {
    const res = await fetchUrl(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      timeout: 3500,
      headers: { 'Accept': 'application/vnd.github.v3+json' }
    });

    if (res.statusCode === 200) {
      const release = JSON.parse(res.data.toString('utf8'));
      latestVersion = (release.tag_name || '').replace(/^v/, '');
      releaseName = release.name || release.tag_name || `v${latestVersion}`;
      changelog = release.body || '';
      releaseDate = release.published_at || '';
      htmlUrl = release.html_url || htmlUrl;

      // Check asset for zipball
      const zipAsset = (release.assets || []).find(a => a.name.endsWith('.zip'));
      if (zipAsset && zipAsset.browser_download_url) {
        downloadUrl = zipAsset.browser_download_url;
      } else if (release.zipball_url) {
        downloadUrl = release.zipball_url;
      }
      apiSuccess = true;
    }
  } catch (err) {
    // Fallback to secondary CDN
  }

  // 2. Secondary Channel: jsDelivr / Raw plugin.json (Fast and immune to API rate-limit)
  if (!apiSuccess) {
    const cdnCandidates = [
      `https://cdn.jsdelivr.net/gh/${GITHUB_REPO}@main/plugin.json`,
      `https://raw.githubusercontent.com/${GITHUB_REPO}/main/plugin.json`
    ];

    for (const cdnUrl of cdnCandidates) {
      try {
        const cdnRes = await fetchUrl(cdnUrl, { timeout: 3000 });
        if (cdnRes.statusCode === 200) {
          const remotePlugin = JSON.parse(cdnRes.data.toString('utf8'));
          if (remotePlugin.version) {
            latestVersion = remotePlugin.version.replace(/^v/, '');
            releaseName = `v${latestVersion}`;
            downloadUrl = `https://github.com/${GITHUB_REPO}/archive/refs/heads/main.zip`;
            changelog = '常规性能提升与稳定性优化。';
            break;
          }
        }
      } catch (e) {}
    }
  }

  const hasUpdate = compareSemver(latestVersion, currentVersion) > 0;

  return {
    hasUpdate,
    currentVersion,
    latestVersion,
    releaseName,
    releaseDate,
    changelog: changelog.trim() || '无详细更新说明。',
    downloadUrl,
    htmlUrl
  };
}

/**
 * Extracts a ZIP archive using the operating system's native built-in utility
 * @param {string} zipPath
 * @param {string} destDir
 */
export function extractArchive(zipPath, destDir) {
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  if (process.platform === 'win32') {
    // Windows 10 (1803+) includes tar.exe by default
    try {
      cp.execFileSync('tar.exe', ['-xf', zipPath, '-C', destDir], { timeout: 15000, windowsHide: true });
      return;
    } catch (e) {
      // Fallback to PowerShell Expand-Archive
      cp.execFileSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`
      ], { timeout: 30000, windowsHide: true });
    }
  } else {
    // macOS / Linux: native unzip
    cp.execFileSync('unzip', ['-q', '-o', zipPath, '-d', destDir], { timeout: 15000 });
  }
}

/**
 * Recursively copies directory contents
 * @param {string} src
 * @param {string} dest
 */
function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.name === '.git' || entry.name === '.update_tmp') continue;

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Restarts the Sidecar service via Antigravity Connect-RPC or detached process spawn
 */
export async function restartSidecarService() {
  const auth = await getLanguageServerAuth(true);

  if (auth && auth.port && auth.csrf) {
    const makeRpc = (action) => new Promise((resolve) => {
      const payload = JSON.stringify({
        sidecarId: 'agy-context/context-panel',
        action
      });

      const req = https.request({
        hostname: '127.0.0.1',
        port: auth.port,
        path: '/exa.language_server_pb.LanguageServerService/ManageSidecar',
        method: 'POST',
        rejectUnauthorized: false,
        timeout: 3000,
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': auth.csrf,
          'Content-Length': Buffer.byteLength(payload)
        }
      }, () => resolve(true));

      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(payload);
      req.end();
    });

    try {
      await makeRpc('SIDECAR_ACTION_DISABLE');
      await new Promise(r => setTimeout(r, 600));
      await makeRpc('SIDECAR_ACTION_ENABLE');
      return true;
    } catch (e) {}
  }

  // Fallback: spawn background process and exit self
  try {
    const serverScript = path.join(PLUGIN_ROOT, 'sidecars', 'context-panel', 'server.mjs');
    const child = cp.spawn(process.execPath, [serverScript], {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(serverScript),
      env: { ...process.env }
    });
    child.unref();

    setTimeout(() => {
      process.exit(0);
    }, 500);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Executes a full atomic one-click update workflow
 * @param {Function} [onProgress]
 * @returns {Promise<{success: boolean, message: string, oldVersion: string, newVersion: string}>}
 */
export async function applyOneClickUpdate(onProgress = () => {}) {
  const currentVersion = getLocalVersion();
  const updateInfo = await checkForUpdates();

  if (!updateInfo.downloadUrl) {
    throw new Error('未找到有效的更新包下载地址');
  }

  const tmpDir = path.join(PLUGIN_ROOT, '.update_tmp');
  const zipPath = path.join(tmpDir, 'package.zip');
  const extractDir = path.join(tmpDir, 'extracted');
  const backupDir = path.join(tmpDir, 'backup');

  // Prepare clean working dir
  if (fs.existsSync(tmpDir)) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
  fs.mkdirSync(tmpDir, { recursive: true });

  // 1. Download
  onProgress({ stage: 'downloading', percent: 10, message: '正在下载最新版本...' });
  let downloadSuccess = false;
  try {
    await downloadFile(updateInfo.downloadUrl, zipPath, p => {
      onProgress({ stage: 'downloading', percent: Math.round(10 + p * 0.5), message: `下载中 (${p}%)...` });
    });
    downloadSuccess = true;
  } catch (err) {
    // Try download accelerator proxy
    try {
      const proxyUrl = `https://ghproxy.net/${updateInfo.downloadUrl}`;
      await downloadFile(proxyUrl, zipPath, p => {
        onProgress({ stage: 'downloading', percent: Math.round(10 + p * 0.5), message: `通过镜像节点下载中 (${p}%)...` });
      });
      downloadSuccess = true;
    } catch (proxyErr) {
      throw new Error(`下载更新失败: ${err.message}`);
    }
  }

  // 2. Extract
  onProgress({ stage: 'extracting', percent: 65, message: '正在解压并校验安装包...' });
  extractArchive(zipPath, extractDir);

  // Locate extracted source directory (skip top-level wrapper if exists)
  let sourceDir = extractDir;
  const items = fs.readdirSync(extractDir);
  for (const item of items) {
    const candidate = path.join(extractDir, item);
    if (fs.statSync(candidate).isDirectory() && fs.existsSync(path.join(candidate, 'plugin.json'))) {
      sourceDir = candidate;
      break;
    }
  }

  if (!fs.existsSync(path.join(sourceDir, 'plugin.json'))) {
    throw new Error('更新包损坏：未找到核心配置文件 plugin.json');
  }

  // Read new version from extracted bundle
  const newPluginData = JSON.parse(fs.readFileSync(path.join(sourceDir, 'plugin.json'), 'utf8'));
  const newVersion = newPluginData.version || updateInfo.latestVersion;

  // 3. Backup current files
  onProgress({ stage: 'installing', percent: 80, message: '备份当前版本并原子覆写...' });
  fs.mkdirSync(backupDir, { recursive: true });
  const criticalItems = ['scripts', 'sidecars', 'assets', 'plugin.json', 'install.sh', 'install.ps1', 'uninstall.sh', 'uninstall.ps1', 'README.md'];
  for (const item of criticalItems) {
    const src = path.join(PLUGIN_ROOT, item);
    if (fs.existsSync(src)) {
      const dest = path.join(backupDir, item);
      if (fs.statSync(src).isDirectory()) {
        copyDirSync(src, dest);
      } else {
        fs.copyFileSync(src, dest);
      }
    }
  }

  // 4. Overwrite with new files
  try {
    copyDirSync(sourceDir, PLUGIN_ROOT);
  } catch (err) {
    // Rollback from backup on error
    for (const item of criticalItems) {
      const bSrc = path.join(backupDir, item);
      if (fs.existsSync(bSrc)) {
        const rDest = path.join(PLUGIN_ROOT, item);
        if (fs.statSync(bSrc).isDirectory()) {
          copyDirSync(bSrc, rDest);
        } else {
          fs.copyFileSync(bSrc, rDest);
        }
      }
    }
    throw new Error(`文件更新失败，已安全回滚: ${err.message}`);
  }

  // 4.1 Clean obsolete directories from older versions (e.g. rules, redundant scripts)
  const obsoleteDirs = ['rules', path.join('sidecars', 'context-panel', 'scripts')];
  for (const obs of obsoleteDirs) {
    const obsPath = path.join(PLUGIN_ROOT, obs);
    if (fs.existsSync(obsPath)) {
      try { fs.rmSync(obsPath, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // Clean temp directory
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}

  // 5. Trigger Restart
  onProgress({ stage: 'restarting', percent: 95, message: '正在热重载后台服务...' });
  setTimeout(() => {
    restartSidecarService().catch(() => {});
  }, 800);

  return {
    success: true,
    message: `已成功升级至 v${newVersion}`,
    oldVersion: currentVersion,
    newVersion
  };
}
