/**
 * @fileoverview Context Window Unlocker & Preset Manager for Antigravity (agy-context)
 * Bridges agy-patch.py to detect, unlock, version-safely restore, and configure context window presets
 * across macOS, Linux, and Windows.
 * @author q1u
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(__dirname, '..');
export const AGY_PATCH_PY = path.join(__dirname, 'agy-patch.py');

// Configuration & version-bound backup directory for agy-context plugin
const USER_CONFIG_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'plugin_data', 'agy-context');
const CONFIG_FILE = path.join(USER_CONFIG_DIR, 'context-settings.json');
const BACKUPS_DIR = path.join(USER_CONFIG_DIR, 'backups');
const BACKUP_META_FILE = path.join(BACKUPS_DIR, 'backup-meta.json');

// Supported presets and their nominal/effective token budget
export const PRESET_LIMITS = {
  '900k': 900000,  // 900K token budget
  '512k': 512000,  // 512K token budget
  '256k': 256000   // 256K nominal official clamp limit
};

let cachedPythonCmd = null;
let targetBinariesCache = null;
const appVersionCache = new Map();
const unlockInspectCache = new Map();

export function clearUnlockCaches() {
  targetBinariesCache = null;
  appVersionCache.clear();
  unlockInspectCache.clear();
}

function getBinaryStatSig(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

/**
 * Resolves an active, working Python 3 executable across platforms.
 * Handles Windows Store app execution aliases, py launcher, and custom installation paths.
 * @returns {string} Executable command or absolute path
 */
export function resolvePython() {
  if (cachedPythonCmd) return cachedPythonCmd;

  const isWin = process.platform === 'win32';
  const candidates = [];

  if (isWin) {
    candidates.push(
      path.join(os.homedir(), '.local', 'bin', 'python3.12.exe'),
      path.join(os.homedir(), '.local', 'bin', 'python3.exe'),
      path.join(os.homedir(), '.local', 'bin', 'python.exe')
    );
    if (process.env.LOCALAPPDATA) {
      candidates.push(
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python313', 'python.exe'),
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe'),
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python311', 'python.exe'),
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python310', 'python.exe')
      );
    }
  }

  candidates.push('python3', 'python', 'py', 'python3.12');

  for (const cmd of candidates) {
    try {
      if (cmd.includes(path.sep) && !fs.existsSync(cmd)) continue;
      const res = cp.execSync(`"${cmd}" --version`, {
        timeout: 2500,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      if (res && (res.includes('Python 3') || res.includes('Python'))) {
        cachedPythonCmd = cmd;
        return cmd;
      }
    } catch (e) {}
  }

  cachedPythonCmd = isWin ? 'python' : 'python3';
  return cachedPythonCmd;
}

/**
 * Computes SHA-256 hex digest of a file using chunked reads (low memory footprint for 200MB+ binaries).
 * @param {string} filePath
 * @returns {string|null}
 */
export function computeFileSha256(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  let fd = null;
  try {
    const hash = crypto.createHash('sha256');
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024); // 4MB chunks
    fd = fs.openSync(filePath, 'r');
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } catch (e) {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/**
 * Detects the installed Antigravity desktop or CLI version across macOS, Windows, and Linux.
 * @param {string} binaryPath
 * @param {boolean} isDesktop
 * @returns {string|null}
 */
export function detectAppVersion(binaryPath, isDesktop) {
  if (!binaryPath || !fs.existsSync(binaryPath)) return null;

  const statSig = getBinaryStatSig(binaryPath);
  const cacheKey = statSig ? `${binaryPath}|${isDesktop ? 'desktop' : 'cli'}|${statSig}` : null;
  if (cacheKey && appVersionCache.has(cacheKey)) {
    return appVersionCache.get(cacheKey);
  }

  let detected = null;
  try {
    if (isDesktop) {
      if (process.platform === 'darwin') {
        // /Applications/Antigravity.app/Contents/Resources/bin/language_server -> ../../Info.plist
        const plistPath = path.resolve(path.dirname(binaryPath), '..', '..', 'Info.plist');
        if (fs.existsSync(plistPath)) {
          const content = fs.readFileSync(plistPath, 'utf8');
          const m = content.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
          if (m && m[1]) detected = m[1].trim();
        }
      } else if (process.platform === 'win32') {
        // .../antigravity/resources/bin/language_server.exe -> ../../Antigravity.exe
        const exePath = path.resolve(path.dirname(binaryPath), '..', '..', 'Antigravity.exe');
        if (fs.existsSync(exePath)) {
          const escaped = exePath.replace(/'/g, "''");
          const ver = cp.execSync(
            `powershell -NoProfile -Command "(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion"`,
            { timeout: 3000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }
          ).trim();
          if (ver) detected = ver.replace(/\.0$/, '');
        }
      } else {
        // Linux: check resources/app/package.json or ../package.json
        const pkgCandidates = [
          path.resolve(path.dirname(binaryPath), '..', 'app', 'package.json'),
          path.resolve(path.dirname(binaryPath), '..', '..', 'package.json')
        ];
        for (const p of pkgCandidates) {
          if (fs.existsSync(p)) {
            const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (pkg.version) {
              detected = String(pkg.version).trim();
              break;
            }
          }
        }
      }
    } else {
      // agy CLI
      const out = cp.execFileSync(binaryPath, ['--version'], {
        timeout: 2500,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true
      }).trim();
      const m = out.match(/(\d+\.\d+\.\d+[^\s]*)/);
      if (m) detected = m[1];
      else if (out) detected = out.split(/\r?\n/)[0].trim();
    }
  } catch (e) {}

  if (cacheKey) {
    appVersionCache.set(cacheKey, detected);
  }
  return detected;
}

/**
 * Reads version-bound backup metadata manifest.
 * @returns {Record<string, any>}
 */
function readBackupMeta() {
  try {
    if (fs.existsSync(BACKUP_META_FILE)) {
      return JSON.parse(fs.readFileSync(BACKUP_META_FILE, 'utf8')) || {};
    }
  } catch (e) {}
  return {};
}

/**
 * Persists version-bound backup metadata manifest atomically.
 * @param {Record<string, any>} meta
 */
function writeBackupMeta(meta) {
  try {
    if (!fs.existsSync(BACKUPS_DIR)) {
      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    }
    const tmp = `${BACKUP_META_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
    fs.renameSync(tmp, BACKUP_META_FILE);
  } catch (e) {}
}

/**
 * Sweeps stale .old.<pid>, .restore.tmp.<pid>, .tmp.<pid>, and .stale.* files next to target binary.
 * Locked files (still held by running processes on Windows) are skipped silently.
 * @param {string} binaryPath
 */
function cleanupStaleTempFiles(binaryPath) {
  if (!binaryPath) return;
  try {
    const dir = path.dirname(binaryPath);
    const base = path.basename(binaryPath);
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir);
    for (const name of entries) {
      if (
        name.startsWith(`${base}.old.`) ||
        name.startsWith(`${base}.restore.tmp.`) ||
        name.startsWith(`${base}.tmp.`) ||
        name.startsWith(`${base}.stale.`)
      ) {
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch (e) {
          // Still locked by a running process on Windows; will be cleaned on a future run
        }
      }
    }
  } catch (e) {}
}

/**
 * Resolves candidate binary paths across macOS, Linux, and Windows.
 * @returns {{ desktop: string|null, cli: string|null }}
 */
export function resolveTargetBinaries(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && targetBinariesCache && (now - targetBinariesCache.ts < 60000)) {
    return targetBinariesCache.value;
  }

  const result = { desktop: null, cli: null };
  const isWin = process.platform === 'win32';

  // 1. Desktop Language Server Candidates
  const desktopCandidates = [
    // Windows
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Antigravity', 'resources', 'bin', 'language_server.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Antigravity', 'resources', 'bin', 'language_server.exe'),
    // macOS
    '/Applications/Antigravity.app/Contents/Resources/bin/language_server',
    path.join(os.homedir(), 'Applications/Antigravity.app/Contents/Resources/bin/language_server'),
    // Linux
    '/usr/lib/antigravity/resources/bin/language_server',
    '/opt/antigravity/resources/bin/language_server',
    path.join(os.homedir(), '.local', 'share', 'antigravity', 'resources', 'bin', 'language_server')
  ];

  // Fast static path scan first, avoiding slow PowerShell process inspection when binary exists at standard path
  for (const p of desktopCandidates) {
    if (fs.existsSync(p)) {
      result.desktop = p;
      break;
    }
  }

  if (!result.desktop) {
    try {
      if (isWin) {
        const psCmd = 'Get-Process -Name language_server -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path | Select-Object -First 1';
        const psOut = cp.execSync(`powershell -NoProfile -Command "${psCmd}"`, {
          timeout: 3000,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true
        }).trim();
        if (psOut && fs.existsSync(psOut)) {
          result.desktop = psOut;
        }
      } else {
        const ps = cp.execSync('ps aux | grep -E "language_server --standalone" | grep -v grep', {
          encoding: 'utf8',
          timeout: 3000,
          stdio: ['pipe', 'pipe', 'ignore']
        });
        const match = ps.match(/(\/[^\s]+language_server)/);
        if (match && fs.existsSync(match[1])) {
          result.desktop = match[1];
        }
      }
    } catch (e) {}
  }

  // 2. agy CLI Candidates
  const cliCandidates = [
    // Windows
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe'),
    path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agy.exe'),
    path.join(os.homedir(), '.local', 'bin', 'agy.exe'),
    // macOS / Linux
    path.join(os.homedir(), '.local', 'bin', 'agy'),
    path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agy'),
    '/usr/local/bin/agy'
  ];

  for (const p of cliCandidates) {
    if (fs.existsSync(p)) {
      result.cli = p;
      break;
    }
  }

  if (!result.cli) {
    try {
      const whichCmd = isWin ? 'where.exe agy' : 'which agy';
      const whichAgy = cp.execSync(whichCmd, {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true
      }).trim();
      const firstLine = whichAgy.split(/\r?\n/)[0].trim();
      if (firstLine && fs.existsSync(firstLine)) {
        result.cli = firstLine;
      }
    } catch (e) {}
  }

  if (result.desktop || result.cli) {
    targetBinariesCache = { ts: now, value: result };
  }
  return result;
}

/**
 * Runs agy-patch.py --dry-run and classifies whether the binary is clean official unpatched,
 * patched at the target preset, or patched at a different preset.
 * @param {string} binaryPath
 * @param {number|null} targetLimit
 * @returns {Promise<{output: string, isUnlockedAtPreset: boolean, isOfficialUnpatched: boolean, isPatchedAny: boolean}>}
 */
function runPatchDryRun(binaryPath, targetLimit) {
  const py = resolvePython();
  const args = [AGY_PATCH_PY, '--binary', binaryPath, '--dry-run'];
  if (targetLimit && targetLimit > 0) {
    args.push('--limit', String(targetLimit));
  } else {
    args.push('--limit', '0');
  }

  return new Promise((resolve) => {
    cp.execFile(py, args, { timeout: 15000 }, (err, stdout, stderr) => {
      const output = `${stdout || ''}\n${stderr || ''}`.trim();
      const gate3bPatched = output.includes('[=] [Gate 3B]');
      const gate3bUnpatched = output.includes('[*] [Gate 3B]');
      const gate2Patched = output.includes('[=] [Gate 2]');
      const gate2Unpatched = output.includes('[*] [Gate 2]');

      // Clean official unpatched: Gate 3B has not been bypassed (and Gate 2, if present, has not been bypassed)
      const isOfficialUnpatched = gate3bUnpatched && !gate3bPatched && !gate2Patched;
      const isPatchedAny = gate3bPatched || gate2Patched;
      const isUnlockedAtPreset = output.includes('all gates already unlocked; nothing to write') ||
        (output.includes('[=]') && !output.includes('[*]') && isPatchedAny);

      resolve({
        output,
        isUnlockedAtPreset,
        isOfficialUnpatched,
        isPatchedAny
      });
    });
  });
}

/**
 * Executes agy-patch.py dry-run to determine whether a binary is unlocked and whether a valid version-matched backup exists.
 * @param {string} binaryPath
 * @param {'desktop'|'cli'} [key='desktop']
 * @returns {Promise<{path: string, exists: boolean, isUnlocked: boolean, isOfficialUnpatched: boolean, details: string, hasBackup: boolean, appVersion: string|null}>}
 */
export async function inspectBinaryUnlock(binaryPath, key = 'desktop') {
  if (!binaryPath || !fs.existsSync(binaryPath)) {
    return {
      path: binaryPath,
      exists: false,
      isUnlocked: false,
      isOfficialUnpatched: false,
      details: 'Binary not found',
      hasBackup: false,
      appVersion: null
    };
  }

  const preset = getSavedPreset();
  const limitArg = preset.targetLimit ?? 512000;
  const statSig = getBinaryStatSig(binaryPath);
  const meta = readBackupMeta()[key];
  const bakSig = meta?.backupPath ? (getBinaryStatSig(meta.backupPath) || 'missing') : 'none';
  const cacheKey = statSig ? `${key}|${binaryPath}|${statSig}|${preset.preset}|${limitArg}|${bakSig}` : null;
  if (cacheKey && unlockInspectCache.has(cacheKey)) {
    return unlockInspectCache.get(cacheKey);
  }

  const dry = await runPatchDryRun(binaryPath, limitArg);
  const appVersion = detectAppVersion(binaryPath, key === 'desktop');

  // Check if a valid version-bound backup exists for this binary
  let hasValidBackup = false;
  if (meta && meta.backupPath && fs.existsSync(meta.backupPath)) {
    if (!meta.appVersion || !appVersion || meta.appVersion === appVersion) {
      hasValidBackup = true;
    }
  }

  const result = {
    path: binaryPath,
    exists: true,
    isUnlocked: dry.isUnlockedAtPreset,
    isOfficialUnpatched: dry.isOfficialUnpatched,
    details: dry.output,
    hasBackup: hasValidBackup,
    appVersion
  };
  if (cacheKey) {
    unlockInspectCache.set(cacheKey, result);
  }
  return result;
}

/**
 * Gets overall unlock status for both Desktop and CLI
 * @param {{ forceRefresh?: boolean }} [options]
 * @returns {Promise<{desktop: any, cli: any, activePreset: string, targetLimit: number|null}>}
 */
export async function getOverallUnlockStatus({ forceRefresh = false } = {}) {
  if (forceRefresh) {
    clearUnlockCaches();
  }
  const binaries = resolveTargetBinaries(forceRefresh);
  const [desktopStatus, cliStatus] = await Promise.all([
    binaries.desktop ? inspectBinaryUnlock(binaries.desktop, 'desktop') : Promise.resolve(null),
    binaries.cli ? inspectBinaryUnlock(binaries.cli, 'cli') : Promise.resolve(null)
  ]);

  const preset = getSavedPreset();
  return {
    desktop: desktopStatus,
    cli: cliStatus,
    activePreset: preset.preset,
    targetLimit: preset.targetLimit
  };
}

/**
 * Safely replaces a destination binary file atomically, handling Windows process locking cleanly
 * without leaving orphaned temp files behind.
 * @param {string} srcFile Temporary prepared file path (will be moved to dstFile)
 * @param {string} dstFile Destination file path
 */
function safeReplaceBinary(srcFile, dstFile) {
  if (process.platform === 'win32') {
    try {
      // Try direct rename/replace first (works when binary is not running)
      fs.renameSync(srcFile, dstFile);
    } catch (err) {
      // Binary is locked by a running process on Windows: rename running binary away first, then move srcFile into place
      const oldFile = `${dstFile}.old.${process.pid}`;
      try {
        if (fs.existsSync(oldFile)) {
          try { fs.unlinkSync(oldFile); } catch {}
        }
        fs.renameSync(dstFile, oldFile);
        fs.renameSync(srcFile, dstFile);
      } catch (e2) {
        throw err;
      }
    }
  } else {
    // POSIX atomic replace (refreshes inode & macOS cs_blob cache)
    fs.renameSync(srcFile, dstFile);
  }
}

/**
 * Ensures a clean, version-matched official backup exists before patching.
 * If Antigravity updated to a new official version, automatically refreshes the backup so stale versions never persist.
 * @param {{ key: 'desktop'|'cli', name: string, path: string, isDesktop: boolean }} item
 * @param {boolean} isOfficialUnpatched
 * @returns {{ refreshed: boolean, appVersion: string|null, origSha256: string|null }}
 */
function ensureVersionSafeBackup(item, isOfficialUnpatched) {
  const metaAll = readBackupMeta();
  const existing = metaAll[item.key];
  const currentSha = computeFileSha256(item.path);
  const appVersion = detectAppVersion(item.path, item.isDesktop);

  if (!isOfficialUnpatched) {
    // Binary is already patched (e.g. changing 512K -> 900K). Keep the clean original backup untouched.
    return {
      refreshed: false,
      appVersion: existing?.appVersion || appVersion,
      origSha256: existing?.origSha256 || null
    };
  }

  const backupFileName = `${item.key}_${path.basename(item.path)}.orig`;
  const backupPath = path.join(BACKUPS_DIR, backupFileName);
  const needsRefresh =
    !existing ||
    !existing.backupPath ||
    !fs.existsSync(existing.backupPath) ||
    existing.origSha256 !== currentSha ||
    (appVersion && existing.appVersion && existing.appVersion !== appVersion);

  if (needsRefresh && currentSha) {
    if (!fs.existsSync(BACKUPS_DIR)) {
      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    }
    const tmpBak = `${backupPath}.tmp.${process.pid}`;
    try {
      fs.copyFileSync(item.path, tmpBak);
      fs.renameSync(tmpBak, backupPath);
      metaAll[item.key] = {
        binaryPath: item.path,
        appVersion,
        origSha256: currentSha,
        patchedSha256: null,
        origSize: fs.statSync(item.path).size,
        backupPath,
        backedUpAt: new Date().toISOString()
      };
      writeBackupMeta(metaAll);
      return { refreshed: true, appVersion, origSha256: currentSha };
    } catch (e) {
      if (fs.existsSync(tmpBak)) {
        try { fs.unlinkSync(tmpBak); } catch {}
      }
    }
  }

  return { refreshed: false, appVersion, origSha256: currentSha };
}

/**
 * Unlocks the specified binary or all detected binaries with version-bound backup management.
 * @param {'desktop'|'cli'|'all'} [target='all']
 * @returns {Promise<{success: boolean, message: string, output: string}>}
 */
export async function applyUnlock(target = 'all') {
  const binaries = resolveTargetBinaries(true);
  const targets = [];
  if ((target === 'desktop' || target === 'all') && binaries.desktop) {
    targets.push({ key: 'desktop', name: '桌面端 Language Server', path: binaries.desktop, isDesktop: true });
  }
  if ((target === 'cli' || target === 'all') && binaries.cli) {
    targets.push({ key: 'cli', name: 'agy CLI 终端', path: binaries.cli, isDesktop: false });
  }

  if (targets.length === 0) {
    return { success: false, message: '未找到可解锁的目标二进制文件', output: '' };
  }

  const results = [];
  let allSuccess = true;
  const py = resolvePython();
  const preset = getSavedPreset();

  for (const item of targets) {
    cleanupStaleTempFiles(item.path);

    // 1. Check whether target is clean official unpatched; if so, create/refresh version-bound backup
    const preCheck = await runPatchDryRun(item.path, preset.targetLimit ?? 0);
    const bakInfo = ensureVersionSafeBackup(item, preCheck.isOfficialUnpatched);

    // 2. Patch binary in-place (skip legacy .bak next to binary; backups live cleanly in BACKUPS_DIR)
    const res = await new Promise((resolve) => {
      const args = [AGY_PATCH_PY, '--binary', item.path, '--in-place', '--no-backup'];
      args.push('--limit', String(preset.targetLimit || 512000));

      cp.execFile(py, args, { timeout: 30000 }, (err, stdout, stderr) => {
        const out = `${stdout || ''}\n${stderr || ''}`.trim();
        if (err && !out.includes('all gates already unlocked')) {
          resolve({ success: false, name: item.name, output: out, error: err.message });
        } else {
          const bakNote = bakInfo.refreshed
            ? `[i] 已更新官方原版安全备份 (${bakInfo.appVersion ? `v${bakInfo.appVersion}, ` : ''}sha256:${(bakInfo.origSha256 || '').slice(0, 12)})\n`
            : '';
          resolve({ success: true, name: item.name, output: `${bakNote}${out}` });
        }
      });
    });

    // 3. Record patched SHA-256 into backup-meta.json to prevent cross-version downgrade on future restore
    if (res.success) {
      const newSha = computeFileSha256(item.path);
      if (newSha) {
        const metaAll = readBackupMeta();
        if (metaAll[item.key]) {
          metaAll[item.key].patchedSha256 = newSha;
          metaAll[item.key].patchedAt = new Date().toISOString();
          writeBackupMeta(metaAll);
        }
      }
    }

    cleanupStaleTempFiles(item.path);
    results.push(res);
    if (!res.success) allSuccess = false;
  }

  const outputSummary = results.map(r => `[${r.name}] ${r.success ? '解锁成功' : '失败'}\n${r.output}`).join('\n\n');
  clearUnlockCaches();
  const restartHint = process.platform === 'darwin'
    ? '请完全退出并重启 Antigravity 应用（Cmd+Q）以加载新进程。'
    : '请完全退出并重启 Antigravity 应用（在任务栏/托盘退出后重新打开）以加载新进程。';

  return {
    success: allSuccess,
    message: allSuccess ? `目标上下文已成功解锁！${restartHint}` : '解锁过程中遇到部分异常，请查看详情。',
    output: outputSummary
  };
}

/**
 * Restores original backup for the specified target with strict version & SHA-256 anti-downgrade guards.
 * Works safely across macOS (preserving authentic Apple/Google codesign), Linux, and Windows.
 * @param {'desktop'|'cli'|'all'} [target='all']
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function restoreOriginal(target = 'all') {
  const binaries = resolveTargetBinaries(true);
  const targets = [];
  if ((target === 'desktop' || target === 'all') && binaries.desktop) {
    targets.push({ key: 'desktop', name: '桌面端 language_server', path: binaries.desktop, isDesktop: true, codesignId: 'language_server' });
  }
  if ((target === 'cli' || target === 'all') && binaries.cli) {
    targets.push({ key: 'cli', name: 'agy CLI', path: binaries.cli, isDesktop: false, codesignId: 'cli' });
  }

  if (targets.length === 0) {
    return { success: false, message: '未检测到目标二进制文件' };
  }

  const messages = [];
  let anyRestored = false;
  let anyAlreadyOfficial = false;
  let anyBlocked = false;
  const metaAll = readBackupMeta();

  try {
    for (const item of targets) {
      cleanupStaleTempFiles(item.path);

      const currentVersion = detectAppVersion(item.path, item.isDesktop);
      const currentSha = computeFileSha256(item.path);
      const dry = await runPatchDryRun(item.path, 0);

      // Guard 1: Already official unpatched binary -> NEVER overwrite with any backup!
      if (dry.isOfficialUnpatched) {
        messages.push(`${item.name} 当前已是官方原版${currentVersion ? ` (v${currentVersion})` : ''}，无需还原`);
        anyAlreadyOfficial = true;
        continue;
      }

      const meta = metaAll[item.key];
      // Guard 2: Require version-bound backup metadata (do NOT blindly trust legacy Desktop backups)
      if (!meta || !meta.backupPath || !fs.existsSync(meta.backupPath)) {
        messages.push(`${item.name} 未找到与当前版本绑定的安全备份（已拒绝使用无版本校验的旧备份以防降级）`);
        anyBlocked = true;
        continue;
      }

      // Guard 3: Strict version & patched SHA-256 binding
      if (meta.appVersion && currentVersion && meta.appVersion !== currentVersion) {
        messages.push(`${item.name} 备份属于旧版本 (v${meta.appVersion})，当前版本为 v${currentVersion}，已阻止还原以防止降级`);
        anyBlocked = true;
        continue;
      }
      if (meta.patchedSha256 && currentSha && meta.patchedSha256 !== currentSha) {
        messages.push(`${item.name} 当前文件与上次补丁记录的哈希不匹配（可能已被官方更新覆盖），已阻止还原以防止降级`);
        anyBlocked = true;
        continue;
      }

      // Guard 4: Verify backup file integrity before replacing
      const backupSha = computeFileSha256(meta.backupPath);
      if (meta.origSha256 && backupSha !== meta.origSha256) {
        messages.push(`${item.name} 备份文件完整性校验失败，已中止还原`);
        anyBlocked = true;
        continue;
      }

      // Perform clean atomic restore with guaranteed temp-file cleanup
      const tmpFile = `${item.path}.restore.tmp.${process.pid}`;
      try {
        fs.copyFileSync(meta.backupPath, tmpFile);
        if (process.platform !== 'win32') {
          fs.chmodSync(tmpFile, 0o755);
        }

        if (process.platform === 'darwin') {
          // Preserve genuine official Apple/Google signature if valid; only ad-hoc resign if verification fails
          let sigValid = false;
          try {
            cp.execSync(`codesign --verify --strict "${tmpFile}"`, { stdio: 'ignore' });
            sigValid = true;
          } catch (e) {}

          if (!sigValid) {
            try {
              cp.execSync(`codesign --force --sign - --options runtime --identifier ${item.codesignId} "${tmpFile}"`, { stdio: 'ignore' });
            } catch (e) {
              try {
                cp.execSync(`codesign --force --sign - "${tmpFile}"`, { stdio: 'ignore' });
              } catch (e2) {}
            }
          }
        }

        safeReplaceBinary(tmpFile, item.path);

        // Update metadata to reflect restored state
        meta.patchedSha256 = null;
        meta.restoredAt = new Date().toISOString();
        writeBackupMeta(metaAll);

        messages.push(`已安全恢复官方原版 ${item.name}${currentVersion ? ` (v${currentVersion})` : ''} (需重启应用生效)`);
        anyRestored = true;
      } finally {
        if (fs.existsSync(tmpFile)) {
          try { fs.unlinkSync(tmpFile); } catch {}
        }
        cleanupStaleTempFiles(item.path);
      }
    }

    if (anyRestored) {
      clearUnlockCaches();
      return { success: true, message: messages.join('；') + '。' };
    }
    if (anyAlreadyOfficial && !anyBlocked) {
      clearUnlockCaches();
      return { success: true, message: messages.join('；') + '。' };
    }
    return {
      success: false,
      message: messages.length > 0 ? messages.join('；') + '。' : '未找到可供安全还原的备份文件'
    };
  } catch (err) {
    return { success: false, message: `恢复失败: ${err.message}` };
  }
}

/**
 * Reads user saved preset from local plugin data
 * @returns {{ preset: string, targetLimit: number|null }}
 */
export function getSavedPreset() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const rawPreset = data.preset;
      const preset = Object.prototype.hasOwnProperty.call(PRESET_LIMITS, rawPreset) ? rawPreset : '512k';
      return {
        preset,
        targetLimit: PRESET_LIMITS[preset]
      };
    }
  } catch (e) {}

  return { preset: '512k', targetLimit: PRESET_LIMITS['512k'] };
}

/**
 * Saves chosen preset to plugin data and synchronizes to CLI settings.json if exists
 * @param {string} preset ('900k' | '512k' | '256k')
 * @returns {{ preset: string, targetLimit: number, syncedCli: boolean }}
 */
export function savePreset(preset) {
  const validKey = Object.prototype.hasOwnProperty.call(PRESET_LIMITS, preset) ? preset : '512k';
  try {
    if (!fs.existsSync(USER_CONFIG_DIR)) {
      fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      preset: validKey,
      updatedAt: new Date().toISOString()
    }, null, 2), 'utf8');
  } catch (e) {}

  // Synchronize with ~/.gemini/antigravity-cli/settings.json if it exists
  let syncedCli = false;
  try {
    const cliSettingsPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
    if (fs.existsSync(cliSettingsPath)) {
      const settings = JSON.parse(fs.readFileSync(cliSettingsPath, 'utf8'));
      let cwVal = '512K';
      if (validKey === '900k') cwVal = '900K';
      else if (validKey === '256k') cwVal = '256K';

      settings.contextWindow = cwVal;
      fs.writeFileSync(cliSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
      syncedCli = true;
    }
  } catch (e) {}

  return {
    preset: validKey,
    targetLimit: PRESET_LIMITS[validKey],
    syncedCli
  };
}
