import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables
} from '@modelcontextprotocol/ext-apps';

// ============================================================================
// App State & MCP Bridge (max 3 concurrent tool calls to stay under host cap 4)
// ============================================================================
const app = new App({ name: 'agy-context-dashboard', version: '26.3.2' }, {});

const state = {
  activeNav: 'overview',
  sidebarCollapsed: false,
  connected: false,
  version: '--',
  tasks: null,
  heatmap: null,
  analytics: null,
  analyticsRange: 'today',
  analyticsStart: '',
  analyticsEnd: '',
  accountsData: null,
  selectedSessionId: '',
  unlockStatus: null,
  updateStatus: null,
  editingAliasId: null,
  confirmDeleteId: null,
  searchQuery: ''
};

let sessionReqSeq = 0;
let analyticsReqSeq = 0;
let tasksPolling = false;
let accountsPolling = false;

let inflight = 0;
const callQueue = [];

const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)'
];

function runQueued(fn) {
  return new Promise((resolve, reject) => {
    const task = async () => {
      inflight++;
      try {
        resolve(await fn());
      } catch (err) {
        reject(err);
      } finally {
        inflight--;
        if (callQueue.length > 0) {
          const next = callQueue.shift();
          next();
        }
      }
    };
    if (inflight < 3) {
      task();
    } else {
      callQueue.push(task);
    }
  });
}

async function callTool(name, args = {}) {
  return runQueued(async () => {
    const res = await app.callServerTool({ name, arguments: args });
    if (res?.isError) {
      const msg = res?.structuredContent?.error || res?.content?.[0]?.text || '操作失败';
      throw new Error(msg);
    }
    return res?.structuredContent ?? {};
  });
}

// ============================================================================
// Utilities & UI Primitives
// ============================================================================
const $ = (id) => document.getElementById(id);

function esc(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmtCompact(n) {
  const num = Number(n) || 0;
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
  return String(Math.round(num));
}

function fmtRelative(ms) {
  if (!ms) return '--';
  const diff = Math.max(0, Date.now() - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const days = Math.floor(hr / 24);
  return `${days} 天前`;
}

function fmtDuration(ms) {
  if (!ms || ms <= 0) return '--';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remS = sec % 60;
  if (min < 60) return `${min}m ${remS}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function fmtResetShort(iso) {
  if (!iso) return '';
  const diff = Date.parse(iso) - Date.now();
  if (!Number.isFinite(diff) || diff <= 0) return '已重置';
  const min = Math.ceil(diff / 60000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h${min % 60 ? `${min % 60}m` : ''}`;
  const d = Math.floor(hr / 24);
  return `${d}d${hr % 24 ? `${hr % 24}h` : ''}`;
}

function quotaColor(pct) {
  if (typeof pct !== 'number') return 'var(--muted-foreground)';
  if (pct <= 15) return 'var(--status-crit)';
  if (pct <= 40) return 'var(--status-warn)';
  return 'var(--status-ok)';
}

function updateSyncClock() {
  $('topbar-sync-time').textContent = `同步于 ${new Date().toTimeString().slice(0, 8)}`;
}

function renderEmptyState(title, desc = '', iconPath = '<circle cx="12" cy="12" r="9"/><path d="M9 12h6"/>') {
  return `
    <div class="empty-state">
      <div class="empty-icon-wrap" aria-hidden="true">
        <svg class="icon" viewBox="0 0 24 24">${iconPath}</svg>
      </div>
      <div class="empty-title">${esc(title)}</div>
      ${desc ? `<div>${esc(desc)}</div>` : ''}
    </div>
  `;
}

let toastTimer = null;
function showToast(msg, type = 'info') {
  const el = $('toast');
  const iconMap = {
    ok: '<svg class="icon icon-sm" style="color:var(--status-ok);" viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>',
    warn: '<svg class="icon icon-sm" style="color:var(--status-warn);" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>',
    error: '<svg class="icon icon-sm" style="color:var(--destructive);" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
    info: '<svg class="icon icon-sm text-muted" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>'
  };
  el.innerHTML = `${iconMap[type] || iconMap.info}<span>${esc(msg)}</span>`;
  el.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 3000);
}

function showFloatingTip(anchorEl, text) {
  if (!text) return;
  const tip = $('floating-tip');
  tip.textContent = text;
  tip.classList.add('visible');
  const rect = anchorEl.getBoundingClientRect();
  const tw = tip.offsetWidth || 180;
  const th = tip.offsetHeight || 48;
  let left = rect.left + rect.width / 2 - tw / 2;
  left = Math.max(8, Math.min(window.innerWidth - tw - 8, left));
  let top = rect.top - th - 8;
  if (top < 8) top = Math.min(window.innerHeight - th - 8, rect.bottom + 8);
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function hideFloatingTip() {
  $('floating-tip').classList.remove('visible');
}

async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }
}

// ============================================================================
// Top-Layer Dialog Exit Animation Fallback (modern-web-guidance compliant)
// ============================================================================
let supportsDisplayTransition;
function canTransitionDisplay() {
  if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
  if (!window.CSS?.supports?.('transition-behavior', 'allow-discrete') || !document.body) {
    return false;
  }
  const probe = document.createElement('div');
  probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = 'none';
  supportsDisplayTransition = getComputedStyle(probe).display === 'block';
  probe.remove();
  return supportsDisplayTransition;
}

function supportsTopLayerExit() {
  return Boolean(window.CSS?.supports?.('overlay', 'auto') && canTransitionDisplay());
}

async function closeTopLayerDialog(dialog) {
  if (!dialog.open) return;
  if (!supportsTopLayerExit()) {
    dialog.setAttribute('data-closing', '');
    const animations = dialog.getAnimations({ subtree: true });
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise((r) => setTimeout(r, 400))
      ]);
    }
    if (!dialog.hasAttribute('data-closing')) return;
    dialog.removeAttribute('data-closing');
  }
  dialog.close();
}

// ============================================================================
// Theme Synchronization (Host Context -> data-theme + CSS variables)
// ============================================================================
function applyHostContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
    document.documentElement.setAttribute('data-theme', ctx.theme);
    document.documentElement.style.colorScheme = ctx.theme;
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
}

// ============================================================================
// Navigation & Breadcrumb
// ============================================================================
const NAV_META = {
  overview: { group: '监控概览', title: '汇总大看板', sub: '365 天活跃热力图、连续天数与全局运行概览' },
  tasks: { group: '监控概览', title: '多任务监控', sub: '实时追踪正在运行的任务与已完成未读会话进度' },
  analytics: { group: '诊断与用量', title: '用量分析', sub: '按时间维度分析 Token 消耗、缓存命中率、性能与费用' },
  sessions: { group: '诊断与用量', title: '会话诊断', sub: '检索本地历史会话，剖析上下文演进曲线与构成明细' },
  accounts: { group: '管理与系统', title: '账号与额度', sub: '实时模型配额监控与多账号快照矩阵切换' },
  system: { group: '管理与系统', title: '系统与解锁', sub: '256K 上下文门禁解锁、目标档位预算与插件热升级' }
};

function switchNav(navId, { skipLoad = false } = {}) {
  if (!NAV_META[navId]) navId = 'overview';
  state.activeNav = navId;
  for (const btn of document.querySelectorAll('.rail-btn[data-nav]')) {
    const isCur = btn.dataset.nav === navId;
    if (isCur) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  for (const sec of document.querySelectorAll('.view-panel')) {
    sec.hidden = sec.id !== `view-${navId}`;
  }
  $('topbar-group').textContent = NAV_META[navId].group;
  $('topbar-title').textContent = NAV_META[navId].title;
  $('topbar-sub').textContent = NAV_META[navId].sub;

  if (skipLoad) return;

  if (navId === 'overview') {
    if (!state.heatmap) loadHeatmap(false);
    if (!state.tasks) loadTasks();
  } else if (navId === 'tasks') {
    loadTasks();
  } else if (navId === 'analytics') {
    if (!state.analytics) loadAnalytics(false);
  } else if (navId === 'accounts') {
    if (!state.accountsData) loadAccounts(false);
  } else if (navId === 'sessions') {
    ensureSessionsLoaded();
  } else if (navId === 'system') {
    if (!state.unlockStatus) loadUnlockStatus(false);
    if (!state.updateStatus) loadUpdateStatus();
  }
}

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  $('app-shell').classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
  $('btn-sidebar-toggle').setAttribute('aria-expanded', String(!state.sidebarCollapsed));
}

// ============================================================================
// View 1: Overview & 365-Day Activity Heatmap
// ============================================================================
async function loadHeatmap(force = false) {
  try {
    const data = await callTool('app_get_heatmap', { days: 365, force });
    state.heatmap = data;
    renderHeatmapView(data);
    updateSyncClock();
  } catch (err) {
    showToast(`加载热力图失败: ${err.message}`, 'error');
  }
}

function renderHeatmapView(data) {
  if (!data?.summary) return;
  const s = data.summary;

  $('ov-active-days').textContent = `${s.totalActiveDays} 天`;
  $('ov-streak').textContent = `连续 ${s.currentStreak} 天`;
  $('ov-active-rate').textContent = `活跃率 ${s.activeRatePercent}% · 最长连续 ${s.longestStreak} 天`;

  $('ov-total-tokens').textContent = s.totalTokensCompact;
  $('ov-cache-badge').textContent = `缓存 ${s.cacheHitRatio}%`;
  $('ov-cache-rate').textContent = `活跃日均消耗 ${s.avgDailyActiveCompact}`;

  $('ov-total-cost').textContent = s.totalCostFormatted;
  $('ov-total-req').textContent = `${(s.totalRequests || 0).toLocaleString()} 次生成请求`;

  $('ov-top-model').textContent = s.topModel ? s.topModel.model : '--';
  $('ov-peak-day').textContent = s.peakDay ? `峰值 ${s.peakDay.compact}` : '峰值 --';
  const peakInfo = s.peakDay ? `峰值日 ${s.peakDay.date}` : '暂无峰值';
  $('ov-top-model-sub').textContent = s.topModel
    ? `占比 ${s.topModel.sharePercent}% · ${peakInfo}`
    : peakInfo;

  $('ov-db-meta').textContent = `已聚合 ${s.databasesScanned} 个会话库`;
  $('heatmap-range-sub').textContent = `${data.startDate} ~ ${data.endDate} · 点击任意有记录日期查看当天分时明细`;

  // Render Heatmap Grid & Month labels
  const grid = $('heatmap-grid');
  const monthsBar = $('heatmap-months');
  const cells = data.cells || [];
  const totalWeeks = Math.ceil(cells.length / 7);
  const monthLabels = new Array(totalWeeks).fill('');
  let lastMonth = '';
  for (let w = 0; w < totalWeeks; w++) {
    const firstCell = cells[w * 7];
    if (firstCell?.date) {
      const m = firstCell.date.slice(0, 7);
      if (m !== lastMonth) {
        monthLabels[w] = `${Number(firstCell.date.slice(5, 7))}月`;
        lastMonth = m;
      }
    }
  }
  monthsBar.innerHTML = monthLabels.map(lbl => `<span>${esc(lbl)}</span>`).join('');

  grid.innerHTML = cells.map(c => {
    const tip = c.totalTokens > 0
      ? `${c.date}\n总计: ${fmtCompact(c.totalTokens)} tokens\n输入: ${fmtCompact(c.inputTokens)} · 输出: ${fmtCompact(c.outputTokens)}\n请求: ${c.requests} 次 · 费用: $${c.cost.toFixed(2)}`
      : `${c.date}\n无记录`;
    const cls = c.inSpan ? 'heat-cell' : 'heat-cell out-span';
    return `<button type="button" class="${cls}" data-level="${c.level}" data-date="${esc(c.date)}" data-has-data="${c.totalTokens > 0 ? '1' : '0'}" data-tip="${esc(tip)}" aria-label="${esc(c.date)} ${fmtCompact(c.totalTokens)} tokens"></button>`;
  }).join('');

  // Render Monthly Trend Bars
  const monthly = data.monthlyTrend || [];
  const mBars = $('ov-monthly-bars');
  const mAxis = $('ov-monthly-axis');
  if (monthly.length === 0) {
    mBars.innerHTML = `<div class="flex-1">${renderEmptyState('暂无月度消耗数据', '在会话中使用模型后将自动统计')}</div>`;
    mAxis.innerHTML = '';
  } else {
    const maxTok = Math.max(1, ...monthly.map(m => m.totalTokens));
    mBars.innerHTML = monthly.map(m => {
      const pct = Math.max(4, Math.round((m.totalTokens / maxTok) * 100));
      const tip = `${m.month}\n总计: ${m.compact} tokens\n请求: ${m.requests} 次 · 费用: $${m.cost.toFixed(2)}`;
      return `<div class="hist-bar" style="height:${pct}%;" data-tip="${esc(tip)}"></div>`;
    }).join('');
    mAxis.innerHTML = monthly.map(m => `<span>${esc(m.month.slice(2))}</span>`).join('');
  }

  // Render Top Models
  const topEl = $('ov-top-models-list');
  const topModels = data.topModels || [];
  if (topModels.length === 0) {
    topEl.innerHTML = renderEmptyState('暂无模型记录', '过去 365 天未检测到模型调用');
  } else {
    topEl.innerHTML = topModels.map((m, idx) => {
      const color = CHART_COLORS[idx % CHART_COLORS.length];
      return `
        <div class="stack gap-1">
          <div class="row-between gap-2 text-xs">
            <span class="row gap-2 min-w-0">
              <span class="color-swatch" style="background:${color};"></span>
              <span class="font-medium truncate">${esc(m.model)}</span>
            </span>
            <span class="mono text-muted shrink-0">${esc(m.compact)} · ${m.sharePercent}%</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" style="width:${Math.max(2, m.sharePercent)}%;background:${color};"></div>
          </div>
        </div>
      `;
    }).join('');
  }
}

// ============================================================================
// View 2: Multi-Task Monitor Kanban
// ============================================================================
async function loadTasks(force = false) {
  if (tasksPolling && !force) return;
  tasksPolling = true;
  try {
    const data = await callTool('app_get_tasks', { sessionLimit: 80 });
    state.tasks = data;
    renderTasksViews(data);
    updateSyncClock();
  } catch (err) {
    showToast(`刷新任务监控失败: ${err.message}`, 'error');
  } finally {
    tasksPolling = false;
  }
}

function renderStepRow(s) {
  const iconMap = {
    done: '<svg class="icon icon-xs" style="color:var(--status-ok);" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
    in_progress: '<svg class="icon icon-xs" style="color:var(--foreground);" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>',
    pending: '<svg class="icon icon-xs" style="opacity:0.45;" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/></svg>',
    skipped: '<svg class="icon icon-xs" style="opacity:0.45;" viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
    failed: '<svg class="icon icon-xs" style="color:var(--destructive);" viewBox="0 0 24 24"><path d="m18 6-12 12"/><path d="m6 6 12 12"/></svg>'
  };
  const icon = iconMap[s.status] || iconMap.pending;
  return `<li class="step-row ${esc(s.status)}"><span class="step-mark" aria-hidden="true">${icon}</span><span class="truncate">${esc(s.title)}</span></li>`;
}

function renderTaskCard(task, isRunning) {
  const p = task.progress || {};
  const hasSteps = Array.isArray(p.steps) && p.steps.length > 0;
  const pct = hasSteps ? (p.progressPercent ?? 0) : null;
  const elapsed = isRunning && p.turnStartedAt ? fmtDuration(Date.now() - p.turnStartedAt) : fmtRelative(task.updateTimeMs);

  const metaParts = [];
  if (task.workspaceName) metaParts.push(esc(task.workspaceName));
  if (p.currentModel) metaParts.push(esc(p.currentModel));
  if (task.subagentTotal > 0) metaParts.push(`子代理 ${task.subagentRunning}/${task.subagentTotal}`);
  metaParts.push(`${task.stepCount || 0} steps`);
  if (p.latestContextTokens > 0) metaParts.push(`${fmtCompact(p.latestContextTokens)} ctx`);

  const stepsHtml = hasSteps
    ? `
      <div class="stack gap-2">
        <div class="row-between text-xs text-muted">
          <span>执行步骤</span>
          <span class="mono font-semibold" style="color:var(--foreground);">${p.stepsDone}/${p.stepsTotal} · ${pct}%</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width:${pct}%;background:${isRunning ? 'var(--status-ok)' : 'var(--status-warn)'};"></div>
        </div>
        <ul class="steps-list">${p.steps.map(renderStepRow).join('')}</ul>
      </div>
    `
    : (p.latestActivity
      ? `<div class="text-xs text-muted">${esc(p.latestActivity)}</div>`
      : (task.summary ? `<div class="text-xs text-muted">${esc(task.summary)}</div>` : ''));

  const focusHtml = p.focus
    ? `<div class="task-focus-pill"><span class="dot ${isRunning ? 'pulse' : 'warn'}"></span><span class="truncate">${esc(p.focus)}</span></div>`
    : '';

  return `
    <article class="task-card" data-conv-id="${esc(task.id)}">
      <div class="task-card-head">
        <h3 class="task-title" data-open-session="${esc(task.id)}" title="点击查看完整上下文诊断">${esc(task.title)}</h3>
        <span class="badge shrink-0 ${isRunning ? 'badge-ok' : 'badge-warn'}">${isRunning ? '运行中' : '未读'}</span>
      </div>

      <div class="task-meta-line mono">
        <span>${metaParts.join(' <span class="meta-sep">·</span> ')}</span>
        <span class="ml-auto shrink-0">${esc(elapsed)}</span>
      </div>

      ${focusHtml}
      ${stepsHtml}

      <div class="task-actions">
        <div class="row-wrap gap-2">
          <button type="button" class="btn btn-sm btn-primary" data-jump-conv="${esc(task.id)}" data-jump-title="${esc(task.title)}">定位会话</button>
          <button type="button" class="btn btn-sm" data-open-session="${esc(task.id)}">上下文诊断</button>
        </div>
        ${!isRunning ? `<button type="button" class="btn btn-ghost btn-sm" data-mark-read="${esc(task.id)}" data-update-ms="${task.updateTimeMs}">标为已读</button>` : ''}
      </div>
    </article>
  `;
}

function renderTasksViews(data) {
  const running = data.running || [];
  const unread = data.unread || [];
  const totalMonitored = running.length + unread.length;

  // Update Left Nav Badge
  const badge = $('nav-tasks-badge');
  if (totalMonitored > 0) {
    badge.hidden = false;
    badge.textContent = String(totalMonitored);
    badge.className = running.length > 0 ? 'rail-badge ok' : 'rail-badge warn';
  } else {
    badge.hidden = true;
  }

  // Update Overview Collapsible Live Banner
  const ovDot = $('ov-live-dot');
  ovDot.className = running.length > 0 ? 'dot pulse' : (unread.length > 0 ? 'dot warn' : 'dot');
  const ovCounts = $('ov-live-counts');
  ovCounts.textContent = totalMonitored > 0
    ? `运行中 ${running.length} · 待查收 ${unread.length}`
    : '暂无活跃后台任务';
  ovCounts.className = running.length > 0 ? 'badge badge-ok' : (unread.length > 0 ? 'badge badge-warn' : 'badge');

  const ovCards = $('ov-live-cards');
  const combined = [...running, ...unread].slice(0, 4);
  if (combined.length === 0) {
    ovCards.hidden = true;
    ovCards.innerHTML = '';
  } else {
    ovCards.hidden = false;
    ovCards.innerHTML = combined.map(t => {
      const p = t.progress || {};
      const isRun = t.category === 'running';
      const pct = p.stepsTotal > 0 ? `${p.stepsDone}/${p.stepsTotal}` : `${t.stepCount || 0} steps`;
      return `
        <button type="button" class="live-mini-card" data-open-session="${esc(t.id)}">
          <div class="row-between gap-2">
            <span class="font-semibold text-sm truncate">${esc(t.title)}</span>
            <span class="badge shrink-0 ${isRun ? 'badge-ok' : 'badge-warn'}">${isRun ? '运行中' : '未读'}</span>
          </div>
          <div class="text-xs text-muted truncate">${esc(p.focus || p.latestActivity || t.summary || '--')}</div>
          <div class="row-between mono text-xs text-muted">
            <span class="truncate">${esc(t.workspaceName || '全局')} · ${esc(pct)}</span>
            <span class="shrink-0">${esc(fmtRelative(t.updateTimeMs))}</span>
          </div>
        </button>
      `;
    }).join('');
  }

  // Update Multi-Task Kanban View
  $('tm-count-running').textContent = `运行中 ${running.length}`;
  $('tm-count-unread').textContent = `已完成未读 ${unread.length}`;
  $('tm-col-running-num').textContent = String(running.length);
  $('tm-col-unread-num').textContent = String(unread.length);
  $('tm-mark-all-btn').disabled = unread.length === 0;

  $('tm-running-list').innerHTML = running.length > 0
    ? running.map(t => renderTaskCard(t, true)).join('')
    : renderEmptyState('暂无运行中任务', '当有后台会话执行时将实时出现在此列', '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>');

  $('tm-unread-list').innerHTML = unread.length > 0
    ? unread.map(t => renderTaskCard(t, false)).join('')
    : renderEmptyState('暂无待查收会话', '所有已完成的会话均已审阅', '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>');

  renderSessionsList();
}

async function tryJumpToConversation(convId, title) {
  const copied = await copyText(title || convId);
  showToast(copied
    ? `已复制标题「${(title || convId).slice(0, 24)}」，按 Ctrl+K 粘贴直达`
    : `会话 ID: ${convId}`, copied ? 'ok' : 'info');
}

// ============================================================================
// View 3: Usage Analytics (Histogram + Interactive Donut + Sortable Table)
// ============================================================================
async function loadAnalytics(force = false) {
  const seq = ++analyticsReqSeq;
  try {
    const data = await callTool('app_get_global_tokens', {
      range: state.analyticsRange,
      start: state.analyticsStart,
      end: state.analyticsEnd,
      force
    });
    if (seq !== analyticsReqSeq) return;
    state.analytics = data;
    renderAnalytics(data);
    updateSyncClock();
  } catch (err) {
    if (seq !== analyticsReqSeq) return;
    showToast(`加载用量分析失败: ${err.message}`, 'error');
  }
}

function renderAnalytics(d) {
  $('an-range-badge').textContent = `${d.rangeLabel || d.range} · ${d.startDate} ~ ${d.endDate}`;
  $('an-start-date').value = d.startDate || '';
  $('an-end-date').value = d.endDate || '';

  $('an-total').textContent = d.totalTokens?.compact ?? '--';
  $('an-total-full').textContent = d.totalTokens?.full ?? '--';
  $('an-input').textContent = d.inputTokens?.compact ?? '--';
  $('an-input-full').textContent = d.inputTokens?.full ?? '--';
  $('an-output').textContent = d.outputTokens?.compact ?? '--';
  $('an-output-full').textContent = d.outputTokens?.full ?? '--';
  $('an-cost').textContent = d.costEstimate?.formatted ?? '$--';
  $('an-reqs').textContent = d.costEstimate?.requests ?? '--';

  $('an-cache').textContent = d.cacheHitRatio?.percent ?? '--%';
  $('an-ttft').textContent = d.ttft?.value !== '--' ? `${d.ttft.value} s` : '--';
  $('an-ttft-sub').textContent = d.ttft?.sub ?? '--';
  $('an-speed').textContent = d.speed?.value !== '--' ? `${d.speed.value} tok/s` : '--';
  $('an-speed-sub').textContent = d.speed?.sub ?? '--';
  $('an-avg-in').textContent = d.avgInput?.formatted ?? '--';
  $('an-avg-sub').textContent = d.avgInput?.sub ?? '--';

  // Histogram
  const chart = d.chart || {};
  const buckets = chart.buckets || [];
  const granMap = { hourly: '按小时', daily: '按天', weekly: '按周', monthly: '按月' };
  $('an-hist-gran').textContent = granMap[chart.granularity] || chart.type || '--';

  const barsEl = $('an-hist-bars');
  const axisEl = $('an-hist-axis');
  const maxVal = Math.max(1, ...buckets.map(b => b.rawTotal || 0));
  const activeIdx = chart.defaultActiveIndex ?? Math.max(0, buckets.length - 1);

  const setBucketHeader = (b) => {
    if (!b) return;
    $('an-b-time').textContent = b.time || '--';
    $('an-b-total').textContent = b.compactTotal || b.fullTotal || '--';
    $('an-b-in').textContent = b.inputCompact || '--';
    $('an-b-out').textContent = b.outputCompact || '--';
    $('an-b-cache').textContent = b.cacheCompact || '--';
    $('an-b-cost').textContent = b.cost || '$0.00';
  };

  if (buckets.length === 0) {
    barsEl.innerHTML = `<div class="flex-1">${renderEmptyState('当前周期暂无生成记录', '尝试切换其他统计时间范围')}</div>`;
    axisEl.innerHTML = '';
    setBucketHeader({ time: '--', compactTotal: '--', inputCompact: '--', outputCompact: '--', cacheCompact: '--', cost: '$--' });
  } else {
    barsEl.innerHTML = buckets.map((b, i) => {
      const h = b.rawTotal > 0 ? Math.max(4, Math.round((b.rawTotal / maxVal) * 100)) : 2;
      return `<div class="hist-bar ${i === activeIdx ? 'active' : ''}" data-bidx="${i}" style="height:${h}%;"></div>`;
    }).join('');
    setBucketHeader(buckets[activeIdx]);

    const labels = chart.xLabels || [];
    const step = Math.max(1, Math.ceil(labels.length / 8));
    axisEl.innerHTML = labels.filter((_, i) => i % step === 0 || i === labels.length - 1).map(l => `<span>${esc(l)}</span>`).join('');
  }

  // Model Distribution (Tokens & Interactive Donut)
  const models = d.models || [];
  $('an-model-count').textContent = `${models.length} 个模型`;
  const tokList = $('panel-dist-tokens');
  if (models.length === 0) {
    tokList.innerHTML = renderEmptyState('暂无模型统计', '当前时间范围内无调用记录');
  } else {
    tokList.innerHTML = models.slice(0, 8).map((m, idx) => {
      const mName = m.model || '--';
      const pctNum = parseFloat(String(m.percent || '0')) || 0;
      const color = CHART_COLORS[idx % CHART_COLORS.length];
      return `
        <div class="stack gap-1">
          <div class="row-between gap-2 text-xs">
            <span class="row gap-2 min-w-0">
              <span class="color-swatch" style="background:${color};"></span>
              <span class="truncate font-medium">${esc(mName)}</span>
            </span>
            <span class="mono text-muted shrink-0">${esc(m.compactTotal || m.total || '0')} · ${esc(m.percent || '0%')}</span>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${Math.max(2, pctNum)}%;background:${color};"></div></div>
        </div>
      `;
    }).join('');
  }

  // Cost Donut
  const pricedModels = models.filter(m => (m.rawCost || 0) > 0);
  const totalCost = pricedModels.reduce((acc, m) => acc + m.rawCost, 0);
  $('an-donut-cost').textContent = d.costEstimate?.formatted ?? '$0.00';
  const donutSvg = $('an-donut-svg');
  const legendEl = $('an-donut-legend');
  if (totalCost <= 0) {
    donutSvg.innerHTML = '<circle cx="60" cy="60" r="44" fill="none" stroke="var(--chart-track)" stroke-width="14"/>';
    legendEl.innerHTML = renderEmptyState('暂无计费明细');
  } else {
    const r = 44;
    const circ = 2 * Math.PI * r;
    let offset = 0;
    const topPriced = pricedModels.slice(0, 6);
    donutSvg.innerHTML = topPriced.map((m, idx) => {
      const frac = m.rawCost / totalCost;
      const len = Math.max(2, frac * circ - 2.5);
      const color = CHART_COLORS[idx % CHART_COLORS.length];
      const seg = `<circle class="donut-seg" data-donut-idx="${idx}" cx="60" cy="60" r="${r}" fill="none" stroke="${color}" stroke-width="14" stroke-dasharray="${len.toFixed(2)} ${circ.toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"/>`;
      offset += frac * circ;
      return seg;
    }).join('');
    legendEl.innerHTML = topPriced.map((m, idx) => {
      const color = CHART_COLORS[idx % CHART_COLORS.length];
      return `
        <div class="donut-legend-row" data-donut-idx="${idx}">
          <span class="row gap-2 min-w-0">
            <span class="color-swatch" style="background:${color};"></span>
            <span class="truncate">${esc(m.model || '--')}</span>
          </span>
          <span class="mono text-muted shrink-0">${esc(m.cost)}</span>
        </div>
      `;
    }).join('');
  }

  // Model Details Sortable Table
  const parseCommaNum = (v) => Number(String(v || '0').replace(/,/g, '')) || 0;
  const maxModelTok = Math.max(1, ...models.map(m => m.rawTotal || 0));
  const tbody = $('an-model-tbody');
  if (models.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted-foreground);padding:24px;">当前时间范围内暂无模型明细</td></tr>`;
    return;
  }
  tbody.innerHTML = models.map(m => {
    const mName = m.model || '--';
    const rawIn = parseCommaNum(m.input);
    const rawCache = parseCommaNum(m.cache);
    const rawOut = parseCommaNum(m.output);
    const shareW = Math.max(2, Math.round(((m.rawTotal || 0) / maxModelTok) * 100));
    return `
      <tr>
        <td data-value="${esc(mName)}">
          <div class="table-model-cell">
            <span class="truncate font-medium" style="font-family:var(--font-sans);">${esc(mName)}</span>
            <span class="table-inline-bar" aria-hidden="true"><span style="width:${shareW}%;"></span></span>
          </div>
        </td>
        <td data-value="${m.rawTotal || 0}" class="font-semibold">${esc(m.compactTotal || m.total || '0')}</td>
        <td data-value="${m.rawCost || 0}">${esc(m.cost || '$0.00')}</td>
        <td data-value="${rawIn}">${esc(fmtCompact(rawIn))}</td>
        <td data-value="${rawCache}">${esc(fmtCompact(rawCache))}</td>
        <td data-value="${rawOut}">${esc(fmtCompact(rawOut))}</td>
        <td data-value="${m.requests || 0}">${m.requests || 0}</td>
      </tr>
    `;
  }).join('');
}

const tableCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function sortModelTable(button) {
  const table = $('an-model-table');
  const tbody = $('an-model-tbody');
  const th = button.closest('th');
  if (!th) return;
  const colIdx = th.cellIndex;
  const type = th.dataset.type || 'string';
  const direction = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
  const factor = direction === 'ascending' ? 1 : -1;

  for (const header of table.tHead.rows[0].cells) header.removeAttribute('aria-sort');
  th.setAttribute('aria-sort', direction);

  const rows = [...tbody.rows].filter(r => r.cells.length > 1);
  rows.sort((a, b) => {
    const va = a.cells[colIdx]?.dataset.value ?? a.cells[colIdx]?.textContent.trim() ?? '';
    const vb = b.cells[colIdx]?.dataset.value ?? b.cells[colIdx]?.textContent.trim() ?? '';
    return factor * (type === 'number' ? Number(va) - Number(vb) : tableCollator.compare(va, vb));
  });

  for (const row of rows) {
    if (typeof tbody.moveBefore === 'function') tbody.moveBefore(row, null);
    else tbody.appendChild(row);
  }

  $('table-sort-status').textContent = `按 ${button.textContent.trim()} ${direction === 'ascending' ? '升序' : '降序'} 排列，共 ${rows.length} 行`;
}

function highlightDonutSegment(idx) {
  const svg = $('an-donut-svg');
  for (const seg of svg.querySelectorAll('.donut-seg')) {
    if (idx === null) {
      seg.style.opacity = '1';
      seg.setAttribute('stroke-width', '14');
    } else {
      const match = seg.dataset.donutIdx === String(idx);
      seg.style.opacity = match ? '1' : '0.28';
      seg.setAttribute('stroke-width', match ? '16' : '14');
    }
  }
}

// ============================================================================
// View 4: Accounts & Quotas Matrix
// ============================================================================
async function loadAccounts(force = false) {
  if (accountsPolling && !force) return;
  accountsPolling = true;
  try {
    const data = await callTool('app_get_accounts_quota', { force });
    state.accountsData = data;
    renderAccounts(data);
    updateSyncClock();
  } catch (err) {
    showToast(`获取账号额度失败: ${err.message}`, 'error');
  } finally {
    accountsPolling = false;
  }
}

function renderQuotaWindowBar(label, win, fallbackHint = '') {
  if (!win || typeof win.remainingPercent !== 'number') {
    if (!fallbackHint) return '';
    return `<div class="quota-row mono"><span class="text-muted">${esc(label)}</span><span class="text-muted text-xs">${esc(fallbackHint)}</span><span></span></div>`;
  }
  const pct = win.isEstimatedReset ? (win.cappedByWeekly ? 0 : 100) : (typeof win.effectivePercent === 'number' ? win.effectivePercent : win.remainingPercent);
  const clamped = Math.max(0, Math.min(100, pct));
  const reset = pct < 100 && win.resetTime ? fmtResetShort(win.resetTime) : (win.isEstimatedReset ? '↻' : '');
  return `
    <div class="quota-row mono">
      <span class="text-muted truncate">${esc(label)} ${reset ? `<span style="opacity:0.75;">${esc(reset)}</span>` : ''}</span>
      <div class="progress-track"><div class="progress-fill" style="width:${clamped}%;background:${quotaColor(pct)};"></div></div>
      <span style="text-align:right;font-weight:600;">${pct}%</span>
    </div>
  `;
}

function renderAccounts(data) {
  const q = data.quota;
  const acctList = data.accounts?.accounts || [];
  const wkSummary = data.accounts?.weeklyTokenSummary;

  // Update Sidebar Footer Account Card
  const chipDot = $('rail-quota-dot');
  const avatarChar = $('rail-avatar-char');
  const chipName = $('rail-quota-name');
  const chipTxt = $('rail-quota-text');
  if (q?.available && q?.account) {
    const minPct = q.summary?.minRemainingPercent;
    const email = q.account.email || q.account.name || '--';
    const shortName = email.split('@')[0];
    avatarChar.textContent = shortName.slice(0, 1).toUpperCase();
    chipDot.className = `rail-avatar-dot ${typeof minPct === 'number' ? (minPct <= 15 ? 'crit' : minPct <= 40 ? 'warn' : 'ok') : ''}`;
    chipName.textContent = shortName;
    chipTxt.textContent = `最低余量 ${typeof minPct === 'number' ? `${minPct}%` : '--'}`;
  } else {
    avatarChar.textContent = '?';
    chipDot.className = 'rail-avatar-dot';
    chipName.textContent = '未连接账号';
    chipTxt.textContent = '点击检查配额';
  }

  // Active Account Card
  const notice = $('ac-notice');
  if (!q?.available || !q?.account) {
    $('ac-avatar').textContent = '!';
    $('ac-email').textContent = '未检测到活跃账户';
    $('ac-plan').hidden = true;
    $('ac-credits').textContent = q?.error || '请确认 Antigravity 已登录并运行中';
    $('ac-quota-groups').innerHTML = renderEmptyState('暂无实时配额数据', '登录 Antigravity 后自动同步各模型配额组');
    notice.hidden = true;
  } else {
    const email = q.account.email || q.account.name || '--';
    $('ac-avatar').textContent = email.slice(0, 1).toUpperCase();
    $('ac-email').textContent = email;
    const plan = q.account.planName || q.account.planTier;
    $('ac-plan').hidden = !plan;
    if (plan) $('ac-plan').textContent = plan;
    const cr = q.credits;
    $('ac-credits').textContent = cr && typeof cr.available === 'number'
      ? `AI Credits 可用: ${cr.available}`
      : `最近同步: ${q.fetchedAt ? new Date(q.fetchedAt).toTimeString().slice(0, 8) : '--'}`;

    const groups = q.quotaGroups || [];
    const wkHint = wkSummary ? `7d ${wkSummary.compactTotal}` : '--';
    $('ac-quota-groups').innerHTML = groups.length > 0
      ? groups.map(g => {
          const title = g.key === 'claude_gpt' ? 'Claude & GPT' : g.title;
          return `
            <div class="quota-group-box">
              <div class="font-semibold text-sm">${esc(title)}</div>
              ${g.fiveHour ? renderQuotaWindowBar('5H', g.fiveHour) : ''}
              ${renderQuotaWindowBar('WEEK', g.weekly, wkHint)}
            </div>
          `;
        }).join('')
      : renderEmptyState('暂无模型分组配额');
    notice.hidden = true;
  }

  // Saved Accounts Grid (Independent Cards)
  $('ac-saved-count').textContent = String(acctList.length);
  const grid = $('ac-accounts-grid');
  if (acctList.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;">${renderEmptyState('暂无已保存账号快照', '点击上方「捕获当前快照」保存当前登录凭证，支持多账号快速对比与切换', '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>')}</div>`;
    return;
  }
  grid.innerHTML = acctList.map(acct => {
    const isEditing = state.editingAliasId === acct.id;
    const isConfirmDel = state.confirmDeleteId === acct.id;
    const eff = acct.effectiveQuota || acct.lastQuota;
    const groups = eff?.quotaGroups || [];
    const quotaRows = groups.map(g => {
      const tag = g.key === 'claude_gpt' ? 'C/G' : (g.key === 'gemini' ? 'Gem' : g.title.slice(0, 4));
      return renderQuotaWindowBar(`${tag} 5H`, g.fiveHour) + renderQuotaWindowBar(`${tag} WK`, g.weekly);
    }).join('');

    return `
      <div class="account-card ${acct.isCurrent ? 'is-current' : ''}">
        <div class="row-between gap-2">
          <div class="min-w-0 flex-1">
            ${isEditing
              ? `<div class="row gap-1">
                   <input type="text" class="input" id="alias-input-${esc(acct.id)}" value="${esc(acct.alias || '')}" placeholder="输入备注名" style="height:28px;" />
                   <button type="button" class="btn btn-sm btn-primary" data-acct-act="save-alias" data-acct-id="${esc(acct.id)}">保存</button>
                   <button type="button" class="btn btn-sm" data-acct-act="cancel-alias" data-acct-id="${esc(acct.id)}">取消</button>
                 </div>`
              : `<div class="row gap-2 min-w-0">
                   <span class="font-semibold text-sm truncate">${esc(acct.alias || acct.email.split('@')[0])}</span>
                   ${acct.isCurrent ? '<span class="badge badge-ok">当前</span>' : ''}
                   ${acct.planName ? `<span class="badge badge-secondary">${esc(acct.planName)}</span>` : ''}
                 </div>
                 <div class="mono text-xs text-muted truncate">${esc(acct.email)}</div>`
            }
          </div>
        </div>

        <div class="stack gap-2">
          ${quotaRows || '<div class="mono text-xs text-muted">暂无切出配额快照</div>'}
        </div>

        <div class="row-between gap-2" style="padding-top:10px;border-top:1px solid var(--border);margin-top:auto;">
          <span class="mono text-xs text-muted">${acct.lastUsedAt ? `活跃 ${fmtRelative(Date.parse(acct.lastUsedAt))}` : ''}</span>
          <div class="row gap-1">
            <button type="button" class="btn btn-ghost btn-sm" data-acct-act="alias" data-acct-id="${esc(acct.id)}">备注</button>
            ${!acct.isCurrent ? `<button type="button" class="btn btn-sm btn-primary" data-acct-act="switch" data-acct-id="${esc(acct.id)}">切换</button>` : ''}
            ${!acct.isCurrent ? `<button type="button" class="btn btn-sm ${isConfirmDel ? 'btn-destructive' : 'btn-ghost'}" ${!isConfirmDel ? 'style="color:var(--destructive);"' : ''} data-acct-act="delete" data-acct-id="${esc(acct.id)}">${isConfirmDel ? '确认删除' : '删除'}</button>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ============================================================================
// View 5: Sessions Inspector (Master-Detail + Smooth Monotone AreaChart)
// ============================================================================
async function ensureSessionsLoaded() {
  if (!state.tasks) await loadTasks();
  renderSessionsList();
  const sessions = state.tasks?.sessions || [];
  if (!state.selectedSessionId && sessions.length > 0) {
    selectSession(sessions[0].id);
  }
}

function renderSessionsList() {
  const listEl = $('se-list');
  if (!listEl || !state.tasks) return;
  const q = state.searchQuery.trim().toLowerCase();
  const all = state.tasks.sessions || [];
  const filtered = q
    ? all.filter(s => (s.title || '').toLowerCase().includes(q) || (s.workspaceName || '').toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
    : all;
  $('se-list-count').textContent = `显示 ${filtered.length} / ${all.length} 条会话`;

  if (filtered.length === 0) {
    listEl.innerHTML = renderEmptyState('未匹配到会话', '尝试更换搜索关键词');
    return;
  }
  listEl.innerHTML = filtered.map(s => `
    <button type="button" class="session-item ${s.id === state.selectedSessionId ? 'active' : ''}" data-select-session="${esc(s.id)}">
      <div class="row-between gap-2">
        <span class="font-medium text-sm truncate">${s.pinned ? '★ ' : ''}${esc(s.title)}</span>
        ${s.isRunning ? '<span class="dot pulse"></span>' : (s.isUnread ? '<span class="dot warn"></span>' : '')}
      </div>
      <div class="row-between mono text-xs text-muted">
        <span class="truncate">${esc(s.workspaceName || '全局')} · ${s.stepCount || 0} steps</span>
        <span class="shrink-0">${esc(fmtRelative(s.updateTimeMs))}</span>
      </div>
    </button>
  `).join('');
}

async function selectSession(convId) {
  const seq = ++sessionReqSeq;
  state.selectedSessionId = convId;
  renderSessionsList();
  const metaItem = (state.tasks?.sessions || []).find(s => s.id === convId);
  $('se-title').textContent = metaItem?.title || convId;
  $('se-meta-sub').textContent = `${metaItem?.workspaceName ? `${metaItem.workspaceName} · ` : ''}${convId}`;

  try {
    const detail = await callTool('app_get_session_detail', { conversationId: convId });
    if (seq !== sessionReqSeq || state.selectedSessionId !== convId) return;
    renderSessionDetail(detail);
  } catch (err) {
    if (seq !== sessionReqSeq || state.selectedSessionId !== convId) return;
    $('se-cur-tokens').textContent = '--';
    $('se-max-tokens').textContent = '--';
    $('se-timeline-svg').innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="var(--muted-foreground)" font-size="12">${esc(err.message)}</text>`;
    $('se-breakdown-list').innerHTML = renderEmptyState('暂无本地 Transcript 数据');
    $('se-tools-list').innerHTML = '';
  }
}

function renderSessionDetail(d) {
  if (!d?.overview) return;
  const ov = d.overview;
  const limit = ov.effectiveLimit || ov.modelLimit || 256000;
  const cur = ov.currentTotalContext || 0;
  const pct = Math.min(100, Math.round((cur / Math.max(1, limit)) * 1000) / 10);

  $('se-cur-tokens').textContent = fmtCompact(cur);
  $('se-max-tokens').textContent = fmtCompact(limit);
  $('se-data-src').textContent = d.meta?.isOfficialTelemetry ? '官方遥测' : 'Transcript 估算';

  const badge = $('se-usage-badge');
  badge.textContent = `${pct}%`;
  badge.className = `badge ${pct >= 80 ? 'badge-crit' : pct >= 60 ? 'badge-warn' : 'badge-ok'}`;

  $('se-cache-ratio').textContent = `${ov.cacheHitRatio ?? 0}%`;
  $('se-uncached').textContent = fmtCompact(ov.uncachedTokens || 0);
  $('se-output').textContent = fmtCompact(ov.totalOutputTokens || 0);
  $('se-remaining').textContent = fmtCompact(Math.max(0, limit - cur));

  // Stacked Bar (synchronized with CHART_COLORS 1..4)
  const bd = d.breakdown || [];
  const totalBd = Math.max(1, bd.reduce((acc, x) => acc + (x.tokens || 0), 0));
  const fillPct = Math.min(100, (cur / Math.max(1, limit)) * 100);
  const segIds = ['se-seg-sys', 'se-seg-tool', 'se-seg-user', 'se-seg-model'];
  segIds.forEach((id, idx) => {
    const item = bd[idx];
    const w = item ? (item.tokens / totalBd) * fillPct : 0;
    $(id).style.width = `${w.toFixed(2)}%`;
  });

  // Perf Strip
  const perf = d.performance || {};
  const bodySpd = perf.bodySpeed?.median ?? perf.bodySpeed?.latest;
  const totalSpd = perf.totalSpeed?.avg ?? perf.totalSpeed?.latest;
  const ttftVal = perf.ttft?.median ?? perf.ttft?.latest;
  const latTotal = perf.latency?.totalSeconds;
  $('se-body-speed').textContent = typeof bodySpd === 'number' ? bodySpd.toFixed(1) : '--';
  $('se-total-speed').textContent = typeof totalSpd === 'number' ? totalSpd.toFixed(1) : '--';
  $('se-ttft').textContent = typeof ttftVal === 'number' ? ttftVal.toFixed(2) : '--';
  $('se-latency').textContent = typeof latTotal === 'number' ? fmtDuration(latTotal * 1000) : '--';

  // Smooth AreaChart Timeline
  renderWideTimelineChart(d.timeline || [], d.compactions || []);

  // Breakdown list (color-mapped to Stacked Bar segments)
  $('se-breakdown-list').innerHTML = bd.length > 0
    ? bd.map((item, idx) => {
        const color = CHART_COLORS[idx % 4];
        return `
          <div class="stack gap-1">
            <div class="row-between gap-2 text-xs">
              <span class="row gap-2 min-w-0">
                <span class="color-swatch" style="background:${color};"></span>
                <span class="font-medium truncate">${esc(item.label || item.key)}</span>
              </span>
              <span class="mono text-muted shrink-0">${fmtCompact(item.tokens)} (${item.percent ?? 0}%)</span>
            </div>
            <div class="progress-track"><div class="progress-fill" style="width:${Math.min(100, item.percent || 0)}%;background:${color};"></div></div>
          </div>
        `;
      }).join('')
    : renderEmptyState('暂无构成明细');

  // Tool stats with inline share backdrop
  const toolsObj = d.toolStats && typeof d.toolStats === 'object' ? d.toolStats : {};
  const tools = Object.entries(toolsObj)
    .map(([name, info]) => ({
      name,
      count: Number(info?.count) || 0,
      tokens: Number(info?.estimatedTokens) || 0
    }))
    .sort((a, b) => b.count - a.count);
  const totalCalls = tools.reduce((acc, t) => acc + t.count, 0);
  const maxToolCalls = Math.max(1, ...tools.map(t => t.count));
  $('se-tool-total').textContent = `${totalCalls} 次`;
  $('se-tools-list').innerHTML = tools.length > 0
    ? tools.slice(0, 16).map(t => {
        const bgW = Math.max(6, Math.round((t.count / maxToolCalls) * 100));
        return `
          <div class="tool-stat-row mono">
            <div class="tool-stat-bg" style="width:${bgW}%;"></div>
            <span class="truncate">${esc(t.name)}</span>
            <span class="text-muted shrink-0">${t.count} 次 · ${fmtCompact(t.tokens)}</span>
          </div>
        `;
      }).join('')
    : renderEmptyState('暂无工具调用记录');
}

// Monotone Cubic SVG Path Builder (shadcn/ui AreaChart smooth curve)
function buildSmoothPath(points) {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  if (points.length === 2) {
    return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)} L ${points[1].x.toFixed(1)} ${points[1].y.toFixed(1)}`;
  }

  const n = points.length;
  const dx = [];
  const dy = [];
  const m = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1].x - points[i].x;
    dy[i] = points[i + 1].y - points[i].y;
    m[i] = dx[i] !== 0 ? dy[i] / dx[i] : 0;
  }

  const tangents = new Array(n);
  tangents[0] = m[0];
  tangents[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) {
      tangents[i] = 0;
    } else {
      tangents[i] = (m[i - 1] + m[i]) / 2;
    }
  }

  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
    } else {
      const a = tangents[i] / m[i];
      const b = tangents[i + 1] / m[i];
      const h = Math.hypot(a, b);
      if (h > 3) {
        const s = 3 / h;
        tangents[i] = s * a * m[i];
        tangents[i + 1] = s * b * m[i];
      }
    }
  }

  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const seg = dx[i] / 3;
    const cp1x = points[i].x + seg;
    const cp1y = points[i].y + tangents[i] * seg;
    const cp2x = points[i + 1].x - seg;
    const cp2y = points[i + 1].y - tangents[i + 1] * seg;
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${points[i + 1].x.toFixed(1)} ${points[i + 1].y.toFixed(1)}`;
  }
  return d;
}

function renderWideTimelineChart(timeline, compactions) {
  const svg = $('se-timeline-svg');
  if (!timeline || timeline.length === 0) {
    $('se-tl-stats').textContent = '暂无轮次记录';
    svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="var(--muted-foreground)" font-size="12">暂无上下文演进数据</text>';
    return;
  }

  const ctxOf = (t) => Number(t.total_context) || 0;
  const first = ctxOf(timeline[0]);
  const last = ctxOf(timeline[timeline.length - 1]);
  const peak = Math.max(...timeline.map(ctxOf));
  $('se-tl-stats').textContent = `共 ${timeline.length} 轮 · 首轮 ${fmtCompact(first)} · 峰值 ${fmtCompact(peak)} · 最新 ${fmtCompact(last)}`;

  const W = 840;
  const H = 224;
  const padL = 52;
  const padR = 20;
  const padT = 18;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxY = Math.max(1000, peak * 1.12);

  const xOf = (i) => timeline.length === 1 ? padL + plotW / 2 : padL + (i / (timeline.length - 1)) * plotW;
  const yOf = (v) => padT + plotH - ((v || 0) / maxY) * plotH;

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const y = (padT + plotH - f * plotH).toFixed(1);
    const val = fmtCompact(f * maxY);
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--border)" stroke-dasharray="3 3"/><text x="${padL - 8}" y="${Number(y) + 3}" text-anchor="end" fill="var(--muted-foreground)" font-size="10" class="mono">${val}</text>`;
  }).join('');

  const points = timeline.map((t, i) => ({ x: xOf(i), y: yOf(ctxOf(t)) }));
  const linePath = buildSmoothPath(points);
  const lastPt = points[points.length - 1];
  const firstPt = points[0];
  const areaPath = `${linePath} L ${lastPt.x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${firstPt.x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;

  const compMarks = (compactions || []).map(c => {
    const idx = timeline.findIndex(t => (t.turn || 0) >= (c.turn || 0));
    if (idx < 0) return '';
    const x = xOf(idx).toFixed(1);
    return `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="var(--status-warn)" stroke-dasharray="4 3" stroke-width="1.25"/>`;
  }).join('');

  // Key markers only (Peak + Latest) to keep chart clean
  const peakIdx = timeline.findIndex(t => ctxOf(t) === peak);
  const keyIndices = new Set([peakIdx, timeline.length - 1].filter(i => i >= 0));
  const keyDots = [...keyIndices].map(i => {
    const pt = points[i];
    const isPeak = i === peakIdx;
    return `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${isPeak ? 4.5 : 3.5}" fill="${isPeak ? 'var(--chart-1)' : 'var(--foreground)'}" stroke="var(--card)" stroke-width="2" pointer-events="none"/>`;
  }).join('');

  // Invisible hit bands for smooth crosshair hover across every turn
  const bandW = timeline.length > 1 ? plotW / (timeline.length - 1) : plotW;
  const hitZones = timeline.map((t, i) => {
    const val = ctxOf(t);
    const pt = points[i];
    const isPeak = i === peakIdx;
    const rx = Math.max(padL, pt.x - bandW / 2);
    const rw = Math.min(W - padR, pt.x + bandW / 2) - rx;
    const tip = `第 ${t.turn || (i + 1)} 轮${isPeak ? ' · PEAK' : ''}\n上下文总量: ${fmtCompact(val)}\nPrompt 缓存: ${fmtCompact(t.cache_tokens || 0)}\n未缓存输入: ${fmtCompact(t.input_tokens || 0)}\n生成输出: ${fmtCompact(t.output_tokens || 0)}${t.model ? `\n模型: ${t.model}` : ''}`;
    return `<rect class="tl-hit" x="${rx.toFixed(1)}" y="${padT}" width="${Math.max(4, rw).toFixed(1)}" height="${plotH}" fill="transparent" style="cursor:crosshair;" data-cx="${pt.x.toFixed(1)}" data-cy="${pt.y.toFixed(1)}" data-tip="${esc(tip)}"/>`;
  }).join('');

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="tlAreaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--chart-1)" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="var(--chart-1)" stop-opacity="0.01"/>
      </linearGradient>
    </defs>
    ${gridLines}
    ${compMarks}
    <path d="${areaPath}" fill="url(#tlAreaGrad)"/>
    <path d="${linePath}" fill="none" stroke="var(--chart-1)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    ${keyDots}
    <line id="tl-crosshair" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--muted-foreground)" stroke-dasharray="3 3" stroke-width="1" opacity="0" pointer-events="none"/>
    <circle id="tl-hover-dot" cx="0" cy="0" r="4.5" fill="var(--chart-1)" stroke="var(--card)" stroke-width="2" opacity="0" pointer-events="none"/>
    ${hitZones}
    <text x="${padL}" y="${H - 6}" fill="var(--muted-foreground)" font-size="10" class="mono">T1</text>
    <text x="${W - padR}" y="${H - 6}" text-anchor="end" fill="var(--muted-foreground)" font-size="10" class="mono">T${timeline.length}</text>
  `;
}

// ============================================================================
// View 6: System, Unlock (Radio Cards) & OTA Updater
// ============================================================================
async function loadUnlockStatus(force = false) {
  try {
    const data = await callTool('app_unlock_action', { action: 'status', force });
    state.unlockStatus = data;
    renderUnlockStatus(data);
  } catch (err) {
    showToast(`检测解锁状态失败: ${err.message}`, 'error');
  }
}

function setPresetRadioSelection(preset) {
  const target = ['256k', '512k', '900k'].includes(preset) ? preset : '512k';
  for (const card of document.querySelectorAll('#sy-preset-group [role="radio"]')) {
    card.setAttribute('aria-checked', String(card.dataset.preset === target));
  }
}

function renderUnlockStatus(d) {
  const preset = d.activePreset || '512k';
  setPresetRadioSelection(preset);

  const unlocked = Boolean(d.desktop?.isUnlocked || d.cli?.isUnlocked);
  const badge = $('sy-unlock-badge');
  badge.textContent = unlocked ? '已解锁' : '官方默认 (256K)';
  badge.className = `badge ${unlocked ? 'badge-ok' : ''}`;

  $('rail-unlock-dot').className = `dot ${unlocked ? 'ok' : ''}`;
  $('rail-unlock-text').textContent = `档位 ${preset.toUpperCase()}${unlocked ? ' · 已解锁' : ''}`;

  const renderTarget = (info, badgeId, pathId) => {
    const b = $(badgeId);
    const p = $(pathId);
    if (!info || !info.exists) {
      b.textContent = '未找到';
      b.className = 'badge shrink-0';
      p.textContent = '未检测到可执行文件';
      return;
    }
    b.textContent = info.isUnlocked ? `已解锁${info.appVersion ? ` · v${info.appVersion}` : ''}` : `未解锁${info.appVersion ? ` · v${info.appVersion}` : ''}`;
    b.className = `badge shrink-0 ${info.isUnlocked ? 'badge-ok' : 'badge-warn'}`;
    p.textContent = info.path || '--';
  };
  renderTarget(d.desktop, 'sy-desktop-badge', 'sy-desktop-path');
  renderTarget(d.cli, 'sy-cli-badge', 'sy-cli-path');

  const hasBackup = Boolean(d.desktop?.hasBackup || d.cli?.hasBackup);
  $('sy-restore-btn').disabled = !hasBackup;
}

async function loadUpdateStatus() {
  try {
    const data = await callTool('app_update_action', { action: 'check' });
    state.updateStatus = data;
    state.version = data.currentVersion || state.version;
    $('rail-version').textContent = `v${state.version}`;
    $('sy-curr-ver').textContent = `v${data.currentVersion || '--'}`;
    $('sy-latest-ver').textContent = `v${data.latestVersion || data.currentVersion || '--'}`;
    $('sy-release-date').textContent = data.releaseDate ? String(data.releaseDate).slice(0, 10) : '--';
    $('sy-changelog').textContent = data.changelog || '暂无更新日志';

    const hasUpd = Boolean(data.hasUpdate);
    $('nav-update-badge').hidden = !hasUpd;
    $('sy-apply-update').hidden = !hasUpd;
    const vb = $('sy-ver-badge');
    vb.textContent = hasUpd ? '发现新版本' : '已是最新';
    vb.className = `badge ${hasUpd ? 'badge-warn' : 'badge-ok'}`;
  } catch (err) {
    $('sy-changelog').textContent = `检查更新失败: ${err.message}`;
  }
}

// ============================================================================
// Event Wiring
// ============================================================================
function wireEvents() {
  // Sidebar Toggle
  $('btn-sidebar-toggle').addEventListener('click', toggleSidebar);

  // Global Delegated Clicks
  document.addEventListener('click', async (e) => {
    const navBtn = e.target.closest('[data-nav]');
    if (navBtn) {
      switchNav(navBtn.dataset.nav);
      return;
    }
    const jumpBtn = e.target.closest('[data-jump]');
    if (jumpBtn) {
      switchNav(jumpBtn.dataset.jump);
      return;
    }

    // Heatmap cell click -> drill down into Usage Analytics
    const heatCell = e.target.closest('.heat-cell[data-date]:not(.out-span)');
    if (heatCell && heatCell.dataset.hasData === '1') {
      const dateStr = heatCell.dataset.date;
      state.analyticsRange = 'custom';
      state.analyticsStart = dateStr;
      state.analyticsEnd = dateStr;
      for (const t of document.querySelectorAll('#an-range-tabs [role="tab"]')) {
        t.setAttribute('aria-selected', 'false');
      }
      switchNav('analytics', { skipLoad: true });
      loadAnalytics(false);
      showToast(`已切换至 ${dateStr} 当日分时明细`, 'info');
      return;
    }

    // Task Card Actions
    const jumpConv = e.target.closest('[data-jump-conv]');
    if (jumpConv) {
      await tryJumpToConversation(jumpConv.dataset.jumpConv, jumpConv.dataset.jumpTitle);
      return;
    }
    const openSess = e.target.closest('[data-open-session]');
    if (openSess) {
      const id = openSess.dataset.openSession;
      state.selectedSessionId = id;
      switchNav('sessions', { skipLoad: true });
      if (!state.tasks) await loadTasks();
      selectSession(id);
      return;
    }
    const markRead = e.target.closest('[data-mark-read]');
    if (markRead) {
      try {
        const res = await callTool('app_mark_task_read', {
          conversationId: markRead.dataset.markRead,
          updateTimeMs: Number(markRead.dataset.updateMs) || Date.now()
        });
        if (!res.success) throw new Error(res.error || '操作失败');
        showToast('已标为已读', 'ok');
        loadTasks(true);
      } catch (err) {
        showToast(`标记失败: ${err.message}`, 'error');
      }
      return;
    }

    // Sessions list item select
    const selSess = e.target.closest('[data-select-session]');
    if (selSess) {
      selectSession(selSess.dataset.selectSession);
      return;
    }

    // System Preset Radio Card
    const presetCard = e.target.closest('#sy-preset-group [role="radio"][data-preset]');
    if (presetCard) {
      const preset = presetCard.dataset.preset;
      setPresetRadioSelection(preset);
      try {
        await callTool('app_unlock_action', { action: 'preset', preset });
        showToast(`目标档位已切换为 ${preset.toUpperCase()}`, 'ok');
        loadUnlockStatus(false);
      } catch (err) {
        showToast(`设置档位失败: ${err.message}`, 'error');
      }
      return;
    }

    // Account Actions
    const acctBtn = e.target.closest('[data-acct-act]');
    if (acctBtn) {
      const act = acctBtn.dataset.acctAct;
      const id = acctBtn.dataset.acctId;
      if (act === 'alias') {
        state.editingAliasId = id;
        state.confirmDeleteId = null;
        renderAccounts(state.accountsData);
        const inp = $(`alias-input-${id}`);
        if (inp) { inp.focus(); inp.select(); }
      } else if (act === 'cancel-alias') {
        state.editingAliasId = null;
        renderAccounts(state.accountsData);
      } else if (act === 'save-alias') {
        try {
          const inp = $(`alias-input-${id}`);
          const res = await callTool('app_account_action', { action: 'alias', accountId: id, alias: inp ? inp.value : '' });
          if (!res.success) throw new Error(res.error || '保存备注失败');
          state.editingAliasId = null;
          showToast('备注已更新', 'ok');
          loadAccounts(false);
        } catch (err) {
          showToast(`更新备注失败: ${err.message}`, 'error');
        }
      } else if (act === 'delete') {
        if (state.confirmDeleteId !== id) {
          state.confirmDeleteId = id;
          renderAccounts(state.accountsData);
          return;
        }
        try {
          const res = await callTool('app_account_action', { action: 'delete', accountId: id });
          if (!res.success) throw new Error(res.error || '删除失败');
          state.confirmDeleteId = null;
          showToast('已删除账号快照', 'ok');
          loadAccounts(false);
        } catch (err) {
          showToast(`删除失败: ${err.message}`, 'error');
        }
      } else if (act === 'switch') {
        try {
          const res = await callTool('app_account_action', { action: 'switch', accountId: id });
          if (res.success) {
            const target = res.account?.alias ? `${res.account.alias} (${res.account.email})` : (res.account?.email || id);
            $('dlg-target-acct').textContent = target;
            $('dlg-error').hidden = true;
            const confirmBtn = $('dlg-confirm');
            confirmBtn.disabled = false;
            confirmBtn.textContent = '立即重启';
            $('restart-dialog').showModal();
            loadAccounts(false);
          } else {
            showToast(res.error || '切换失败', 'error');
          }
        } catch (err) {
          showToast(`切换失败: ${err.message}`, 'error');
        }
      }
    }
  });

  // Sortable Table Invoker Commands + Feature-Detected Click Fallback
  const modelTable = $('an-model-table');
  modelTable.addEventListener('command', (e) => {
    if (e.command === '--sort' && e.source) sortModelTable(e.source);
  });
  if (!('commandForElement' in HTMLButtonElement.prototype)) {
    for (const btn of modelTable.tHead.querySelectorAll('button[command="--sort"]')) {
      btn.addEventListener('click', () => sortModelTable(btn));
    }
  }

  // Floating Tooltips & Timeline Crosshair
  document.addEventListener('mouseover', (e) => {
    const tlHit = e.target.closest('.tl-hit');
    if (tlHit) {
      const ch = $('tl-crosshair');
      const dot = $('tl-hover-dot');
      if (ch && dot) {
        ch.setAttribute('x1', tlHit.dataset.cx);
        ch.setAttribute('x2', tlHit.dataset.cx);
        ch.setAttribute('opacity', '0.7');
        dot.setAttribute('cx', tlHit.dataset.cx);
        dot.setAttribute('cy', tlHit.dataset.cy);
        dot.setAttribute('opacity', '1');
      }
      showFloatingTip(tlHit, tlHit.dataset.tip);
      return;
    }
    const target = e.target.closest('[data-tip]');
    if (target) showFloatingTip(target, target.dataset.tip);
  });

  document.addEventListener('mouseout', (e) => {
    const tlHit = e.target.closest('.tl-hit');
    if (tlHit) {
      const nextHit = e.relatedTarget?.closest?.('.tl-hit');
      if (!nextHit) {
        $('tl-crosshair')?.setAttribute('opacity', '0');
        $('tl-hover-dot')?.setAttribute('opacity', '0');
        hideFloatingTip();
      }
      return;
    }
    const target = e.target.closest('[data-tip]');
    if (target) hideFloatingTip();
  });

  // Donut Hover Linkage (SVG & Legend)
  const handleDonutHover = (e) => {
    const item = e.target.closest('[data-donut-idx]');
    highlightDonutSegment(item ? item.dataset.donutIdx : null);
  };
  $('an-donut-svg').addEventListener('mouseover', handleDonutHover);
  $('an-donut-svg').addEventListener('mouseout', () => highlightDonutSegment(null));
  $('an-donut-legend').addEventListener('mouseover', handleDonutHover);
  $('an-donut-legend').addEventListener('mouseout', () => highlightDonutSegment(null));

  // Histogram Hover
  $('an-hist-bars').addEventListener('mouseover', (e) => {
    const bar = e.target.closest('.hist-bar[data-bidx]');
    if (!bar || !state.analytics?.chart?.buckets) return;
    const idx = Number(bar.dataset.bidx);
    const b = state.analytics.chart.buckets[idx];
    if (!b) return;
    for (const el of $('an-hist-bars').children) el.classList.remove('active');
    bar.classList.add('active');
    $('an-b-time').textContent = b.time || '--';
    $('an-b-total').textContent = b.compactTotal || b.fullTotal || '--';
    $('an-b-in').textContent = b.inputCompact || '--';
    $('an-b-out').textContent = b.outputCompact || '--';
    $('an-b-cache').textContent = b.cacheCompact || '--';
    $('an-b-cost').textContent = b.cost || '$0.00';
  });

  // Analytics Range Tabs (Click + Arrow Keys)
  const selectRangeTab = (tab) => {
    for (const t of $('an-range-tabs').querySelectorAll('[role="tab"]')) {
      t.setAttribute('aria-selected', String(t === tab));
    }
    state.analyticsRange = tab.dataset.range;
    state.analyticsStart = '';
    state.analyticsEnd = '';
    loadAnalytics(false);
  };
  $('an-range-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"][data-range]');
    if (tab) selectRangeTab(tab);
  });
  $('an-range-tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const tabs = [...$('an-range-tabs').querySelectorAll('[role="tab"]')];
    const idx = tabs.indexOf(document.activeElement);
    if (idx < 0) return;
    e.preventDefault();
    const next = tabs[(idx + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    next.focus();
    selectRangeTab(next);
  });

  $('an-apply-custom').addEventListener('click', () => {
    const s = $('an-start-date').value;
    const end = $('an-end-date').value;
    if (!s || !end) return showToast('请选择完整的起止日期', 'warn');
    for (const t of $('an-range-tabs').querySelectorAll('[role="tab"]')) {
      t.setAttribute('aria-selected', 'false');
    }
    state.analyticsRange = 'custom';
    state.analyticsStart = s <= end ? s : end;
    state.analyticsEnd = s <= end ? end : s;
    loadAnalytics(false);
  });

  // Model Distribution Tabs
  const selectDistTab = (tab) => {
    const isTok = tab.dataset.dist === 'tokens';
    for (const t of $('an-model-tabs').querySelectorAll('[role="tab"]')) {
      t.setAttribute('aria-selected', String(t === tab));
    }
    $('panel-dist-tokens').hidden = !isTok;
    $('panel-dist-cost').hidden = isTok;
  };
  $('an-model-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"][data-dist]');
    if (tab) selectDistTab(tab);
  });
  $('an-model-tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const tabs = [...$('an-model-tabs').querySelectorAll('[role="tab"]')];
    const idx = tabs.indexOf(document.activeElement);
    if (idx < 0) return;
    e.preventDefault();
    const next = tabs[(idx + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    next.focus();
    selectDistTab(next);
  });

  // Topbar Global Refresh
  $('btn-global-refresh').addEventListener('click', async () => {
    const icon = $('refresh-icon');
    icon.classList.add('is-spinning');
    try {
      if (state.activeNav === 'overview') await Promise.all([loadHeatmap(true), loadTasks(true)]);
      else if (state.activeNav === 'tasks') await loadTasks(true);
      else if (state.activeNav === 'analytics') await loadAnalytics(true);
      else if (state.activeNav === 'accounts') await loadAccounts(true);
      else if (state.activeNav === 'sessions') {
        await loadTasks(true);
        if (state.selectedSessionId) await selectSession(state.selectedSessionId);
      } else if (state.activeNav === 'system') {
        await Promise.all([loadUnlockStatus(true), loadUpdateStatus()]);
      }
    } finally {
      setTimeout(() => icon.classList.remove('is-spinning'), 250);
    }
  });

  // Tasks Toolbar Actions
  $('tm-refresh-btn').addEventListener('click', () => loadTasks(true));
  $('tm-mark-all-btn').addEventListener('click', async () => {
    const unread = state.tasks?.unread || [];
    if (unread.length === 0) return;
    try {
      const res = await callTool('app_mark_task_read', {
        all: true,
        items: unread.map(u => ({ id: u.id, updateTimeMs: u.updateTimeMs }))
      });
      if (!res.success) throw new Error(res.error || '批量标记失败');
      showToast(`已将 ${res.count || unread.length} 个会话标为已读`, 'ok');
      loadTasks(true);
    } catch (err) {
      showToast(`批量标记失败: ${err.message}`, 'error');
    }
  });

  // Accounts Actions
  $('ac-refresh-btn').addEventListener('click', () => loadAccounts(true));
  $('ac-capture-btn').addEventListener('click', async () => {
    try {
      const res = await callTool('app_account_action', { action: 'capture' });
      showToast(res.captured ? '当前账号快照已保存' : (res.error || '捕获失败'), res.captured ? 'ok' : 'warn');
      loadAccounts(false);
    } catch (err) {
      showToast(`捕获失败: ${err.message}`, 'error');
    }
  });

  // Sessions Search & Copy
  $('se-search').addEventListener('input', (e) => {
    state.searchQuery = e.target.value || '';
    renderSessionsList();
  });
  $('se-reload-list').addEventListener('click', () => loadTasks(true));
  $('se-copy-jump-btn').addEventListener('click', () => {
    if (!state.selectedSessionId) return;
    const item = (state.tasks?.sessions || []).find(s => s.id === state.selectedSessionId);
    tryJumpToConversation(state.selectedSessionId, item?.title || state.selectedSessionId);
  });

  // System Unlock & Update Actions
  $('sy-preset-group').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const radios = [...$('sy-preset-group').querySelectorAll('[role="radio"]')];
    const idx = radios.indexOf(document.activeElement);
    if (idx < 0) return;
    e.preventDefault();
    const next = radios[(idx + (e.key === 'ArrowRight' ? 1 : -1) + radios.length) % radios.length];
    next.focus();
    next.click();
  });

  $('sy-copy-log').addEventListener('click', async () => {
    const ok = await copyText($('sy-log-box').textContent || '');
    showToast(ok ? '已复制执行日志' : '复制失败', ok ? 'ok' : 'error');
  });

  $('sy-recheck-btn').addEventListener('click', () => loadUnlockStatus(true));
  $('sy-unlock-btn').addEventListener('click', async () => {
    $('sy-log-card').hidden = false;
    $('sy-log-box').textContent = '正在执行上下文门禁解锁...';
    try {
      const res = await callTool('app_unlock_action', { action: 'unlock', target: 'all' });
      $('sy-log-box').textContent = res.output || res.message || JSON.stringify(res, null, 2);
      showToast(res.message || (res.success ? '解锁完成，重启 Antigravity 后生效' : '解锁失败'), res.success ? 'ok' : 'error');
      loadUnlockStatus(true);
    } catch (err) {
      $('sy-log-box').textContent = err.message;
      showToast(`解锁异常: ${err.message}`, 'error');
    }
  });

  $('sy-restore-btn').addEventListener('click', async () => {
    $('sy-log-card').hidden = false;
    $('sy-log-box').textContent = '正在还原官方原始二进制备份...';
    try {
      const res = await callTool('app_unlock_action', { action: 'restore', target: 'all' });
      $('sy-log-box').textContent = res.output || res.message || JSON.stringify(res, null, 2);
      showToast(res.message || (res.success ? '备份已还原' : '还原失败'), res.success ? 'ok' : 'error');
      loadUnlockStatus(true);
    } catch (err) {
      $('sy-log-box').textContent = err.message;
      showToast(`还原异常: ${err.message}`, 'error');
    }
  });

  $('sy-check-update').addEventListener('click', () => loadUpdateStatus());
  $('sy-open-repo').addEventListener('click', () => {
    if (app.getHostCapabilities()?.openLinks) {
      app.openLink({ url: 'https://github.com/q1uuuu/agy-context' });
    } else {
      window.open('https://github.com/q1uuuu/agy-context', '_blank', 'noopener');
    }
  });
  $('sy-apply-update').addEventListener('click', async () => {
    const btn = $('sy-apply-update');
    btn.disabled = true;
    btn.textContent = '升级中...';
    try {
      const res = await callTool('app_update_action', { action: 'apply' });
      showToast(res.message || '升级完成', 'ok');
      loadUpdateStatus();
    } catch (err) {
      showToast(`升级失败: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '一键热升级';
    }
  });

  // Restart AlertDialog (Light Dismiss Fallback + Smooth Top-Layer Exit)
  const dlg = $('restart-dialog');
  $('dlg-cancel').addEventListener('click', () => closeTopLayerDialog(dlg));
  dlg.addEventListener('cancel', (event) => {
    if (!supportsTopLayerExit()) {
      event.preventDefault();
      closeTopLayerDialog(dlg);
    }
  });
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    dlg.addEventListener('click', (event) => {
      if (event.target !== dlg) return;
      const rect = dlg.getBoundingClientRect();
      const inside =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (!inside) closeTopLayerDialog(dlg);
    });
  }

  $('dlg-confirm').addEventListener('click', async () => {
    const btn = $('dlg-confirm');
    btn.disabled = true;
    btn.textContent = '重启中...';
    try {
      const res = await callTool('app_account_action', { action: 'restart' });
      if (!res.success) throw new Error(res.error || '重启失败');
      showToast('正在重启 Antigravity...', 'ok');
    } catch (err) {
      $('dlg-error').hidden = false;
      $('dlg-error').textContent = err.message;
      btn.disabled = false;
      btn.textContent = '重试重启';
    }
  });
}

// ============================================================================
// Bootstrap MCP App Connection (Register handlers BEFORE connect!)
// ============================================================================
app.ontoolinput = () => {};

app.ontoolresult = (result) => {
  const sc = result?.structuredContent;
  if (!sc) return;
  if (sc.version) {
    state.version = sc.version;
    $('rail-version').textContent = `v${sc.version}`;
  }
  if (sc.tasks) {
    state.tasks = sc.tasks;
    renderTasksViews(sc.tasks);
  }
  if (sc.initialTab && NAV_META[sc.initialTab]) {
    switchNav(sc.initialTab);
  }
};

app.onhostcontextchanged = (ctx) => {
  applyHostContext(ctx);
};

async function init() {
  wireEvents();
  await app.connect();
  state.connected = true;
  applyHostContext(app.getHostContext());

  // Initial parallel load (queued to <=3 concurrent calls)
  loadHeatmap(false);
  if (!state.tasks) loadTasks();
  loadAccounts(false);
  loadUnlockStatus(false);
  loadUpdateStatus();

  // Live polling for Multi-Task Monitor (5s when on Tasks/Overview)
  setInterval(() => {
    if (document.hidden) return;
    if (state.activeNav === 'tasks' && $('tm-autopoll-chk').checked) {
      loadTasks();
    } else if (state.activeNav === 'overview') {
      loadTasks();
    }
  }, 5000);

  // Quota periodic refresh (30s)
  setInterval(() => {
    if (document.hidden) return;
    loadAccounts(false);
  }, 30000);
}

init().catch((err) => {
  showToast(`初始化连接失败: ${err.message}`, 'error');
});
