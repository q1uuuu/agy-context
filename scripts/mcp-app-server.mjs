/**
 * @fileoverview Zero-dependency stdio MCP App Server for Antigravity Context Inspector.
 * Exposes the full-page Left Sidebar dashboard (`global` entrypoint) and app-only
 * backend tools sharing the exact same scripts/*.mjs engine as the right Sidecar.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  analyzeTranscript,
  analyzeGlobalTokensAsync,
  resolveTranscriptPath,
  warmupGlobalTokenIndex,
  getCachedWeeklyTokenSummary
} from './context-analyzer.mjs';
import {
  getTaskMonitorData,
  markTaskRead,
  markAllTasksRead,
  getActivityHeatmapAsync
} from './task-monitor.mjs';
import {
  fetchAccountQuota,
  listAccounts,
  captureCurrentAccountSnapshotAsync,
  switchAccountAsync,
  updateAccountAliasAsync,
  deleteAccountAsync,
  restartAntigravityApp
} from './account-manager.mjs';
import {
  getOverallUnlockStatus,
  applyUnlock,
  restoreOriginal,
  savePreset,
  getSavedPreset
} from './context-unlocker.mjs';
import {
  checkForUpdates,
  applyOneClickUpdate,
  getLocalVersion
} from './updater.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const APP_DATA_DIR = process.env.ANTIGRAVITY_APP_DATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity');
const DASHBOARD_URI = 'ui://agy-context/dashboard.html';
const DASHBOARD_MIME = 'text/html;profile=mcp-app';
const LOGO_PATH = path.join(PLUGIN_ROOT, 'assets', 'logo.svg');
const DEFAULT_HTML_PATH = path.join(PLUGIN_ROOT, 'mcp-app', 'dashboard.html');

const APP_ONLY_META = {
  ui: { visibility: ['app'] }
};

const TOOLS = [
  {
    name: 'open_context_dashboard',
    title: 'Context Inspector',
    description: 'Open the full-screen Antigravity Context Inspector dashboard (multi-task monitor, activity heatmap, token analytics, accounts, and unlock controls).',
    inputSchema: {
      type: 'object',
      properties: {
        tab: {
          type: 'string',
          description: 'Optional initial section: overview, tasks, analytics, accounts, sessions, system'
        }
      }
    },
    _meta: {
      ui: {
        resourceUri: DASHBOARD_URI
      },
      'com.google.antigravity/ui': {
        entrypoints: [
          {
            type: 'global',
            title: 'Context Inspector'
          }
        ]
      }
    }
  },
  {
    name: 'app_get_tasks',
    title: 'Get Monitored Tasks',
    description: 'Fetch running tasks, completed-unread conversations, step progress, and recent sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionLimit: { type: 'number' }
      }
    },
    _meta: APP_ONLY_META
  },
  {
    name: 'app_mark_task_read',
    title: 'Mark Task Read',
    description: 'Mark one or all completed-unread conversations as read in the dashboard monitor.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string' },
        updateTimeMs: { type: 'number' },
        all: { type: 'boolean' },
        items: { type: 'array' }
      }
    },
    _meta: APP_ONLY_META
  },
  {
    name: 'app_get_heatmap',
    title: 'Get Activity Heatmap',
    description: 'Fetch 365-day activity heatmap, streaks, peak day, and aggregate summary metrics.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number' },
        force: { type: 'boolean' }
      }
    },
    _meta: APP_ONLY_META
  },
  {
    name: 'app_get_global_tokens',
    title: 'Get Global Token Analytics',
    description: 'Fetch token usage, cost estimates, hourly/daily histogram, and model distribution.',
    inputSchema: {
      type: 'object',
      properties: {
        range: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
        force: { type: 'boolean' }
      }
    },
    _meta: APP_ONLY_META
  },
  {
    name: 'app_get_session_detail',
    title: 'Get Session Context Detail',
    description: 'Analyze a specific conversation transcript for context window usage, timeline, breakdown, and performance.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string' }
      }
    },
    _meta: APP_ONLY_META
  },
  {
    name: 'app_get_accounts_quota',
    title: 'Get Accounts And Quota',
    description: 'Fetch live account quota groups and saved multi-account snapshots.',
    inputSchema: {
      type: 'object',
      properties: {
        force: { type: 'boolean' }
      }
    },
    _meta: APP_ONLY_META
  },
  {
    name: 'app_account_action',
    title: 'Manage Accounts',
    description: 'Capture, switch, alias, delete saved account snapshots, or restart Antigravity.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        accountId: { type: 'string' },
        alias: { type: 'string' }
      }
    },
    _meta: APP_ONLY_META
  },
  {
    name: 'app_unlock_action',
    title: 'Manage Context Unlock',
    description: 'Inspect unlock status, set preset budget, apply binary unlock, or restore backup.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        force: { type: 'boolean' },
        preset: { type: 'string' },
        target: { type: 'string' }
      }
    },
    _meta: APP_ONLY_META
  },
  {
    name: 'app_update_action',
    title: 'Manage Plugin Updates',
    description: 'Check GitHub releases or trigger one-click update.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string' }
      }
    },
    _meta: APP_ONLY_META
  }
];

function readDashboardHtml() {
  const customPath = process.env.AGY_CONTEXT_DASHBOARD_HTML;
  const htmlPath = customPath && fs.existsSync(customPath) ? customPath : DEFAULT_HTML_PATH;
  let html = fs.readFileSync(htmlPath, 'utf8');
  if (fs.existsSync(LOGO_PATH) && html.includes('__AGY_LOGO_DATA_URI__')) {
    const svg = fs.readFileSync(LOGO_PATH, 'utf8');
    const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
    html = html.replaceAll('__AGY_LOGO_DATA_URI__', dataUri);
  }
  return html;
}

function toolOk(textSummary, structuredContent) {
  return {
    content: [{ type: 'text', text: textSummary }],
    structuredContent
  };
}

function toolError(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: String(message || 'Unknown error') }],
    structuredContent: { error: String(message || 'Unknown error') }
  };
}

async function handleToolCall(name, args = {}) {
  switch (name) {
    case 'open_context_dashboard': {
      const version = getLocalVersion();
      const preset = getSavedPreset();
      const tasks = await getTaskMonitorData({ sessionLimit: 40 }).catch(() => null);
      const summaryText = tasks
        ? `Context Inspector v${version} opened: ${tasks.counts.running} running task(s), ${tasks.counts.unread} unread completed conversation(s).`
        : `Context Inspector v${version} dashboard opened.`;
      return toolOk(summaryText, {
        initialTab: args.tab || 'overview',
        version,
        preset,
        tasks
      });
    }

    case 'app_get_tasks': {
      const limit = Math.max(1, Math.min(200, Number(args.sessionLimit) || 60));
      const data = await getTaskMonitorData({ sessionLimit: limit });
      return toolOk(`Tasks: ${data.counts.running} running, ${data.counts.unread} unread.`, data);
    }

    case 'app_mark_task_read': {
      const result = args.all
        ? markAllTasksRead(Array.isArray(args.items) ? args.items : [])
        : markTaskRead(args.conversationId, args.updateTimeMs);
      return toolOk(result.success ? 'Marked read.' : (result.error || 'Failed'), result);
    }

    case 'app_get_heatmap': {
      const data = await getActivityHeatmapAsync({
        days: Number(args.days) || 365,
        force: Boolean(args.force)
      });
      return toolOk(`Heatmap loaded: ${data.summary.totalActiveDays} active days.`, data);
    }

    case 'app_get_global_tokens': {
      const data = await analyzeGlobalTokensAsync(args.range || 'today', {
        start: args.start || '',
        end: args.end || '',
        force: Boolean(args.force)
      });
      return toolOk(`Global tokens (${data.range}): ${data.totalTokens.compact}`, data);
    }

    case 'app_get_session_detail': {
      const rawConvId = typeof args.conversationId === 'string' ? args.conversationId.trim() : '';
      let transcriptPath = null;
      let resolvedId = '';

      if (rawConvId) {
        if (!/^[a-zA-Z0-9_-]+$/.test(rawConvId)) {
          return toolError('非法的会话 ID');
        }
        const exactPath = path.join(APP_DATA_DIR, 'brain', rawConvId, '.system_generated', 'logs', 'transcript.jsonl');
        if (!fs.existsSync(exactPath)) {
          return toolError('未找到该会话的本地上下文日志（transcript.jsonl）');
        }
        transcriptPath = exactPath;
        resolvedId = rawConvId;
      } else {
        transcriptPath = resolveTranscriptPath('');
        if (!transcriptPath) {
          return toolError('未找到该会话的本地上下文日志（transcript.jsonl）');
        }
        resolvedId = transcriptPath.match(/brain[/\\]([^/\\]+)/)?.[1] || '';
      }

      const data = await analyzeTranscript(transcriptPath, { conversationId: resolvedId });
      const presetInfo = getSavedPreset();
      if (data?.overview) {
        data.overview.activePreset = presetInfo.preset;
        data.overview.targetLimit = presetInfo.targetLimit;
        if (presetInfo.targetLimit) {
          const cur = Number(data.overview.currentTotalContext) || 0;
          const lim = presetInfo.targetLimit;
          data.overview.effectiveLimit = lim;
          data.overview.usagePercent = Math.min(100, Math.round((cur / Math.max(1, lim)) * 1000) / 10);
          data.overview.remainingTokens = Math.max(0, lim - cur);
        }
      }
      return toolOk(`Session ${resolvedId} loaded.`, data);
    }

    case 'app_get_accounts_quota': {
      const force = Boolean(args.force);
      const quota = await fetchAccountQuota({ forceRefresh: force }).catch(err => ({
        available: false,
        error: err.message
      }));
      const currentEmail = quota?.account?.email || '';
      const accounts = listAccounts({ currentEmail });
      accounts.weeklyTokenSummary = getCachedWeeklyTokenSummary();
      return toolOk(`Accounts loaded (${accounts.accounts.length}).`, { quota, accounts });
    }

    case 'app_account_action': {
      const action = String(args.action || '');
      if (action === 'capture') {
        const quota = await fetchAccountQuota({ forceRefresh: true, autoCapture: false });
        if (!quota?.available || !quota?.account?.email) {
          return toolOk('Capture failed', {
            captured: false,
            error: quota?.error || '未能识别当前登录账号，请确认 Antigravity 已登录并运行中。'
          });
        }
        const captureStatus = await captureCurrentAccountSnapshotAsync(quota);
        const accounts = listAccounts({ currentEmail: quota.account.email });
        return toolOk('Account captured.', { ...captureStatus, accounts, quota });
      }
      if (action === 'switch') {
        let quota = await Promise.race([
          fetchAccountQuota({ forceRefresh: true, autoCapture: false }).catch(() => null),
          new Promise(resolve => setTimeout(() => resolve(null), 2500))
        ]);
        if (!quota?.available) {
          const cached = await fetchAccountQuota({ forceRefresh: false, autoCapture: false }).catch(() => null);
          quota = cached?.available ? cached : null;
        }
        const result = await switchAccountAsync(args.accountId, { currentQuota: quota });
        return toolOk(result.success ? 'Account switched.' : (result.error || 'Switch failed'), result);
      }
      if (action === 'alias') {
        const result = await updateAccountAliasAsync(args.accountId, args.alias);
        return toolOk(result.success ? 'Alias updated.' : (result.error || 'Alias update failed'), result);
      }
      if (action === 'delete') {
        const result = await deleteAccountAsync(args.accountId);
        return toolOk(result.success ? 'Account deleted.' : (result.error || 'Delete failed'), result);
      }
      if (action === 'restart') {
        const result = restartAntigravityApp();
        return toolOk(result.success ? 'Restart initiated.' : (result.error || 'Restart failed'), result);
      }
      return toolError(`Unsupported account action: ${action}`);
    }

    case 'app_unlock_action': {
      const action = String(args.action || 'status');
      if (action === 'status') {
        const data = await getOverallUnlockStatus({ forceRefresh: Boolean(args.force) });
        return toolOk('Unlock status loaded.', data);
      }
      if (action === 'preset') {
        const result = savePreset(args.preset || '512k');
        return toolOk('Preset saved.', result);
      }
      if (action === 'unlock') {
        const result = await applyUnlock(args.target || 'desktop');
        return toolOk(result.success ? 'Unlock applied.' : (result.message || 'Unlock failed'), result);
      }
      if (action === 'restore') {
        const result = await restoreOriginal(args.target || 'desktop');
        return toolOk(result.success ? 'Backup restored.' : (result.message || 'Restore failed'), result);
      }
      return toolError(`Unsupported unlock action: ${action}`);
    }

    case 'app_update_action': {
      const action = String(args.action || 'check');
      if (action === 'check') {
        const data = await checkForUpdates();
        return toolOk(`Current v${data.currentVersion}, latest v${data.latestVersion}`, data);
      }
      if (action === 'apply') {
        const result = await applyOneClickUpdate(() => {}, { allowSelfRespawn: false });
        return toolOk(result.message || 'Update applied.', result);
      }
      return toolError(`Unsupported update action: ${action}`);
    }

    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

function sendResponse(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendResult(id, result) {
  sendResponse({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendResponse({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg) {
  let id;
  let isNotification = true;

  try {
    const { id: reqId, method, params } = msg;
    id = reqId;
    isNotification = id === undefined || id === null;

    if (method === 'initialize') {
      const clientVersion = params?.protocolVersion || '2025-03-26';
      sendResult(id, {
        protocolVersion: clientVersion,
        capabilities: {
          tools: {},
          resources: {}
        },
        serverInfo: {
          name: 'agy-context-dashboard',
          version: getLocalVersion()
        }
      });
      return;
    }

    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return;
    }

    if (method === 'ping') {
      if (!isNotification) sendResult(id, {});
      return;
    }

    if (method === 'tools/list') {
      sendResult(id, { tools: TOOLS });
      return;
    }

    if (method === 'tools/call') {
      const result = await handleToolCall(params?.name, params?.arguments || {});
      sendResult(id, result);
      return;
    }

    if (method === 'resources/list') {
      sendResult(id, {
        resources: [
          {
            uri: DASHBOARD_URI,
            name: 'Context Inspector Dashboard',
            description: 'Antigravity Context Inspector full-screen dashboard UI',
            mimeType: DASHBOARD_MIME,
            _meta: {
              ui: {
                prefersBorder: false
              }
            }
          }
        ]
      });
      return;
    }

    if (method === 'resources/read') {
      const uri = params?.uri;
      if (uri !== DASHBOARD_URI) {
        sendError(id, -32602, `Unknown resource URI: ${uri}`);
        return;
      }
      const html = readDashboardHtml();
      sendResult(id, {
        contents: [
          {
            uri: DASHBOARD_URI,
            mimeType: DASHBOARD_MIME,
            text: html,
            _meta: {
              ui: {
                prefersBorder: false
              }
            }
          }
        ]
      });
      return;
    }

    if (!isNotification) {
      sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (!isNotification) {
      sendError(id, -32603, err?.message || 'Internal server error');
    }
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  handleMessage(parsed).catch(() => {});
});

const warmupTimer = setTimeout(() => {
  warmupGlobalTokenIndex().catch(() => {});
}, 800);
warmupTimer.unref();
