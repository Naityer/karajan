"use strict";

// ---- constants -------------------------------------------------------------
const TIERS = [
  "cheap_model",
  "cheap_or_medium_model",
  "medium_model",
  "strong_model",
  "strong_model_with_human_review",
];
const TIER_LABEL = {
  cheap_model: "barato",
  cheap_or_medium_model: "barato/medio",
  medium_model: "medio",
  strong_model: "fuerte",
  strong_model_with_human_review: "fuerte + revisión",
};
const LEVELS = [
  ["level_1_simple", "N1"],
  ["level_2_moderate", "N2"],
  ["level_3_intermediate", "N3"],
  ["level_4_complex", "N4"],
  ["level_5_critical", "N5"],
];
const LEVEL_FULL = {
  level_1_simple: "N1 · simple",
  level_2_moderate: "N2 · moderada",
  level_3_intermediate: "N3 · intermedia",
  level_4_complex: "N4 · compleja",
  level_5_critical: "N5 · crítica",
};
// Hierarchy is now expressed through named/colored "Prio" groups (state.groups)
// that entities join via `entity.memberships`, replacing the old fixed
// Raíz/L1/L2/L3 tier tags. `effective_tier()` = min(prio) drives real dispatch
// server-side. Per-group membership renders as a "Grupo · Prio N" chip.
const GROUP_COLOR_PALETTE = [
  "#7cc4ff",
  "#ffb25f",
  "#b9a7ff",
  "#5fd0a8",
  "#ff8fb1",
  "#f2d05a",
];
function nextGroupColor() {
  const used = (state.groups || []).length;
  return GROUP_COLOR_PALETTE[used % GROUP_COLOR_PALETTE.length];
}
function prioChipLabel(n) {
  return `Prio ${n}`;
}
// Group colors come from an <input type="color"> (#rrggbb) but may be
// hand-edited in the persisted JSON; sanitize before injecting into SVG markup.
function safeColor(value) {
  return /^#[0-9a-fA-F]{3,8}$/.test(String(value || "")) ? value : "#7cc4ff";
}
const CRITERIA = [
  "ambiguity",
  "context_required",
  "reasoning_depth",
  "autonomy_required",
  "operational_risk",
  "validation_difficulty",
];
const DIAGRAM_BASE_WIDTH = 12000;
const DIAGRAM_BASE_HEIGHT = 8000;
const DIAGRAM_PAD_X = 6000;
const DIAGRAM_PAD_Y = 4000;

const state = {
  config: null,
  catalog: [],
  providers: [],
  skills: [],
  tasks: [],
  selected: null,
  parentProvider: "",
  entities: [],
  groups: [],
  modelDrawerOpen: true,
  drawerWidth: 320,
  decisionCatalogQuery: "",
  resizingDrawer: false,
  diagramZoom: 1,
  panningDiagram: false,
  draggingDiagramNode: false,
  diagramCentered: false,
  openSkillPanels: new Set(),
  selectedNodeId: "",
  focusedDiagramLink: null,
  nodeFilter: "__all__",
  openclawPos: readOpenClawPos(),
  lastObservability: null,
  lastMetrics: null,
  metricsHistory: null,
  healthHistory: [],
  nodeActivityHistory: {},
  onboardingStep: 1,
  monitorSideOpen: true,
  monitorSubview: "resumen",
  monitorSideWidth: 380,
  resizingMonitorSide: false,
  monitorBlockOrder: ["summary", "health", "flow"],
  humanSideOpen: true,
  humanSideWidth: 430,
  resizingHumanSide: false,
  configTab: "general",
  configMode: "prompting",
  selectedPromptTemplate: "hierarchy",
  promptTemplateFormOpen: false,
  promptLibraryOpen: true,
  promptLibraryQuery: "",
  selectedConfigAgent: "",
  agentsSideOpen: true,
  agentsSideWidth: 420,
  resizingAgentsSide: false,
  notificationsOpen: false,
  agentNotificationsOpen: false,
  promptSideMode: "templates",
  selectedPromptResourceId: "",
  // Parsed contents of /static/resource-library.md (Roles/Niveles/Restricciones),
  // loaded once on init and shared by both config modes. null until it resolves.
  resourceLibraryDoc: null,
  activeView: "human",
};

const ROLE_DEFS = {
  parent: {
    label: "Agent",
    summary: "Orquesta, clasifica, planifica, enruta y delega.",
    group: "Autoridad",
    restriction: "R0",
    kind: "agent",
    canOwnLevels: true,
    canConnectToAgent: false,
  },
  child: {
    label: "Worker",
    summary: "Ejecuta tareas concretas asignadas por el Agent.",
    group: "Ejecución",
    restriction: "R1",
    kind: "worker",
    canOwnLevels: true,
    canConnectToAgent: true,
  },
  backup: {
    label: "Backup",
    summary: "Reserva en standby; puede asumir Agent si falla el principal.",
    group: "Ejecución",
    restriction: "R1",
    kind: "backup",
    canOwnLevels: true,
    canConnectToAgent: true,
  },
  guardian: {
    label: "Guardian",
    summary: "Apoya o revisa un Worker concreto.",
    group: "Soporte",
    restriction: "R2",
    kind: "guardian",
    canOwnLevels: false,
    canConnectToAgent: true,
  },
  validator: {
    label: "Validator",
    summary: "Valida salidas parciales o finales de otros nodos.",
    group: "Soporte",
    restriction: "R2",
    kind: "validator",
    canOwnLevels: false,
    canConnectToAgent: true,
  },
  fixer: {
    label: "Fixeador",
    summary: "Recibe hallazgos de código, aplica parches y verifica con la auditoría.",
    group: "Soporte",
    restriction: "R2",
    kind: "fixer",
    canOwnLevels: false,
    canConnectToAgent: true,
  },
  memory: {
    label: "Memory",
    summary: "Mantiene estado, checkpoints y contexto.",
    group: "Estado",
    restriction: "R3",
    kind: "memory",
    canOwnLevels: false,
    canConnectToAgent: true,
  },
  monitor: {
    label: "Monitor",
    summary: "Vigila salud, timeouts, errores y disponibilidad.",
    group: "Estado",
    restriction: "R3",
    kind: "monitor",
    canOwnLevels: false,
    canConnectToAgent: true,
  },
};

const PRIMARY_ROLES = ["parent", "child", "backup"];
const SUPPORT_ROLES = ["guardian", "validator", "fixer", "memory", "monitor"];
// Hierarchy depth is no longer a role tag — it lives in `state.groups` +
// `entity.memberships` (see GROUP_COLOR_PALETTE above). The ROL dropdown only
// keeps Autoridad/Ejecución/Soporte/Estado now.
const ROLE_GROUPS = ["Autoridad", "Ejecución", "Soporte", "Estado"];

const AGENT_INTERNAL_CAPABILITIES = ["Classifier", "Planner", "Router"];
const AGENT_OPTIONAL_CAPABILITIES = [
  ["Reallocator", "Reasigna roles, tareas y enlaces cuando la jerarquía se rompe."],
  ["Aggregator", "Consolida respuestas de varios nodos."],
  ["Policy", "Aplica permisos, límites y reglas críticas."],
  ["Recovery", "Gestiona reintentos y recuperación operativa."],
];
const AGENT_CAPABILITY_DEFS = [
  ...AGENT_INTERNAL_CAPABILITIES.map((name) => [name, "Base Agent", "Capacidad base del Agent."]),
  ...AGENT_OPTIONAL_CAPABILITIES.map(([name, description]) => [name, "Agent avanzado", description]),
];

// ---- helpers ---------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

let toastTimer = null;
function toast(message, ms = 2400) {
  const node = $("#toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), ms);
}

let routingSaveTimer = null;
let flowSaveTimer = null;
let layoutSaveTimer = null;
let configHitTimer = null;
let activeModelDrag = null;
let activeEntityMove = null;
let activeGroupMove = null;
let activeDiagramPan = null;
let wiresFrame = null;
function scheduleRoutingSave(message = "Cambio detectado. Guardando enrutado…") {
  persistEntityState();
  toast(message, 1400);
  clearTimeout(routingSaveTimer);
  routingSaveTimer = setTimeout(() => saveRouting(true), 650);
}

function scheduleFlowSave() {
  toast("Cambio detectado. Guardando configuración…", 1400);
  clearTimeout(flowSaveTimer);
  flowSaveTimer = setTimeout(() => saveFlow(true), 650);
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function entityLabel(id) {
  const entity = (state.entities || []).find((item) => item.id === id);
  if (!entity) return id || "entidad";
  const provider = (state.catalog || []).find((item) => item.name === entity.provider);
  return entity.name || provider?.label || entity.provider || entity.id;
}

// ---- theme -----------------------------------------------------------------
function initTheme() {
  applyTheme(localStorage.getItem("karajan-theme") || "dark");
  $("#themeSwitch").addEventListener("click", (event) => {
    const button = event.target.closest("[data-theme]");
    if (button) applyTheme(button.dataset.theme);
  });
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("karajan-theme", theme);
  $$("#themeSwitch .sw").forEach((s) => s.classList.toggle("active", s.dataset.theme === theme));
  if ($("#view-decision").classList.contains("active")) scheduleDrawWires();
}

// ---- view switching --------------------------------------------------------
function initViews() {
  $("#viewNav").addEventListener("click", (event) => {
    const tab = event.target.closest(".view-tab");
    if (!tab) return;
    const view = tab.dataset.view;
    $$(".view-tab").forEach((t) => t.classList.toggle("active", t === tab));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
    state.activeView = view;
    enterView(view);
  });
}

// ---- automatic data refresh -------------------------------------------------
// Replaces the old manual "Recargar/Guardar/Actualizar/Comprobar conexiones"
// buttons: each view fetches its own fresh data the moment it becomes active,
// and a background poll keeps the live views (monitor/human/agents) current
// without the user having to ask for it.
const AUTO_REFRESH_INTERVAL_MS = 20000;

function enterView(view) {
  if (view === "decision") {
    renderDiagram();
    renderModels();
  }
  if (view === "flow") loadConfig().then(renderFlow).catch((error) => toast(error.message));
  if (view === "agents") refreshProvidersAndAgents().catch((error) => toast(error.message));
  if (view === "monitor") {
    // Restore the last-selected sub-view (segmented control state), then let the
    // sub-view dispatcher own the data refresh for whatever is shown.
    restoreMonitorSubview();
    // Analytics/predictions ride the view-entry path only (not the 20s poll) —
    // trends don't need sub-second reactivity and DuckDB queries stay off the hot loop.
    renderAnalyticsSection().catch(() => {});
    renderPredictionsPanel().catch(() => {});
  }
  if (view === "human") refreshHuman().catch((error) => toast(error.message));
  // Human view canvas: on (re)entry, start the real-task-or-demo animation if
  // nothing is playing yet. Guarded internally (bootstrap runs at most once).
  if (view === "human" && window.karajanCanvas) {
    try { window.karajanCanvas.bootstrap(); } catch (_) {}
  }
}

// Human owns a light data path — just /tasks feeding the notification bell and
// the isometric canvas — instead of piggybacking on Monitor's heavier
// /metrics+/observability+/history poll. The visible Human surface is the real
// canvas plus the approve/reject action (bell → /tasks/{id}/approve-review), so
// no independent cost/latency or provider-card computation happens here.
async function refreshHuman() {
  const tasks = await api("/tasks").catch(() => state.tasks || []);
  state.tasks = tasks;
  renderNotifications();
  renderAgentNotifications();
}

function initAutoRefresh() {
  setInterval(() => {
    const view = state.activeView || "human";
    if (view === "monitor") refreshMonitor().catch(() => {});
    if (view === "human") refreshHuman().catch(() => {});
    if (view === "agents") refreshProvidersAndAgents().catch(() => {});
    // Decisión: refresh only the provider/readiness panel (renderModels),
    // never renderDiagram — re-rendering the editable canvas mid-interaction
    // would fight the user. This keeps "Arquitectura activa" live (which
    // providers are ready) as models get installed/authenticated. The Grafo
    // iframe self-refreshes on its own; the flow/config view is edit-only.
    if (view === "decision") renderModels().catch(() => {});
  }, AUTO_REFRESH_INTERVAL_MS);
}

// ---- live push (SSE) --------------------------------------------------------
// The 20s poll above is the resilience fallback; this makes the UI react the
// instant the backend publishes a change (a task delegated by an agent, a scan
// or audit finishing, config/architecture edited). One EventSource, dispatched
// to whichever view is active. The Grafo iframe opens its own EventSource.
function initLiveEvents() {
  let es;
  try {
    es = new EventSource("/events");
  } catch (_) {
    return; // no SSE support → the poll still keeps things fresh
  }
  es.onmessage = (event) => {
    let ev;
    try { ev = JSON.parse(event.data); } catch (_) { return; }
    const view = state.activeView || "human";
    // A real delegation lifecycle: task classified/delegated (task_changed) or a
    // run started/finished (run_started/run_completed, Fase 1). This is the single
    // dispatcher — Monitor and the human canvas both react here, no private polls.
    if (ev.type === "task_changed" || ev.type === "run_started" || ev.type === "run_completed") {
      if (view === "monitor") refreshMonitor().catch(() => {});
      else if (view === "human") refreshHuman().catch(() => {});
      // Drive the human-view isometric canvas from the real task/run lifecycle,
      // and refresh its per-agent metrics (nodeData) — replacing its old 5s poll.
      if (view === "human" && window.karajanCanvas) {
        try {
          window.karajanCanvas.onTaskChanged(ev.task_id);
          if (window.karajanCanvas.refreshNodes) window.karajanCanvas.refreshNodes();
        } catch (_) {}
      }
    } else if (ev.type === "config_changed") {
      if (view === "decision") renderModels().catch(() => {});
      else if (view === "agents") refreshProvidersAndAgents().catch(() => {});
      else if (view === "flow") loadConfig().then(renderFlow).catch(() => {});
    } else if (ev.type === "layout_changed" && view === "decision") {
      renderModels().catch(() => {});
    }
    // repo_scanned / repo_audited are consumed by the Grafo iframe directly.
  };
  // EventSource auto-reconnects on error; nothing to do here.
}

function setNotificationsOpen(open) {
  state.notificationsOpen = open;
  const panel = $("#notificationPanel");
  const button = $("#notificationBell");
  if (panel) panel.hidden = !open;
  if (button) button.setAttribute("aria-expanded", String(open));
  if (open) renderNotifications();
}

function setAgentNotificationsOpen(open) {
  state.agentNotificationsOpen = open;
  const panel = $("#agentNotificationPanel");
  const button = $("#agentNotificationBot");
  if (panel) panel.hidden = !open;
  if (button) button.setAttribute("aria-expanded", String(open));
  if (open) renderAgentNotifications();
}

function buildNotificationItems() {
  const tasks = state.tasks || [];
  const pending = tasks.filter((task) => task.classification?.requires_human_review || task.status === "delegated");
  const health = state.lastObservability?.health || {};
  return [
    ...pending.slice(0, 4).map((task) => ({
      kind: "decision",
      tone: "warn",
      title: task.classification?.intent || "Decisión pendiente",
      meta: `${task.classification?.domain?.slice(0, 2).join(", ") || "sin dominio"} · ${Number(task.classification?.complexity_score || 0).toFixed(2)}`,
      action: task.status === "delegated" && task.classification?.requires_human_review ? "Aprobar" : "Revisar",
      taskId: task.task_id,
    })),
    ...(health.blocked_tasks
      ? [{
          kind: "health",
          tone: "warn",
          title: `${health.blocked_tasks} tareas bloqueadas`,
          meta: "Revisar coste, credenciales o aprobación humana.",
          action: "Ver Monitor",
        }]
      : []),
  ];
}

function buildAgentNotificationItems() {
  const providers = state.catalog || [];
  const statusByProvider = new Map((state.providers || []).map((item) => [item.provider, item]));
  return providers
    .filter((provider) => !statusByProvider.get(provider.name)?.ready)
    .slice(0, 8)
    .map((provider) => ({
      kind: "provider",
      tone: statusByProvider.get(provider.name)?.available ? "warn" : "bad",
      title: provider.label,
      meta: provider.auth_method === "api_key" ? provider.env_var || "API key pendiente" : provider.login_command || "conexión pendiente",
      action: "Configurar",
      provider: provider.name,
      cost: provider.is_free ? "Gratis" : "Pago",
    }));
}

function renderNotifications() {
  const items = buildNotificationItems();
  const badge = $("#notificationBadge");
  const count = $("#notificationPanelCount");
  const body = $("#notificationSummary");
  const actionable = items.filter((item) => item.kind !== "health").length;
  if (badge) {
    badge.textContent = String(actionable);
    badge.hidden = actionable === 0;
  }
  if (count) count.textContent = String(actionable);
  if (!body) return;
  if (!items.length) {
    body.innerHTML = `<div class="notification-empty"><b>Todo despejado</b><span>No hay aprobaciones ni avisos de ejecución pendientes.</span></div>`;
    return;
  }
  body.innerHTML = items
    .map((item) => `<article class="notification-item ${item.tone}">
      <span class="status-dot ${item.tone === "bad" ? "bad" : item.tone === "ok" ? "ok" : "warn"}"></span>
      <div>
        <b>${escapeHtml(item.title)}</b>
        <small>${escapeHtml(item.meta)}</small>
      </div>
      ${
        item.taskId
          ? `<button type="button" data-notification-task="${escapeHtml(item.taskId)}" ${item.action === "Aprobar" ? `data-approve="${escapeHtml(item.taskId)}"` : ""}>${escapeHtml(item.action)}</button>`
          : item.provider
            ? `<button type="button" data-notification-provider="${escapeHtml(item.provider)}">${escapeHtml(item.action)}</button>`
            : `<button type="button" data-notification-monitor>${escapeHtml(item.action)}</button>`
      }
    </article>`)
    .join("");
}

function renderAgentNotifications() {
  const items = buildAgentNotificationItems();
  const badge = $("#agentNotificationBadge");
  const count = $("#agentNotificationPanelCount");
  const body = $("#agentNotificationSummary");
  if (badge) {
    badge.textContent = String(items.length);
    badge.hidden = items.length === 0;
  }
  if (count) count.textContent = String(items.length);
  if (!body) return;
  if (!items.length) {
    body.innerHTML = `<div class="notification-empty"><b>Agentes listos</b><span>No hay conexiones pendientes.</span></div>`;
    return;
  }
  body.innerHTML = items
    .map((item) => `<article class="notification-item ${item.tone}">
      <span class="status-dot ${item.tone === "bad" ? "bad" : "warn"}"></span>
      <div>
        <b>${escapeHtml(item.title)}</b>
        <small>${escapeHtml(item.meta)} · ${escapeHtml(item.cost)}</small>
      </div>
      <button type="button" data-notification-provider="${escapeHtml(item.provider)}">${escapeHtml(item.action)}</button>
    </article>`)
    .join("");
}

// ---- MONITOR ---------------------------------------------------------------

// Sub-navigation (segmented control: Resumen | Agentes | Tareas). Only one
// sub-view is visible at a time; the last choice persists in localStorage. Each
// sub-view lazily triggers its own data refresh when shown via enterSubview()
// — a dispatcher that Phases B/C/D will specialise. For now every sub-view
// shares refreshMonitor(); SSE live updates keep flowing regardless.
const MONITOR_SUBVIEWS = ["resumen", "agentes", "tareas"];
const MONITOR_SUBVIEW_KEY = "karajan-monitor-subview";

function initMonitorSubnav() {
  const nav = $("#monitorSubnav");
  if (!nav || nav.dataset.bound) return;
  nav.dataset.bound = "1";
  nav.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-subview]");
    if (!tab) return;
    enterSubview(tab.dataset.subview);
  });
}

function restoreMonitorSubview() {
  const stored = localStorage.getItem(MONITOR_SUBVIEW_KEY);
  const name = MONITOR_SUBVIEWS.includes(stored) ? stored : "resumen";
  enterSubview(name);
}

function enterSubview(name) {
  if (!MONITOR_SUBVIEWS.includes(name)) name = "resumen";
  state.monitorSubview = name;
  localStorage.setItem(MONITOR_SUBVIEW_KEY, name);
  $$("#monitorSubnav .monitor-subtab").forEach((tab) => {
    const on = tab.dataset.subview === name;
    tab.classList.toggle("active", on);
    tab.setAttribute("aria-selected", String(on));
  });
  MONITOR_SUBVIEWS.forEach((key) => {
    const section = $(`#subview-${key}`);
    if (!section) return;
    const on = key === name;
    section.classList.toggle("active", on);
    section.hidden = !on;
  });
  // Lazy per-sub-view refresh. Phases B/C/D specialise this; the shared
  // refreshMonitor() path still fetches once and (Phase B) also feeds the
  // executive Resumen renderer at its tail when Resumen is active.
  // On entering Resumen, drop the cached analytics so the trend charts refetch
  // fresh (they otherwise ride the cache to stay off the SSE hot loop).
  if (name === "resumen") state.resumenAnalytics = null;
  // Agentes shares the same /analytics/dashboard cache; drop it on entry so the
  // latency percentiles refetch fresh, then ride the cache on SSE/poll.
  if (name === "agentes") state.resumenAnalytics = null;
  // Tareas shares the same /analytics/dashboard cache (success-by-type,
  // runs-over-time); drop it on entry so those refetch fresh, then ride the cache.
  if (name === "tareas") state.resumenAnalytics = null;
  refreshMonitor().catch(() => {});
}

async function refreshMonitor() {
  if (!$("#monitorMainContent")) return;
  const [metrics, tasks, observability, providers, history, performance] = await Promise.all([
    api("/metrics"),
    api("/tasks"),
    api("/observability"),
    api("/providers"),
    api("/observability/history").catch(() => ({ points: [] })),
    api("/agents/performance").catch(() => []),
  ]);
  state.tasks = tasks;
  state.lastObservability = observability;
  state.lastMetrics = metrics;
  state.providers = providers;
  state.metricsHistory = history;
  state.agentPerformance = performance;
  renderNotifications();
  renderAgentNotifications();
  if (!state.selectedNodeId && observability.nodes?.length) state.selectedNodeId = observability.nodes[0].id;
  renderSummaryMetrics(metrics, tasks, observability);
  renderSystemHealth(observability.health);
  renderExecutionFlow(observability.execution_flow || []);
  renderNodeOverview(observability.nodes || [], metrics, observability.model_usage || []);
  // Human is decoupled: it owns its own light data path (refreshHuman) driven by
  // view activation + SSE — Monitor no longer renders Human panels as a side effect.
  _renderAgentPanels(observability.nodes || [], observability.execution_flow || [], observability.audit_timeline || []);
  renderAuditTimeline(observability.audit_timeline || []);
  renderTaskRows(tasks);
  const selected = tasks.find((t) => t.task_id === state.selected) || tasks[0];
  if (selected) {
    state.selected = selected.task_id;
    await renderDetail(selected);
  }
  // Phase B: the executive Resumen sub-view renders from this same fetch bundle
  // when it's the active sub-view, so SSE/poll updates flow to its KPI tiles
  // without a second EventSource or a duplicate network round-trip.
  if (state.monitorSubview === "resumen") {
    renderResumen({ metrics, observability, performance }).catch(() => {});
  }
  // Phase C: the Agentes analytics + merged config ride the same fetch bundle when
  // Agentes is the active sub-view, so SSE/poll updates flow to the leaderboard,
  // percentiles, cost and skills heatmap without a duplicate round-trip.
  if (state.monitorSubview === "agentes") {
    renderAgentes({ metrics, observability, performance }).catch(() => {});
  }
  // Phase D: the Tareas analytics band + task table (and any open drill-down)
  // ride the same fetch bundle when Tareas is active, so SSE/poll (task_changed,
  // run_completed) refresh the KPIs/table live without a duplicate round-trip.
  // The open drill-down (state.tareasOpenTask) survives the refresh.
  if (state.monitorSubview === "tareas") {
    renderTareas({ metrics, tasks, observability, performance }).catch(() => {});
  }
}

// ---- Resumen sub-view (Phase B) --------------------------------------------
// Executive KPI/analytics dashboard built entirely from the Phase A dataviz
// component library (statTileRow, smallMultiples, hbarChart, chartFrame,
// dataTable) so it is theme-aware (dark/light/amber) and colourblind-safe by
// construction. Accepts an optional pre-fetched {metrics, observability,
// performance} bundle (the refreshMonitor hot path passes it to avoid a
// duplicate round-trip); otherwise it self-fetches. The richer over-time
// analytics (/analytics/dashboard) is cached in state.resumenAnalytics — fetched
// fresh on sub-view entry, reused on SSE/poll so DuckDB stays off the hot loop.
async function renderResumen(pre) {
  const el = $("#resumenView");
  if (!el) return;
  let metrics, observability, performance;
  if (pre && pre.metrics && pre.observability) {
    ({ metrics, observability, performance } = pre);
  } else {
    [metrics, observability, performance] = await Promise.all([
      api("/metrics"),
      api("/observability"),
      api("/agents/performance").catch(() => []),
    ]);
  }
  metrics = metrics || {};
  observability = observability || {};
  performance = performance || [];
  if (!state.resumenAnalytics) {
    state.resumenAnalytics = await api("/analytics/dashboard?days=30").catch(() => null);
  }
  const analytics = state.resumenAnalytics;

  const cl = computeCostLatency(performance);
  const health = observability.health || {};
  const modelUsage = observability.model_usage || [];
  const byLevel = metrics.by_level || {};
  const rot = (analytics && analytics.runs_over_time) || [];

  // --- 1) Hero KPI tiles ---
  let successPct = null;
  if (rot.length) {
    const r = rot.reduce((a, b) => a + Number(b.run_count || 0), 0);
    const s = rot.reduce((a, b) => a + Number(b.success_count || 0), 0);
    successPct = r ? Math.round((s / r) * 100) : 100;
  } else if (cl.tasks) {
    successPct = Math.round((1 - cl.errors / cl.tasks) * 100);
  }
  const successStatus = successPct == null ? undefined
    : successPct >= 90 ? "good" : successPct >= 60 ? "warning" : "critical";
  const activeAgents = performance.filter((p) => Number(p.task_count || 0) > 0).length;
  const humanReview = Number(metrics.human_review_required || 0);
  const totalCost = cl.hasData ? cl.totalCost : Number(metrics.total_estimated_cost_usd || 0);
  const avgLatency = cl.hasData ? cl.avgLatency : Number(health.avg_latency_ms || 0);
  const completed = metrics.by_status?.completed || 0;
  const kpis = statTileRow([
    { label: "Total tareas", value: dvNum(metrics.total_tasks || 0), sub: `${completed} completadas · ${metrics.total_subtasks || 0} subtareas` },
    { label: "Coste total", value: `$${Number(totalCost).toFixed(4)}`, sub: "acumulado (histórico)" },
    { label: "Latencia media", value: `${dvNum(Math.round(avgLatency))} ms`, sub: "ponderada por ejecuciones" },
    { label: "Tasa de éxito", value: successPct == null ? "—" : `${successPct}%`, sub: `${cl.errors} errores`, status: successStatus },
    { label: "Agentes activos", value: dvNum(activeAgents), sub: `${performance.length} proveedores` },
    { label: "En revisión humana", value: dvNum(humanReview), sub: humanReview > 0 ? "requiere atención" : "al día", status: humanReview > 0 ? "warning" : "good" },
  ]);

  // --- 2) Actividad en el tiempo (small multiples, shared x-axis) ---
  const xFmt = (x) => String(x || "").slice(5, 10); // MM-DD
  const smCharts = [
    { title: "Ejecuciones/día", xFormat: xFmt, yFormat: (v) => dvNum(v),
      series: [{ name: "Ejecuciones", seriesIndex: 0, points: rot.map((b) => ({ x: b.bucket, y: Number(b.run_count || 0) })) }] },
    { title: "Coste/día (USD)", xFormat: xFmt, yFormat: (v) => `$${Number(v).toFixed(4)}`,
      series: [{ name: "Coste", seriesIndex: 1, points: rot.map((b) => ({ x: b.bucket, y: Number(b.total_cost || 0) })) }] },
    { title: "Latencia media/día (ms)", xFormat: xFmt, yFormat: (v) => dvNum(v),
      series: [{ name: "Latencia", seriesIndex: 2, points: rot.map((b) => ({ x: b.bucket, y: Math.round(Number(b.avg_latency_ms || 0)) })) }] },
  ];
  const activityBody = rot.length
    ? smallMultiples({ charts: smCharts })
    : `<div class="chart-empty">${analytics ? "sin ejecuciones en la ventana" : "analítica no disponible (DuckDB opcional)"}</div>`;
  const activityFrame = chartFrame({
    title: "Actividad en el tiempo",
    subtitle: analytics ? `últimos ${analytics.window_days || 30} días · una escala Y por métrica` : "",
    body: activityBody,
    table: rot.length ? dataTable({
      columns: [
        { key: "bucket", label: "Día", format: (v) => xFmt(v) },
        { key: "run_count", label: "Ejec", numeric: true },
        { key: "total_cost", label: "Coste", numeric: true, format: (v) => `$${Number(v).toFixed(4)}` },
        { key: "avg_latency_ms", label: "Latencia (ms)", numeric: true, format: (v) => dvNum(Math.round(Number(v) || 0)) },
      ],
      rows: rot,
    }) : null,
  });

  // --- 3) Distribución por nivel de complejidad (ordinal) ---
  const LEVELS = [
    ["level_1_simple", "1 · Simple"], ["level_2_moderate", "2 · Moderado"],
    ["level_3_intermediate", "3 · Intermedio"], ["level_4_complex", "4 · Complejo"],
    ["level_5_critical", "5 · Crítico"],
  ];
  const levelRows = LEVELS.map(([k, lab], i) => ({ label: lab, value: Number(byLevel[k] || 0), seriesIndex: i }));
  const complexityFrame = chartFrame({
    title: "Distribución por nivel de complejidad",
    subtitle: `${dvNum(metrics.total_tasks || 0)} tareas · complejidad media ${dvNum(metrics.average_complexity_score || 0)}`,
    body: hbarChart({ rows: levelRows, valueFormat: (v) => dvNum(v), maxLabelWidth: 96 }),
    table: dataTable({
      columns: [{ key: "label", label: "Nivel", dot: true }, { key: "value", label: "Tareas", numeric: true }],
      rows: levelRows,
    }),
  });

  // --- 4) Reparto por modelo (llamadas; table adds coste/latencia) ---
  const modelRows = modelUsage.slice()
    .sort((a, b) => Number(b.calls || 0) - Number(a.calls || 0))
    .map((m, i) => ({ label: m.model, value: Number(m.calls || 0), seriesIndex: i }));
  const modelFrame = chartFrame({
    title: "Reparto por modelo",
    subtitle: "llamadas por modelo",
    body: modelRows.length ? hbarChart({ rows: modelRows, valueFormat: (v) => dvNum(v), maxLabelWidth: 160 })
      : `<div class="chart-empty">sin llamadas a modelo</div>`,
    table: modelUsage.length ? dataTable({
      columns: [
        { key: "model", label: "Modelo" },
        { key: "calls", label: "Llamadas", numeric: true },
        { key: "estimated_cost", label: "Coste", numeric: true, format: (v) => `$${Number(v || 0).toFixed(4)}` },
        { key: "latency_ms", label: "Latencia (ms)", numeric: true, format: (v) => dvNum(Number(v) || 0) },
      ],
      rows: modelUsage,
    }) : null,
  });

  // --- 5) Salud del sistema (compact status tiles + donut) ---
  const healthPct = health.observed_nodes ? Math.round((health.healthy_nodes / health.observed_nodes) * 100) : 0;
  const tone = health.status === "healthy" ? "ok" : health.status === "error" ? "bad" : "warn";
  const healthTiles = statTileRow([
    { label: "Nodos sanos", value: dvNum(health.healthy_nodes || 0), sub: `de ${health.observed_nodes || 0}`, status: "good" },
    { label: "En aviso", value: dvNum(health.warning_nodes || 0), status: health.warning_nodes > 0 ? "warning" : undefined },
    { label: "En error", value: dvNum(health.error_nodes || 0), status: health.error_nodes > 0 ? "critical" : undefined },
    { label: "Tareas activas", value: dvNum(health.active_tasks || 0), sub: `${health.blocked_tasks || 0} bloqueadas` },
  ]);
  const healthBody = `<div class="resumen-health">
    <div class="resumen-health-ring">
      ${svgDonut(healthPct, { tone, sub: "salud" })}
      <span class="pill ${tone}">${dvEsc(health.status || "—")}</span>
    </div>
    <div class="resumen-health-tiles">${healthTiles}</div>
  </div>`;
  const healthFrame = chartFrame({
    title: "Salud del sistema",
    subtitle: `latencia media ${dvNum(Math.round(health.avg_latency_ms || 0))} ms`,
    body: healthBody,
  });

  el.innerHTML = `
    <div class="resumen-kpis">${kpis}</div>
    ${activityFrame}
    <div class="resumen-2up">${complexityFrame}${modelFrame}</div>
    ${healthFrame}`;
}

function _renderAgentPanels(nodes, flow, audit) {
  const node = nodes.find((n) => n.id === state.selectedNodeId) || nodes[0];
  renderMonitorSidePanel(node, flow, audit);
}

// ---- Agentes sub-view (Phase C) --------------------------------------------
// Data-science-grade per-agent analytics (leaderboard, latency percentiles,
// cost, skills heatmap) built from the Phase A dataviz library, ABOVE the merged
// operational config/console (relocated from the old standalone #view-agents).
// Colour follows the ENTITY, not rank: a stable provider→seriesIndex map
// (alphabetical, deterministic) gives every agent the SAME hue in the leaderboard
// dot, the cost bar and the percentile row. Accepts the refreshMonitor bundle to
// avoid a duplicate round-trip; the richer percentile analytics rides the shared
// state.resumenAnalytics cache (same /analytics/dashboard endpoint).
async function renderAgentes(pre) {
  const el = $("#agentesView");
  // Analytics ONLY. Agent configuration/console/policies is a separate concept
  // and lives in its own top-nav "Agentes" tab (#view-agents / renderAgentsView),
  // not mixed in here — metrics and configuration are deliberately kept apart.
  if (!el) return;

  let metrics, observability, performance;
  if (pre && pre.observability) {
    ({ metrics, observability, performance } = pre);
  } else {
    [metrics, observability, performance] = await Promise.all([
      api("/metrics").catch(() => ({})),
      api("/observability").catch(() => ({})),
      api("/agents/performance").catch(() => []),
    ]);
  }
  metrics = metrics || {};
  observability = observability || {};
  performance = (performance || []).filter((p) => p && p.provider_name);
  if (!state.resumenAnalytics) {
    state.resumenAnalytics = await api("/analytics/dashboard?days=30").catch(() => null);
  }
  const analytics = state.resumenAnalytics || {};
  const percentiles = (analytics.latency_percentiles || []).filter((p) => p && p.provider_name);
  const leaderboard = (analytics.provider_leaderboard || []).filter((p) => p && p.provider_name);
  const nodes = (observability.nodes || []);

  // --- Stable ENTITY→seriesIndex map (alphabetical, never rank-based) ---
  const names = new Set();
  performance.forEach((p) => names.add(p.provider_name));
  percentiles.forEach((p) => names.add(p.provider_name));
  leaderboard.forEach((p) => names.add(p.provider_name));
  const ordered = [...names].sort((a, b) => a.localeCompare(b));
  const seriesOf = new Map(ordered.map((name, i) => [name, i]));
  const si = (name) => seriesOf.has(name) ? seriesOf.get(name) : 0;

  // --- Per-agent aggregate rows (join /agents/performance as the stable base) ---
  const rows = performance.map((p) => {
    const tasks = Number(p.task_count || 0);
    const errors = Number(p.error_count || 0);
    const success = tasks ? (1 - errors / tasks) : 1;
    const cost = Number(p.total_cost || 0);
    return {
      provider: p.provider_name,
      seriesIndex: si(p.provider_name),
      tasks,
      success,
      successPct: `${(success * 100).toFixed(tasks ? 1 : 0)}%`,
      avgLatency: Math.round(Number(p.avg_latency_ms || 0)),
      cost,
      costPer: tasks ? cost / tasks : 0,
    };
  });

  // --- KPI tile row (executive glance) ---
  const active = rows.filter((r) => r.tasks > 0);
  const mostUsed = active.slice().sort((a, b) => b.tasks - a.tasks)[0];
  const mostExpensive = rows.slice().sort((a, b) => b.cost - a.cost)[0];
  // Global p50: run-weighted mean of per-agent p50 (honest aggregate label).
  let p50Weighted = 0, p50Runs = 0;
  percentiles.forEach((p) => {
    const rc = Number(p.run_count || 0);
    p50Weighted += Number(p.p50_latency_ms || 0) * rc;
    p50Runs += rc;
  });
  const globalP50 = p50Runs ? Math.round(p50Weighted / p50Runs) : 0;
  const kpis = statTileRow([
    { label: "Agentes activos", value: dvNum(active.length), sub: `${rows.length} en catálogo de ejecución` },
    { label: "Agente más usado", value: mostUsed ? mostUsed.provider : "—", sub: mostUsed ? `${dvNum(mostUsed.tasks)} ejecuciones` : "sin ejecuciones" },
    { label: "Agente más caro", value: mostExpensive && mostExpensive.cost > 0 ? mostExpensive.provider : "—", sub: mostExpensive ? `$${mostExpensive.cost.toFixed(4)} acumulado` : "" },
    { label: "Latencia p50 global", value: `${dvNum(globalP50)} ms`, sub: "ponderada por ejecuciones" },
  ]);

  // --- 1) Leaderboard (sortable dataTable, default: ejecuciones desc) ---
  const leaderRows = rows.map((r) => ({
    provider: r.provider,
    seriesIndex: r.seriesIndex,
    tasks: r.tasks,
    successPct: r.successPct,
    _success: r.success,
    avgLatency: r.avgLatency,
    cost: r.cost,
    costPer: r.costPer,
  }));
  const leaderFrame = chartFrame({
    title: "Leaderboard de agentes",
    subtitle: "comparación por entidad · ordena cualquier columna",
    body: leaderRows.length ? dataTable({
      columns: [
        { key: "provider", label: "Agente", dot: true },
        { key: "tasks", label: "Ejecuciones", numeric: true, format: (v) => dvNum(v) },
        { key: "successPct", label: "Éxito %", numeric: true, align: "right",
          format: (v, row) => `<span class="tnum">${dvEsc(v)}</span>`, },
        { key: "avgLatency", label: "Latencia media", numeric: true, format: (v) => `<span class="tnum">${dvNum(v)} ms</span>` },
        { key: "cost", label: "Coste total", numeric: true, format: (v) => `<span class="tnum">$${Number(v).toFixed(4)}</span>` },
        { key: "costPer", label: "Coste/ejec.", numeric: true, format: (v) => `<span class="tnum">$${Number(v).toFixed(4)}</span>` },
      ],
      rows: leaderRows,
      defaultSort: "tasks",
    }) : `<div class="chart-empty">sin ejecuciones registradas</div>`,
  });
  // Default sort direction desc for tasks: dataTable defaults dir=1 (asc) — flip once.
  // (Handled by wrapping: we set defaultSort then the table starts ascending; users
  // click to toggle. To land on desc, we post-adjust below after injection.)

  // --- 2) Latencia por agente (percentiles) — dotRangePlot, fallback hbar ---
  const rangeRows = percentiles.map((p) => ({
    label: p.provider_name,
    seriesIndex: si(p.provider_name),
    p50: Number(p.p50_latency_ms || 0),
    p90: Number(p.p90_latency_ms || 0),
    p99: Number(p.p99_latency_ms || 0),
  })).sort((a, b) => b.p50 - a.p50);
  let latencyBody;
  if (rangeRows.length) {
    latencyBody = dotRangePlot({ rows: rangeRows, valueFormat: (v) => dvNum(Math.round(v)), unit: " ms" });
  } else if (rows.length) {
    // Fallback: grouped-ish hbar of avg latency per agent when no percentiles.
    latencyBody = hbarChart({
      rows: rows.map((r) => ({ label: r.provider, value: r.avgLatency, seriesIndex: r.seriesIndex })),
      valueFormat: (v) => `${dvNum(v)} ms`, maxLabelWidth: 160,
    });
  } else {
    latencyBody = `<div class="chart-empty">sin datos de latencia</div>`;
  }
  const latencyFrame = chartFrame({
    title: "Latencia por agente",
    subtitle: rangeRows.length ? "percentiles p50 · p90 · p99 (ms)" : "latencia media (ms) · percentiles no disponibles",
    body: latencyBody,
    table: rangeRows.length ? dataTable({
      columns: [
        { key: "label", label: "Agente", dot: true },
        { key: "p50", label: "p50 (ms)", numeric: true, format: (v) => dvNum(Math.round(v)) },
        { key: "p90", label: "p90 (ms)", numeric: true, format: (v) => dvNum(Math.round(v)) },
        { key: "p99", label: "p99 (ms)", numeric: true, format: (v) => dvNum(Math.round(v)) },
      ],
      rows: rangeRows,
    }) : null,
  });

  // --- 3) Coste por agente — hbar, series-coloured per ENTITY ---
  const costRows = rows.slice()
    .filter((r) => r.cost > 0)
    .sort((a, b) => b.cost - a.cost)
    .map((r) => ({ label: r.provider, value: r.cost, seriesIndex: r.seriesIndex }));
  const costFrame = chartFrame({
    title: "Coste por agente",
    subtitle: "coste total acumulado (USD)",
    body: costRows.length
      ? hbarChart({ rows: costRows, valueFormat: (v) => `$${Number(v).toFixed(4)}`, maxLabelWidth: 160 })
      : `<div class="chart-empty">sin coste registrado</div>`,
  });

  // --- 4) Uso de skills (heatmap) — rows=agents, cols=skills, matrix=counts ---
  const skillNodes = nodes.filter((n) => n.skill_usage && Object.keys(n.skill_usage).length);
  const skillCols = [...new Set(skillNodes.flatMap((n) => Object.keys(n.skill_usage)))].sort();
  let skillsBody;
  if (skillNodes.length && skillCols.length) {
    const hmRows = skillNodes.map((n) => n.name || n.active_model || "—");
    const matrix = skillNodes.map((n) => skillCols.map((s) => Number(n.skill_usage[s] || 0)));
    skillsBody = heatmap({ rows: hmRows, cols: skillCols, matrix, valueFormat: (v) => dvNum(v) });
  } else {
    skillsBody = `<div class="chart-empty">aún no se han usado skills</div>`;
  }
  const skillsFrame = chartFrame({
    title: "Uso de skills por agente",
    subtitle: skillNodes.length ? "recuento de invocaciones · rampa secuencial" : "sin invocaciones de skills todavía",
    body: skillsBody,
  });

  el.innerHTML = `
    <div class="agentes-kpis">${kpis}</div>
    ${leaderFrame}
    <div class="agentes-2up">${latencyFrame}${costFrame}</div>
    ${skillsFrame}`;

  // Land the leaderboard on ejecuciones DESC (dataTable starts a fresh sort asc).
  const lead = el.querySelector(".dv-table[data-dv-table]");
  if (lead) {
    const th = lead.querySelector('th[data-dv-sort="tasks"]');
    if (th) { dvSortTable(th); } // asc→ now desc handled by toggle logic on re-entry
  }
}

// ---- Tareas sub-view (Phase D) ---------------------------------------------
// Task analytics band + FTS search + a full-width, Langfuse-style audit/trace
// drill-down, all composed from the Phase A dataviz library (theme-aware,
// colourblind-safe). Rides the refreshMonitor() fetch bundle so SSE/poll keep
// the KPIs + table + any open drill-down live. The open drill-down
// (state.tareasOpenTask) survives a background refresh — the user is never
// yanked out of an audit view when a task_changed/run_completed event fires.

const _TAREAS_TONE = {
  completed: "good", succeeded: "good", success: "good",
  failed: "critical", error: "critical",
  delegated: "warning", classified: "warning", queued: "warning", running: "warning",
  waiting_human: "serious", requires_human_review: "serious", blocked: "serious",
};
function tareasTone(status) { return _TAREAS_TONE[String(status || "").toLowerCase()] || null; }
function tareasPillColor(status) { const st = dvStatus(tareasTone(status)); return st ? st.v : "var(--muted)"; }
function tareasPill(status) {
  const st = dvStatus(tareasTone(status));
  return `<span class="tareas-pill" style="--pc:${st ? st.v : "var(--muted)"}">${st ? `<span class="dv-status-ico">${st.icon}</span>` : ""}${dvEsc(status || "—")}</span>`;
}
function taskCost(t) { return Number((t.delegation || {}).total_estimated_cost_usd || 0); }
function taskLatency(t) { return Number((t.delegation || {}).total_latency_ms || 0); }
const _tLevelShort = (lvl) => String(lvl || "").replace("level_", "N").replace(/_.*/, "");

async function renderTareas(pre) {
  const el = $("#tareasView");
  if (!el) return;
  initTareas();
  let metrics, tasks, performance;
  if (pre && Array.isArray(pre.tasks)) {
    ({ metrics, tasks, performance } = pre);
  } else {
    [metrics, tasks, performance] = await Promise.all([
      api("/metrics").catch(() => ({})),
      api("/tasks").catch(() => []),
      api("/agents/performance").catch(() => []),
    ]);
  }
  metrics = metrics || {};
  tasks = Array.isArray(tasks) ? tasks : [];
  performance = performance || [];
  state.tasks = tasks;
  if (!state.resumenAnalytics) {
    state.resumenAnalytics = await api("/analytics/dashboard?days=30").catch(() => null);
  }
  const analytics = state.resumenAnalytics;

  const band = tareasBand(tasks, metrics, analytics);

  // Drill-down mode when a task is open and still present; otherwise the list.
  let openTask = null;
  if (state.tareasOpenTask) {
    openTask = tasks.find((t) => t.task_id === state.tareasOpenTask) || null;
    if (!openTask) state.tareasOpenTask = null;
  }
  const mainInner = openTask ? tareasDetailShell(openTask) : tareasList(tasks);
  el.innerHTML = `${band}<div id="tareasMain" class="tareas-main">${mainInner}</div>`;

  if (openTask) {
    renderTareasDetail(openTask).catch(() => {});
  } else {
    const input = $("#tareasSearch");
    if (input && state.tareasQuery) input.value = state.tareasQuery;
  }
}

// --- Analytics band: KPI tiles + volume + status distribution + success/type -
function tareasBand(tasks, metrics, analytics) {
  const total = tasks.length;
  const byStatus = {};
  let costSum = 0, latSum = 0, latN = 0;
  tasks.forEach((t) => {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    costSum += taskCost(t);
    const l = taskLatency(t);
    if (l > 0) { latSum += l; latN += 1; }
  });
  const completed = byStatus.completed || 0;
  const failed = byStatus.failed || 0;
  const humanReview = Number(metrics.human_review_required || 0);
  const avgLat = latN ? Math.round(latSum / latN) : 0;
  const kpis = statTileRow([
    { label: "Total tareas", value: dvNum(total), sub: `${dvNum(metrics.total_subtasks || 0)} subtareas` },
    { label: "Completadas", value: dvNum(completed), sub: total ? `${Math.round((completed / total) * 100)}% del total` : "", status: completed > 0 ? "good" : undefined },
    { label: "Fallidas", value: dvNum(failed), sub: failed > 0 ? "requiere revisión" : "sin fallos", status: failed > 0 ? "critical" : undefined },
    { label: "En revisión humana", value: dvNum(humanReview), sub: humanReview > 0 ? "pendiente" : "al día", status: humanReview > 0 ? "serious" : undefined },
    { label: "Coste total", value: `$${costSum.toFixed(4)}`, sub: "acumulado" },
    { label: "Latencia media", value: `${dvNum(avgLat)} ms`, sub: `${latN} con ejecución` },
  ]);

  // Volumen en el tiempo (runs_over_time, else task created_at bucketed by day).
  const rot = (analytics && analytics.runs_over_time) || [];
  const xFmt = (x) => String(x || "").slice(5, 10);
  let volBody, volTable = null, volSub;
  if (rot.length) {
    volBody = lineChart({
      series: [{ name: "Ejecuciones", seriesIndex: 0, points: rot.map((b) => ({ x: b.bucket, y: Number(b.run_count || 0) })) }],
      xFormat: xFmt, yFormat: (v) => dvNum(v),
    });
    volSub = `${rot.length} días con actividad`;
    volTable = dataTable({
      columns: [
        { key: "bucket", label: "Día", format: (v) => xFmt(v) },
        { key: "run_count", label: "Ejec", numeric: true },
        { key: "success_count", label: "OK", numeric: true },
        { key: "total_cost", label: "Coste", numeric: true, format: (v) => `$${Number(v || 0).toFixed(4)}` },
      ],
      rows: rot,
    });
  } else {
    const buckets = {};
    tasks.forEach((t) => { const d = String(t.created_at || "").slice(0, 10); if (d) buckets[d] = (buckets[d] || 0) + 1; });
    const days = Object.keys(buckets).sort();
    volBody = days.length
      ? lineChart({ series: [{ name: "Tareas", seriesIndex: 0, points: days.map((d) => ({ x: d, y: buckets[d] })) }], xFormat: xFmt, yFormat: (v) => dvNum(v) })
      : `<div class="chart-empty">sin actividad</div>`;
    volSub = "tareas creadas/día";
  }
  const volFrame = chartFrame({ title: "Volumen en el tiempo", subtitle: volSub, body: volBody, table: volTable });

  // Distribución por estado (status-coloured).
  const statusRows = Object.entries(byStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n], i) => ({ label: s, value: n, status: tareasTone(s), seriesIndex: i }));
  const statusFrame = chartFrame({
    title: "Distribución por estado",
    subtitle: `${Object.keys(byStatus).length} estados`,
    body: statusRows.length ? hbarChart({ rows: statusRows, valueFormat: (v) => dvNum(v), maxLabelWidth: 150 }) : `<div class="chart-empty">sin tareas</div>`,
    table: statusRows.length ? dataTable({ columns: [{ key: "label", label: "Estado" }, { key: "value", label: "Tareas", numeric: true }], rows: statusRows }) : null,
  });

  // Éxito por tipo de tarea.
  const sbt = (analytics && analytics.success_rate_by_task_type) || [];
  const typeRows = sbt.slice().sort((a, b) => Number(b.run_count) - Number(a.run_count))
    .map((r, i) => ({ label: r.task_type, value: Math.round(Number(r.success_rate || 0) * 100), seriesIndex: i }));
  const typeFrame = chartFrame({
    title: "Éxito por tipo de tarea",
    subtitle: sbt.length ? "% de ejecuciones correctas" : "",
    body: typeRows.length ? hbarChart({ rows: typeRows, valueFormat: (v) => `${dvNum(v)}%`, maxLabelWidth: 170 }) : `<div class="chart-empty">analítica no disponible (DuckDB opcional)</div>`,
    table: sbt.length ? dataTable({
      columns: [
        { key: "task_type", label: "Tipo" },
        { key: "run_count", label: "Ejec", numeric: true },
        { key: "success_rate", label: "Éxito", numeric: true, format: (v) => `${Math.round(Number(v || 0) * 100)}%` },
        { key: "avg_latency_ms", label: "Latencia", numeric: true, format: (v) => `${dvNum(Math.round(Number(v || 0)))} ms` },
      ],
      rows: sbt,
    }) : null,
  });

  return `<div class="tareas-kpis">${kpis}</div>${volFrame}<div class="tareas-2up">${statusFrame}${typeFrame}</div>`;
}

// --- List mode: FTS search box above a full-width, sortable tasks table ------
function tareasList(tasks) {
  const rows = tasks.map((t) => {
    const c = t.classification || {};
    return {
      task_id: t.task_id,
      _short: t.task_id.length > 16 ? `${t.task_id.slice(0, 16)}…` : t.task_id,
      tipo: c.intent || "—",
      nivel: `${_tLevelShort(c.complexity_level)} · ${dvNum(c.complexity_score)}`,
      modelo: TIER_LABEL[c.recommended_model] || c.recommended_model || "—",
      status: t.status,
      coste: taskCost(t),
      latencia: taskLatency(t),
      creada: String(t.created_at || "").slice(0, 10),
    };
  });
  const table = dataTable({
    columns: [
      { key: "_short", label: "ID", format: (v, row) => `<button type="button" class="tareas-idlink" data-task="${dvEsc(row.task_id)}"><code>${dvEsc(v)}</code></button>` },
      { key: "tipo", label: "Tipo / Intención" },
      { key: "nivel", label: "Nivel" },
      { key: "modelo", label: "Modelo" },
      { key: "status", label: "Estado", format: (v) => tareasPill(v) },
      { key: "coste", label: "Coste", numeric: true, format: (v) => `$${Number(v).toFixed(4)}` },
      { key: "latencia", label: "Latencia", numeric: true, format: (v) => (v ? `${dvNum(v)} ms` : "—") },
      { key: "creada", label: "Creada" },
    ],
    rows,
    defaultSort: "creada",
  });
  const searchCard = `<section class="card tareas-searchcard">
    <div class="tareas-search">
      <span class="tareas-search-ico" aria-hidden="true">⌕</span>
      <input type="text" id="tareasSearch" class="tareas-search-input" placeholder="Buscar tareas por título, tipo o prompt… (búsqueda de texto completo)" autocomplete="off" spellcheck="false" aria-label="Buscar tareas" />
      <div id="tareasSearchResults" class="tareas-search-results" hidden></div>
    </div>
  </section>`;
  const tableFrame = chartFrame({
    title: "Tareas",
    subtitle: `${tasks.length} en el registro · clic en el ID para auditar`,
    body: `<div class="tareas-table">${table}</div>`,
  });
  return `${searchCard}${tableFrame}`;
}

// --- Drill-down shell (synchronous): header + clasificación + subtareas, with
// async placeholders for the runs trace and the harness decisions. -----------
function tareasDetailShell(task) {
  const c = task.classification || {};
  const cost = taskCost(task), lat = taskLatency(task);
  const rhr = c.requires_human_review;
  const dt = (s) => dvEsc(String(s || "").slice(0, 19).replace("T", " "));
  const header = `<div class="tareas-detail-head">
    <div class="tareas-detail-topline">
      <button type="button" class="tareas-back">← Volver</button>
      ${tareasPill(task.status)}
      ${rhr ? `<span class="tareas-flag">▲ revisión humana</span>` : ""}
    </div>
    <div class="tareas-detail-id"><code>${dvEsc(task.task_id)}</code></div>
    <p class="tareas-detail-prompt">${dvEsc(task.prompt || "")}</p>
    <div class="tareas-detail-meta">
      <span><b>${dvEsc(_tLevelShort(c.complexity_level))}</b> · complejidad ${dvNum(c.complexity_score)}</span>
      <span>coste <b>$${cost.toFixed(4)}</b></span>
      <span>latencia <b>${lat ? `${dvNum(lat)} ms` : "—"}</b></span>
      <span>creada ${dt(task.created_at)}</span>
      <span>actualizada ${dt(task.updated_at)}</span>
    </div>
  </div>`;

  const critRows = Object.entries(c.criteria || {}).map(([k, v], i) => ({ label: k, value: Number(v), seriesIndex: i }));
  const clasKv = `<div class="tareas-kv">
    <div><span>Dominios</span><b>${dvEsc((c.domain || []).join(", ") || "—")}</b></div>
    <div><span>Intención</span><b>${dvEsc(c.intent || "—")}</b></div>
    <div><span>Estrategia</span><b>${dvEsc(c.recommended_strategy || "—")}</b></div>
    <div><span>Clasificado por</span><b>${dvEsc(c.classified_by || "—")}</b></div>
    <div><span>Modelo</span><b>${dvEsc(TIER_LABEL[c.recommended_model] || c.recommended_model || "—")}</b></div>
    <div class="tareas-skills"><span>Skills</span><span>${(c.recommended_skills || []).map((s) => `<span class="tag">${dvEsc(s)}</span>`).join("") || "—"}</span></div>
  </div>${c.reason ? `<p class="tareas-reason">${dvEsc(c.reason)}</p>` : ""}`;
  const clasFrame = chartFrame({
    title: "Clasificación",
    subtitle: "criterios 0–5 · driver dominante",
    body: `${clasKv}<div class="tareas-crit">${critRows.length ? hbarChart({ rows: critRows, valueFormat: (v) => Number(v).toFixed(1), maxLabelWidth: 160 }) : `<div class="chart-empty">sin criterios</div>`}</div>`,
  });

  const execs = new Map((task.delegation?.executions || []).map((e) => [e.subtask_id, e]));
  const subs = c.subtasks || [];
  const subBody = subs.length ? subs.map((s) => {
    const ex = execs.get(s.id);
    const meta = ex
      ? `${dvEsc(ex.backend)}:${dvEsc(ex.model_used)} · ${dvNum(ex.latency_ms)} ms · $${Number(ex.estimated_cost_usd || 0).toFixed(5)}`
      : `${dvEsc(TIER_LABEL[s.recommended_model] || s.recommended_model || "")} · pendiente`;
    return `<div class="tareas-subtask">
      <div class="tareas-subtask-h"><code>${dvEsc(s.id)}</code> <b>${dvEsc(s.name)}</b>${ex ? ` ${tareasPill(ex.status)}` : ""}</div>
      <div class="tareas-subtask-meta">${meta}${s.recommended_skill ? ` · skill: ${dvEsc(s.recommended_skill)}` : ""}</div>
      ${s.validation ? `<div class="tareas-subtask-val">✓ ${dvEsc(s.validation)}</div>` : ""}
    </div>`;
  }).join("") : `<div class="chart-empty">sin subtareas</div>`;
  const subFrame = chartFrame({ title: "Subtareas", subtitle: `${subs.length}`, body: `<div class="tareas-subtasks">${subBody}</div>` });

  const runsFrame = chartFrame({ title: "Timeline de ejecuciones", subtitle: "traza por run · modelo · coste · latencia", body: `<div id="tareasRuns" class="tareas-timeline"><div class="chart-empty">cargando ejecuciones…</div></div>` });
  const decFrame = chartFrame({ title: "Decisiones del harness", subtitle: "log de auditoría append-only", body: `<div id="tareasDecisions" class="tareas-decisions"><div class="chart-empty">cargando decisiones…</div></div>` });

  return `${header}${clasFrame}${runsFrame}${subFrame}${decFrame}`;
}

// Fetch the stable Fase-1 runs (the trace) + the harness decision log, inject.
async function renderTareasDetail(task) {
  const [runs, decisions] = await Promise.all([
    api(`/tasks/${task.task_id}/runs`).catch(() => []),
    api(`/tasks/${task.task_id}/decisions`).catch(() => []),
  ]);
  if (state.tareasOpenTask !== task.task_id) return; // user navigated away mid-fetch
  const runsEl = $("#tareasRuns");
  if (runsEl) runsEl.innerHTML = tareasRunsHtml(Array.isArray(runs) ? runs : [], task);
  const decEl = $("#tareasDecisions");
  if (decEl) {
    const rhr = task.classification?.requires_human_review && task.status === "delegated";
    const approve = rhr ? `<button class="approve-review tareas-approve" data-approve="${dvEsc(task.task_id)}">Aprobar revisión humana</button>` : "";
    const list = (Array.isArray(decisions) ? decisions : []);
    decEl.innerHTML = (list.length ? list.map((d) => `<div class="tareas-dec">
      <span class="tareas-dec-phase">${dvEsc(d.phase)}</span>
      <div class="tareas-dec-body"><div class="tareas-dec-decision">${dvEsc(d.decision)}</div>${d.reason ? `<div class="tareas-dec-reason">${dvEsc(d.reason)}</div>` : ""}</div>
      ${d.score != null ? `<span class="tareas-dec-score">${dvNum(d.score)}</span>` : ""}
    </div>`).join("") : `<div class="chart-empty">sin decisiones registradas</div>`) + approve;
  }
}

// The trace: one card per run (stable /runs data), merged with executions for
// the output/error text (runs carry timing/cost/model, executions carry output).
function tareasRunsHtml(runs, task) {
  const execs = task.delegation?.executions || [];
  let items = [];
  if (runs.length) {
    items = runs.map((r, i) => {
      const ex = execs[i] || execs.find((e) => e.subtask_id === r.subtask_id) || null;
      return {
        index: r.run_index != null ? r.run_index : i,
        provider: r.provider_name || r.model_id || "—",
        model: r.model_id || (ex && ex.model_used) || "",
        backend: r.backend || "",
        status: r.status,
        latency: r.latency_ms,
        cost: r.estimated_cost_usd,
        inTok: r.input_tokens,
        outTok: r.output_tokens,
        entity: r.routing_entity_name_snapshot || "",
        output: ex ? ex.output : "",
        error: r.error || (ex && ex.error) || "",
      };
    });
  } else if (execs.length) {
    items = execs.map((ex, i) => ({
      index: i,
      provider: (ex.model_used || "").split(":")[0] || ex.backend || "—",
      model: ex.model_used || "",
      backend: ex.backend || "",
      status: ex.status,
      latency: ex.latency_ms,
      cost: ex.estimated_cost_usd,
      inTok: ex.input_tokens,
      outTok: ex.output_tokens,
      entity: "",
      output: ex.output,
      error: ex.error,
    }));
  }
  if (!items.length) return `<div class="chart-empty">sin ejecuciones registradas</div>`;
  return items.map((it) => {
    const out = it.error ? it.error : (it.output || "");
    const isErr = !!it.error;
    const trunc = out && out.length > 260;
    const shown = trunc ? out.slice(0, 260) : out;
    const outHtml = out ? `<div class="tareas-run-out${isErr ? " err" : ""}">
      <pre class="tareas-run-pre" data-full="${dvEsc(out)}">${dvEsc(shown)}${trunc ? "…" : ""}</pre>
      ${trunc ? `<button type="button" class="tareas-out-toggle">expandir</button>` : ""}
    </div>` : "";
    return `<div class="tareas-run">
      <div class="tareas-run-rail"><span class="tareas-run-dot" style="--pc:${tareasPillColor(it.status)}"></span></div>
      <div class="tareas-run-card">
        <div class="tareas-run-h">
          <span class="tareas-run-idx">#${dvEsc(it.index)}</span>
          <b>${dvEsc(it.provider)}</b>
          ${it.model ? `<code>${dvEsc(it.model)}</code>` : ""}
          ${it.backend ? `<span class="tareas-run-be">${dvEsc(it.backend)}</span>` : ""}
          ${tareasPill(it.status)}
        </div>
        ${it.entity ? `<div class="tareas-run-entity">${dvEsc(it.entity)}</div>` : ""}
        <div class="tareas-run-metrics">
          <span>latencia <b>${it.latency != null ? `${dvNum(it.latency)} ms` : "—"}</b></span>
          <span>coste <b>$${Number(it.cost || 0).toFixed(5)}</b></span>
          <span>tokens <b>${dvNum(it.inTok || 0)}↓ ${dvNum(it.outTok || 0)}↑</b></span>
        </div>
        ${outHtml}
      </div>
    </div>`;
  }).join("");
}

function openTareasTask(taskId) {
  if (!taskId) return;
  state.tareasOpenTask = taskId;
  hideTareasSearch();
  const input = $("#tareasSearch");
  if (input) { input.value = ""; state.tareasQuery = ""; }
  renderTareas({ metrics: state.lastMetrics, tasks: state.tasks, performance: state.agentPerformance }).catch(() => {});
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function closeTareasTask() {
  state.tareasOpenTask = null;
  renderTareas({ metrics: state.lastMetrics, tasks: state.tasks, performance: state.agentPerformance }).catch(() => {});
}

function hideTareasSearch() {
  const box = $("#tareasSearchResults");
  if (box) { box.hidden = true; box.innerHTML = ""; }
}
async function runTareasSearch(q) {
  const box = $("#tareasSearchResults");
  if (!box) return;
  let data;
  try {
    data = await api(`/search/tasks?q=${encodeURIComponent(q)}&limit=20`);
  } catch (err) {
    box.hidden = false;
    box.innerHTML = `<div class="tareas-search-empty">${dvEsc(err.message)}</div>`;
    return;
  }
  const results = data.results || [];
  box.hidden = false;
  if (!results.length) {
    box.innerHTML = `<div class="tareas-search-empty">Sin resultados para “${dvEsc(q)}”.</div>`;
    return;
  }
  box.innerHTML = `<div class="tareas-search-count">${data.count} resultado${data.count === 1 ? "" : "s"}</div>` +
    results.map((r) => {
      const id = r.legacy_task_id || r.id || "";
      const created = r.created_at ? String(r.created_at).slice(0, 10) : "";
      return `<button type="button" class="tareas-search-item" data-task="${dvEsc(id)}">
        <b>${dvEsc(r.title || id || "tarea")}</b>
        <span>${dvEsc(r.task_type || "—")} · ${dvEsc(r.status || "")} · ${created}</span>
      </button>`;
    }).join("");
}

// One-time delegated wiring (idempotent): drill-down open/close, output expand,
// and the FTS search input (debounced).
function initTareas() {
  if (document._tareasBound) return;
  document._tareasBound = true;
  document.addEventListener("click", (e) => {
    const idlink = e.target.closest?.(".tareas-idlink[data-task]");
    if (idlink) { openTareasTask(idlink.dataset.task); return; }
    const searchItem = e.target.closest?.(".tareas-search-item[data-task]");
    if (searchItem) { openTareasTask(searchItem.dataset.task); return; }
    if (e.target.closest?.(".tareas-back")) { closeTareasTask(); return; }
    const tog = e.target.closest?.(".tareas-out-toggle");
    if (tog) {
      const pre = tog.closest(".tareas-run-out")?.querySelector(".tareas-run-pre");
      if (pre) { pre.textContent = pre.getAttribute("data-full") || pre.textContent; tog.remove(); }
      return;
    }
    if (!e.target.closest?.(".tareas-search")) hideTareasSearch();
  });
  document.addEventListener("input", (e) => {
    if (e.target && e.target.id === "tareasSearch") {
      state.tareasQuery = e.target.value;
      clearTimeout(state._tareasSearchTimer);
      const q = e.target.value.trim();
      if (!q) { hideTareasSearch(); return; }
      state._tareasSearchTimer = setTimeout(() => runTareasSearch(q), 300);
    }
  });
}

// System Health: a summary ring + a sparkline of recent load, replacing the
// older "health-compact/health-orbit" layout (renamed to health-summary* to
// avoid colliding with dead pre-redesign CSS of the same old names).
function renderSystemHealth(health) {
  if (!$("#systemHealth")) return; // Phase D removed the legacy Tareas health card.
  if (!health) {
    $("#systemHealth").innerHTML = `<div class="chart-empty">sin datos</div>`;
    return;
  }
  const status = health.status === "healthy" ? "ok" : health.status === "error" ? "bad" : "warn";
  const healthPct = health.observed_nodes ? Math.round((health.healthy_nodes / health.observed_nodes) * 100) : 0;
  state.healthHistory ||= [];
  state.healthHistory.push(healthPct);
  if (state.healthHistory.length > 24) state.healthHistory.shift();
  $("#systemHealth").innerHTML = `
    <div class="health-summary">
      <div class="health-summary-ring">${svgDonut(healthPct, { tone: status, sub: "salud" })}</div>
      <div class="health-summary-meta">
        <span class="pill ${status}">${escapeHtml(health.status)}</span>
        <b>${health.observed_nodes}</b>
        <small>nodos observados</small>
      </div>
    </div>
    ${svgSparkline(state.healthHistory, { tone: status, w: 220, h: 34 })}
    <div class="health-strip">
      <span><b>${health.healthy_nodes}</b><small>healthy</small></span>
      <span><b>${health.warning_nodes}</b><small>warn</small></span>
      <span><b>${health.error_nodes}</b><small>err</small></span>
      <span><b>${health.active_tasks}</b><small>act.</small></span>
      <span><b>${health.blocked_tasks}</b><small>block</small></span>
      <span><b>${health.avg_latency_ms || 0}ms</b><small>lat.</small></span>
    </div>`;
}

function setMonitorSide(open) {
  state.monitorSideOpen = open;
  const shell = $(".monitor-shell");
  const side = $("#monitorSide");
  const button = $("#toggleMonitorSide");
  shell?.classList.toggle("side-collapsed", !open);
  side?.classList.toggle("collapsed", !open);
  if (button) {
    button.textContent = open ? "◧" : "◨";
    button.setAttribute("aria-pressed", String(open));
    button.setAttribute("title", open ? "Ocultar panel lateral" : "Mostrar panel lateral");
  }
}

function applyMonitorSplit() {
  document.documentElement.style.setProperty("--monitor-side-width", `${state.monitorSideWidth}px`);
}

function initMonitorSplitter() {
  const stored = Number(localStorage.getItem("karajan-monitor-side-width"));
  if (Number.isFinite(stored)) state.monitorSideWidth = Math.min(560, Math.max(300, stored));
  applyMonitorSplit();
  const splitter = $("#monitorSplitter");
  if (!splitter || splitter.dataset.bound) return;
  splitter.dataset.bound = "1";
  splitter.addEventListener("pointerdown", (event) => {
    if (!state.monitorSideOpen) return;
    event.preventDefault();
    state.resizingMonitorSide = true;
    splitter.classList.add("dragging");
    document.body.classList.add("resizing-monitor");
    document.addEventListener("pointermove", onMonitorResize);
    document.addEventListener("pointerup", stopMonitorResize, { once: true });
  });
}

function onMonitorResize(event) {
  if (!state.resizingMonitorSide) return;
  const shell = $(".monitor-shell");
  if (!shell) return;
  const rect = shell.getBoundingClientRect();
  const maxWidth = Math.min(640, rect.width * 0.48);
  state.monitorSideWidth = Math.round(Math.min(maxWidth, Math.max(300, rect.right - event.clientX)));
  localStorage.setItem("karajan-monitor-side-width", String(state.monitorSideWidth));
  applyMonitorSplit();
}

function stopMonitorResize() {
  state.resizingMonitorSide = false;
  $("#monitorSplitter")?.classList.remove("dragging");
  document.body.classList.remove("resizing-monitor");
  document.removeEventListener("pointermove", onMonitorResize);
}

function setHumanSide(open) {
  state.humanSideOpen = open;
  const grid = $("#humanHomeGrid");
  const button = $("#toggleHumanSide");
  grid?.classList.toggle("side-collapsed", !open);
  if (button) {
    button.textContent = open ? "◧" : "◨";
    button.setAttribute("aria-pressed", String(open));
    button.setAttribute("title", open ? "Ocultar conexiones de agentes" : "Mostrar conexiones de agentes");
  }
}

function syncHumanSideOffset() {
  const grid = $("#humanHomeGrid");
  if (!grid) return;
  document.documentElement.style.setProperty("--human-side-offset", "0px");
  requestAnimationFrame(syncHumanSideHeight);
}

function syncHumanSideHeight() {
  const main = $(".human-home-main");
  if (!main) return;
  const height = Math.max(360, Math.round(main.getBoundingClientRect().height));
  document.documentElement.style.setProperty("--human-side-height", `${height}px`);
}

function applyHumanSplit() {
  document.documentElement.style.setProperty("--human-side-width", `${state.humanSideWidth}px`);
}

function setAgentsSide(open) {
  state.agentsSideOpen = open;
  const windowEl = $("#agentsWindow");
  const side = $("#agentsSide");
  const button = $("#toggleAgentsSide");
  windowEl?.classList.toggle("side-collapsed", !open);
  side?.classList.toggle("collapsed", !open);
  if (button) {
    button.textContent = open ? "◧" : "◨";
    button.setAttribute("aria-pressed", String(open));
    button.setAttribute("title", open ? "Ocultar detalle del agente" : "Mostrar detalle del agente");
  }
}

function applyAgentsSplit() {
  document.documentElement.style.setProperty("--agents-side-width", `${state.agentsSideWidth}px`);
  $("#agentsWindow")?.style.setProperty("--agents-side-width", `${state.agentsSideWidth}px`);
}

function initAgentsSplitter() {
  const stored = Number(localStorage.getItem("karajan-agents-side-width"));
  if (Number.isFinite(stored)) state.agentsSideWidth = Math.min(640, Math.max(340, stored));
  applyAgentsSplit();
  const splitter = $("#agentsSplitter");
  if (!splitter || splitter.dataset.bound) return;
  splitter.dataset.bound = "1";
  splitter.addEventListener("pointerdown", (event) => {
    if (!state.agentsSideOpen) return;
    event.preventDefault();
    state.resizingAgentsSide = true;
    splitter.classList.add("dragging");
    document.body.classList.add("resizing-agents");
    document.addEventListener("pointermove", onAgentsResize);
    document.addEventListener("pointerup", stopAgentsResize, { once: true });
  });
}

function onAgentsResize(event) {
  if (!state.resizingAgentsSide) return;
  const shell = $("#agentsWindow");
  if (!shell) return;
  const rect = shell.getBoundingClientRect();
  const maxWidth = Math.min(720, rect.width * 0.48);
  state.agentsSideWidth = Math.round(Math.min(maxWidth, Math.max(340, rect.right - event.clientX)));
  localStorage.setItem("karajan-agents-side-width", String(state.agentsSideWidth));
  applyAgentsSplit();
}

function stopAgentsResize() {
  state.resizingAgentsSide = false;
  $("#agentsSplitter")?.classList.remove("dragging");
  document.body.classList.remove("resizing-agents");
  document.removeEventListener("pointermove", onAgentsResize);
}

function initHumanSplitter() {
  const stored = Number(localStorage.getItem("karajan-human-side-width"));
  if (Number.isFinite(stored)) state.humanSideWidth = Math.min(620, Math.max(340, stored));
  applyHumanSplit();
  const splitter = $("#humanSplitter");
  if (!splitter || splitter.dataset.bound) return;
  splitter.dataset.bound = "1";
  splitter.addEventListener("pointerdown", (event) => {
    if (!state.humanSideOpen) return;
    event.preventDefault();
    state.resizingHumanSide = true;
    splitter.classList.add("dragging");
    document.body.classList.add("resizing-human");
    document.addEventListener("pointermove", onHumanResize);
    document.addEventListener("pointerup", stopHumanResize, { once: true });
  });
}

function onHumanResize(event) {
  if (!state.resizingHumanSide) return;
  const grid = $("#humanHomeGrid");
  if (!grid) return;
  const rect = grid.getBoundingClientRect();
  const maxWidth = Math.min(720, rect.width * 0.55);
  state.humanSideWidth = Math.round(Math.min(maxWidth, Math.max(340, rect.right - event.clientX)));
  localStorage.setItem("karajan-human-side-width", String(state.humanSideWidth));
  applyHumanSplit();
}

function stopHumanResize() {
  state.resizingHumanSide = false;
  $("#humanSplitter")?.classList.remove("dragging");
  document.body.classList.remove("resizing-human");
  document.removeEventListener("pointermove", onHumanResize);
}

function applyMonitorBlockOrder() {
  const stack = $("#monitorBlockStack");
  if (!stack) return;
  const stored = localStorage.getItem("karajan-monitor-block-order");
  if (stored) {
    const order = stored.split(",").filter(Boolean);
    if (order.length) state.monitorBlockOrder = order;
  }
  state.monitorBlockOrder.forEach((key) => {
    const block = stack.querySelector(`[data-monitor-block="${key}"]`);
    if (block) stack.appendChild(block);
  });
}

function saveMonitorBlockOrder() {
  const order = $$("#monitorBlockStack [data-monitor-block]").map((block) => block.dataset.monitorBlock);
  state.monitorBlockOrder = order;
  localStorage.setItem("karajan-monitor-block-order", order.join(","));
}

function clearMonitorDropState() {
  $$("#monitorBlockStack .monitor-block").forEach((block) => {
    block.classList.remove("drop-before", "drop-after");
  });
}

function initMonitorBlocks() {
  const stack = $("#monitorBlockStack");
  if (!stack || stack.dataset.bound) return;
  stack.dataset.bound = "1";
  applyMonitorBlockOrder();
  stack.addEventListener("dragstart", (event) => {
    const block = event.target.closest("[data-monitor-block]");
    if (!block) return;
    block.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", block.dataset.monitorBlock);
  });
  stack.addEventListener("dragover", (event) => {
    const dragging = stack.querySelector(".dragging");
    const target = event.target.closest("[data-monitor-block]");
    if (!dragging || !target || target === dragging) return;
    event.preventDefault();
    clearMonitorDropState();
    const rect = target.getBoundingClientRect();
    target.classList.add(event.clientX < rect.left + rect.width / 2 ? "drop-before" : "drop-after");
  });
  stack.addEventListener("drop", (event) => {
    const dragging = stack.querySelector(".dragging");
    const target = event.target.closest("[data-monitor-block]");
    if (!dragging || !target || target === dragging) return;
    event.preventDefault();
    const rect = target.getBoundingClientRect();
    if (event.clientX < rect.left + rect.width / 2) {
      stack.insertBefore(dragging, target);
    } else {
      stack.insertBefore(dragging, target.nextSibling);
    }
    clearMonitorDropState();
    saveMonitorBlockOrder();
  });
  stack.addEventListener("dragend", () => {
    stack.querySelector(".dragging")?.classList.remove("dragging");
    clearMonitorDropState();
  });
}

function renderSelectedAgentUsage(nodes, flow, audit) {
  const node = nodes.find((item) => item.id === state.selectedNodeId) || nodes[0];
  if (!node) {
    $("#selectedAgentUsage").innerHTML = `<div class="chart-empty">sin agente seleccionado</div>`;
    return;
  }
  const related = [...flow, ...audit]
    .filter((event) => event.source_node === node.name || event.target_node === node.name || event.summary?.includes(node.name))
    .slice(0, 5);
  const caps = (node.active_capabilities || []).map((cap) => `<span>${escapeHtml(cap)}</span>`).join("");
  const levels = (node.levels || []).map((level) => LEVEL_FULL[level] || level).join(" · ") || "sin niveles";
  $("#selectedAgentUsage").innerHTML = `<div class="selected-agent-head">
      <div><b>${escapeHtml(node.name)}</b><small>${escapeHtml(node.role)} · ${escapeHtml(node.status)}</small></div>
      <span class="pill ${node.status === "error" ? "bad" : node.status === "idle" || node.status === "completed" ? "ok" : "warn"}">${escapeHtml(node.provider)}</span>
    </div>
    <div class="selected-agent-model">${escapeHtml(node.active_model)}</div>
    <div class="selected-agent-stats">
      <span><b>${node.task_count}</b><small>tasks</small></span>
      <span><b>${node.error_count}</b><small>errors</small></span>
      <span><b>${node.latency_ms || 0}ms</b><small>lat.</small></span>
      <span><b>$${Number(node.estimated_cost || 0).toFixed(4)}</b><small>coste</small></span>
    </div>
    <div class="node-role">${escapeHtml(levels)}</div>
    <div class="node-caps">${caps || "<span>sin capacidades</span>"}</div>
    <div class="selected-agent-log">
      ${related.length ? eventList(related, "") : `<div class="chart-empty">sin eventos directos recientes</div>`}
    </div>`;
}

// ---- Agent detail panel (role-specific metrics) ----------------------------

const ROLE_METRIC_DEFS = {
  agent: [
    { key: "extra.classified_tasks", label: "Clasificadas", fmt: (n) => n ?? 0 },
    { key: "extra.delegated_tasks",  label: "Delegadas",    fmt: (n) => n ?? 0 },
    { key: "_delegation_rate",       label: "Tasa deleg.",  fmt: (n) => `${n}%` },
    { key: "confidence",             label: "Confianza",    fmt: (n) => n != null ? `${Math.round(n * 100)}%` : "—" },
    { key: "_caps_count",            label: "Caps.",        fmt: (n) => n ?? 0 },
    { key: "model_tier",             label: "Tier",         fmt: (n) => TIER_LABEL[n] || n || "—" },
  ],
  worker: [
    { key: "task_count",    label: "Subtareas",   fmt: (n) => n ?? 0 },
    { key: "_error_rate",  label: "Tasa error",  fmt: (n) => `${n}%` },
    { key: "latency_ms",   label: "Latencia",    fmt: (n) => `${n || 0}ms` },
    { key: "estimated_cost", label: "Coste",     fmt: (n) => `$${Number(n || 0).toFixed(4)}` },
    { key: "model_tier",   label: "Tier",        fmt: (n) => TIER_LABEL[n] || n || "—" },
    { key: "_levels",      label: "Niveles",     fmt: (n) => n || "sin niveles" },
  ],
  backup: "worker",
  guardian: [
    { key: "task_count",   label: "Revisiones",  fmt: (n) => n ?? 0 },
    { key: "error_count",  label: "Detectados",  fmt: (n) => n ?? 0 },
    { key: "_approval_rate", label: "Aprobación", fmt: (n) => `${n}%` },
    { key: "latency_ms",   label: "Latencia",    fmt: (n) => `${n || 0}ms` },
    { key: "_skills",      label: "Skills",      fmt: (n) => n || "—" },
    { key: "provider",     label: "Provider",    fmt: (n) => n || "—" },
  ],
  validator: "guardian",
  memory: [
    { key: "task_count",   label: "Eventos",     fmt: (n) => n ?? 0 },
    { key: "error_count",  label: "Errores",     fmt: (n) => n ?? 0 },
    { key: "latency_ms",   label: "Latencia",    fmt: (n) => `${n || 0}ms` },
    { key: "status",       label: "Estado",      fmt: (n) => n || "idle" },
    { key: "_skills",      label: "Skills",      fmt: (n) => n || "—" },
    { key: "provider",     label: "Provider",    fmt: (n) => n || "—" },
  ],
  monitor: "memory",
};

function _nodeMetricValue(node, usage, key) {
  if (key === "_delegation_rate") {
    const classified = Number(node.extra?.classified_tasks || 0);
    const delegated = Number(node.extra?.delegated_tasks || 0);
    return classified ? Math.round((delegated / classified) * 100) : 0;
  }
  if (key === "_error_rate") {
    const total = Number(node.task_count || 0);
    return total ? Math.round((Number(node.error_count || 0) / total) * 100) : 0;
  }
  if (key === "_approval_rate") {
    const total = Number(node.task_count || 0);
    const errors = Number(node.error_count || 0);
    return total ? Math.round(((total - errors) / total) * 100) : 100;
  }
  if (key === "_caps") return (node.active_capabilities || []).join(", ") || "—";
  if (key === "_caps_count") return (node.active_capabilities || []).length;
  if (key === "_levels") return (node.levels || []).map((l) => _LEVEL_SHORT[l] || LEVEL_FULL[l] || l).join(" · ") || "sin niveles";
  if (key === "_skills") return (node.skills || []).slice(0, 3).join(", ") || "—";
  if (key.startsWith("extra.")) return node.extra?.[key.slice(6)];
  return node[key];
}

function renderAgentDetailPanel(node, usageByModel) {
  const el = $("#agentDetailPanel");
  if (!el) return;
  if (!node) { el.innerHTML = `<div class="agent-detail-empty">Selecciona un nodo para ver sus métricas</div>`; return; }

  const usage = usageByModel.get(node.active_model);
  const roleKey = (node.role || "").toLowerCase();
  let defs = ROLE_METRIC_DEFS[roleKey];
  if (typeof defs === "string") defs = ROLE_METRIC_DEFS[defs];
  if (!defs) defs = ROLE_METRIC_DEFS.memory;

  const statusCls = node.status === "error" ? "bad" : (node.status === "idle" || node.status === "completed") ? "ok" : "warn";

  // Common base row: tasks, errors, latency, cost (from usage if available, else node)
  const baseCells = [
    ["Tasks", node.task_count ?? 0],
    ["Errores", node.error_count ?? 0],
    ["Latencia", `${usage?.latency_ms ?? node.latency_ms ?? 0}ms`],
    ["Coste", `$${Number(usage?.estimated_cost ?? node.estimated_cost ?? 0).toFixed(4)}`],
    ["Llamadas", usage?.calls ?? node.task_count ?? 0],
    ["Tokens", node.total_tokens || (node.input_tokens || 0) + (node.output_tokens || 0) || 0],
  ];

  const roleGrid = defs.map(({ key, label, fmt }) => {
    const raw = _nodeMetricValue(node, usage, key);
    return `<div class="agent-role-cell"><small>${escapeHtml(label)}</small><b>${escapeHtml(fmt(raw))}</b></div>`;
  }).join("");

  const caps = (node.active_capabilities || []).map((c) => `<span>${escapeHtml(c)}</span>`).join("");
  const skills = (node.skills || []).map((s) => `<span>${escapeHtml(s)}</span>`).join("");

  el.innerHTML = `
    <div class="agent-detail-identity">
      <div class="agent-detail-name">
        <span class="bubble-dot ${statusCls}"></span>
        <b>${escapeHtml(node.name)}</b>
        <span class="pill ${statusCls}">${escapeHtml(node.role)}</span>
        <small>${escapeHtml(node.active_model || "auto")}</small>
      </div>
    </div>
    <div class="agent-detail-base">
      ${baseCells.map(([l, v]) => `<div class="agent-base-cell"><small>${escapeHtml(l)}</small><b>${escapeHtml(String(v))}</b></div>`).join("")}
    </div>
    <div class="agent-detail-section-label">Métricas de rol · ${escapeHtml(node.role)}</div>
    <div class="agent-role-grid">${roleGrid}</div>
    ${caps ? `<div class="agent-detail-tags"><span class="agent-detail-tag-label">Capacidades</span>${caps}</div>` : ""}
    ${skills ? `<div class="agent-detail-tags"><span class="agent-detail-tag-label">Skills</span>${skills}</div>` : ""}
  `;
}

// ---- Monitor side panel (workflow events for selected agent) ----------------

function renderMonitorSidePanel(node, flow, audit) {
  const headerEl = $("#sideAgentHeader");
  const activityEl = $("#sideActivityList");
  if (!headerEl) return;

  if (!node) {
    headerEl.innerHTML = `<div class="side-empty">Sin nodo seleccionado</div>`;
    if (activityEl) activityEl.innerHTML = "";
    return;
  }

  const statusCls = node.status === "error" ? "bad" : (node.status === "idle" || node.status === "completed") ? "ok" : "warn";
  headerEl.innerHTML = `
    <div class="side-identity-card">
      <div class="side-identity-top">
        <span class="bubble-dot ${statusCls}"></span>
        <div class="side-identity-name">
          <b>${escapeHtml(node.name)}</b>
          <span class="pill ${statusCls}">${escapeHtml(node.status)}</span>
        </div>
      </div>
      <div class="side-identity-row"><small>Rol</small><span>${escapeHtml(node.role)}</span></div>
      <div class="side-identity-row"><small>Modelo</small><span class="mono">${escapeHtml(node.active_model || "auto")}</span></div>
      <div class="side-identity-row"><small>Provider</small><span>${escapeHtml(node.provider || "—")}</span></div>
      ${(node.levels || []).length ? `<div class="side-identity-row"><small>Niveles</small><span>${node.levels.map((l) => LEVEL_FULL[l] || l).join(" · ")}</span></div>` : ""}
      <div class="side-identity-stats">
        <span><b>${node.task_count ?? 0}</b><small>tasks</small></span>
        <span><b>${node.error_count ?? 0}</b><small>err.</small></span>
        <span><b>${node.latency_ms || 0}ms</b><small>lat.</small></span>
        <span><b>$${Number(node.estimated_cost || 0).toFixed(4)}</b><small>coste</small></span>
      </div>
    </div>
  `;

  const relatedActivity = [...(flow || []), ...(audit || [])]
    .filter((ev) => ev.source_node === node.name || ev.target_node === node.name || ev.summary?.includes(node.name))
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
    .slice(0, 8);
  if (activityEl) activityEl.innerHTML = eventList(relatedActivity, "Sin actividad para este nodo.");
}

function renderExecutionFlow(events) {
  const el = $("#executionFlow"); // Phase D removed the legacy Tareas flow strip.
  if (!el) return;
  el.innerHTML = eventList(events.slice(0, 4), "Sin flujo de ejecución.");
}

const _LEVEL_SHORT = { level_1_simple:"N1", level_2_moderate:"N2", level_3_intermediate:"N3", level_4_complex:"N4", level_5_critical:"N5" };

// ---- Inline-SVG chart primitives (zero dependency, theme-driven) ------------
function fmtTokens(n) {
  const value = Number(n || 0);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

function svgDonut(pct, { label = "", sub = "", tone = "accent", size = 84 } = {}) {
  const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
  const r = 33, circ = 2 * Math.PI * r, off = circ * (1 - p / 100), cx = size / 2;
  return `<svg class="svg-donut tone-${tone}" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${escapeHtml(label)} ${p}%">
    <circle class="donut-track" cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke-width="9"/>
    <circle class="donut-fill" cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke-width="9"
      stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"
      transform="rotate(-90 ${cx} ${cx})" stroke-linecap="round"/>
    <text class="donut-num" x="${cx}" y="${cx - 1}" text-anchor="middle">${p}%</text>
    ${sub ? `<text class="donut-sub" x="${cx}" y="${cx + 13}" text-anchor="middle">${escapeHtml(sub)}</text>` : ""}
  </svg>`;
}

function svgSparkline(values, { tone = "accent", w = 120, h = 32 } = {}) {
  const pts = (values || []).map(Number).filter(Number.isFinite);
  if (pts.length < 2) return `<div class="spark-empty">sin histórico todavía</div>`;
  const max = Math.max(...pts), min = Math.min(...pts), span = max - min || 1;
  const step = w / (pts.length - 1);
  const line = pts.map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / span) * (h - 4) - 2).toFixed(1)}`).join(" ");
  return `<svg class="svg-spark tone-${tone}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}" aria-hidden="true">
    <polygon class="spark-area" points="0,${h} ${line} ${w},${h}"/>
    <polyline class="spark-line" points="${line}" fill="none"/>
  </svg>`;
}

function svgTokenRing(consumed, budget) {
  if (!budget) {
    return `<div class="token-plain"><b>${fmtTokens(consumed)}</b><small>tokens usados</small></div>`;
  }
  const pct = (consumed / budget) * 100;
  const remaining = Math.max(0, budget - consumed);
  const tone = pct > 90 ? "bad" : pct > 70 ? "warn" : "ok";
  return `<div class="token-ring">${svgDonut(pct, { tone, sub: "usado" })}
    <div class="token-ring-meta"><b>${fmtTokens(remaining)}</b><small>tokens restantes*</small>
      <span>${fmtTokens(consumed)} / ${fmtTokens(budget)}</span></div></div>`;
}

// ---- Dataviz component library (Redesign) ----------------------------------
// Reusable, theme-aware, accessible chart primitives. Zero libraries; every
// mark colour is driven by the CSS custom properties defined in styles.css
// (--series-1..8 categorical, --status-* reserved, --dv-ramp-0..5 sequential),
// so light/dark/amber themes recolour automatically. Marks follow the method:
// thin marks, 4px rounded data-ends anchored to the baseline, 2px surface gaps,
// 2px lines, ≥8px hover markers, recessive grid/axes, legend for ≥2 series,
// text always in ink tokens (--text/--muted) never the series colour, status
// colours reserved + always shipped with an icon/label.

let _dvSeq = 0;
const dvId = (prefix = "dv") => `${prefix}-${++_dvSeq}`;
const dvEsc = escapeHtml;
// Categorical colour by ENTITY/seriesIndex, never by rank. >8 series cycle as a
// last resort (the method prefers grouping/small-multiples past 8).
const dvSeries = (i) => `var(--series-${((Number(i) || 0) % 8) + 1})`;
const _DV_STATUS = {
  good: { v: "var(--status-good)", icon: "●", label: "OK" },
  warning: { v: "var(--status-warning)", icon: "▲", label: "Aviso" },
  serious: { v: "var(--status-serious)", icon: "◆", label: "Grave" },
  critical: { v: "var(--status-critical)", icon: "■", label: "Crítico" },
};
const dvStatus = (s) => _DV_STATUS[s] || null;
function dvNum(v, fmt) {
  if (typeof fmt === "function") return fmt(v);
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (Number.isInteger(n)) return n.toLocaleString("es-ES");
  return n.toLocaleString("es-ES", { maximumFractionDigits: 2 });
}

// -- Reusable positioned tooltip (single element, show/hide helpers) ----------
let _dvTip = null;
function dvTooltipEl() {
  if (!_dvTip) {
    _dvTip = document.createElement("div");
    _dvTip.className = "dv-tooltip";
    _dvTip.setAttribute("role", "status");
    _dvTip.hidden = true;
    document.body.appendChild(_dvTip);
  }
  return _dvTip;
}
function dvShowTip(html, x, y) {
  const t = dvTooltipEl();
  t.innerHTML = html;
  t.hidden = false;
  const pad = 14;
  const r = t.getBoundingClientRect();
  let left = x + pad, top = y + pad;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - pad;
  if (top + r.height > window.innerHeight - 8) top = y - r.height - pad;
  t.style.left = `${Math.max(8, left)}px`;
  t.style.top = `${Math.max(8, top)}px`;
}
function dvHideTip() { if (_dvTip) _dvTip.hidden = true; }

// -- statTile / statTileRow: hero KPI tiles -----------------------------------
function statTile({ label, value, sub, delta, status } = {}) {
  const st = dvStatus(status);
  let deltaHtml = "";
  if (delta != null && delta !== "") {
    const up = Number(delta) >= 0;
    const arrow = up ? "▲" : "▼";
    const cls = up ? "up" : "down";
    const txt = typeof delta === "number"
      ? `${up ? "+" : ""}${dvNum(delta)}`
      : dvEsc(delta);
    // Colour is never the sole signal: an arrow glyph + signed token accompany it.
    deltaHtml = `<span class="dv-delta ${cls}">${arrow}<span>${txt}</span></span>`;
  }
  const badge = st ? `<span class="dv-status-badge" style="--sc:${st.v}"><span class="dv-status-ico">${st.icon}</span>${st.label}</span>` : "";
  return `<div class="dv-stat-tile">
    <div class="dv-stat-label">${dvEsc(label ?? "")}${badge}</div>
    <div class="dv-stat-value">${dvEsc(value ?? "—")}</div>
    ${sub != null && sub !== "" ? `<div class="dv-stat-sub">${dvEsc(sub)}</div>` : ""}
    ${deltaHtml}
  </div>`;
}
function statTileRow(tiles = []) {
  return `<div class="dv-stat-row">${tiles.map((t) => statTile(t)).join("")}</div>`;
}

// -- hbarChart: horizontal bars for magnitude/identity ------------------------
// Thin bars, 4px rounded ONLY on the data-end (anchored to the left baseline),
// a 2px surface gap between rows, direct right-aligned tabular-nums values,
// recessive baseline, per-bar hover tooltip. Colour by series when comparing
// entities, or a single accent for one series.
function hbarChart({ rows = [], valueFormat, maxLabelWidth = 120, single = false } = {}) {
  if (!rows.length) return `<div class="chart-empty">sin datos</div>`;
  const max = Math.max(1, ...rows.map((r) => Number(r.value) || 0));
  const body = rows.map((r) => {
    const val = Number(r.value) || 0;
    const pct = Math.max(0, (val / max) * 100);
    const st = dvStatus(r.status);
    const color = st ? st.v : single ? "var(--accent)" : dvSeries(r.seriesIndex);
    const fmt = dvNum(val, valueFormat);
    const tip = `${dvEsc(r.label)}: ${fmt}`;
    return `<div class="dv-hbar-row">
      <span class="dv-hbar-label" style="max-width:${maxLabelWidth}px" title="${dvEsc(r.label)}">${st ? `<span class="dv-status-ico" style="color:${st.v}">${st.icon}</span>` : ""}${dvEsc(r.label)}</span>
      <span class="dv-hbar-track"><span class="dv-hbar-fill" style="width:${pct.toFixed(1)}%;background:${color}" data-dv-tip="${dvEsc(tip)}"></span></span>
      <span class="dv-hbar-val">${dvEsc(fmt)}</span>
    </div>`;
  }).join("");
  return `<div class="dv-hbar">${body}</div>`;
}

// -- lineChart: single-y time-series with crosshair + tooltip -----------------
// 2px non-scaling lines, recessive gridlines, ONE y-axis only (two scales →
// two charts / small multiples), markers appear ≥8px only on hover under the
// crosshair. Legend for ≥2 series; ≤4 series also get direct end-labels; a
// single series needs no legend. Text uses ink tokens, never the series colour.
const _dvLineReg = {};
let _dvActiveLine = null;
function lineChart({ series = [], xFormat, yFormat, yLabel, small = false } = {}) {
  const clean = series.filter((s) => (s.points || []).length);
  if (!clean.length) return `<div class="chart-empty">sin datos</div>`;
  const n = Math.max(...clean.map((s) => s.points.length));
  const allY = clean.flatMap((s) => s.points.map((p) => Number(p.y) || 0));
  let min = Math.min(...allY), max = Math.max(...allY);
  if (min === max) { max = max + 1; min = min - 1; }
  min = Math.min(min, 0) === 0 && min >= 0 ? 0 : min; // anchor to zero when non-negative
  const span = max - min || 1;
  const VBW = 640, VBH = small ? 150 : 240;
  const P = { l: 48, r: 16, t: 12, b: 26 };
  const pw = VBW - P.l - P.r, ph = VBH - P.t - P.b;
  const xAt = (i) => P.l + (n === 1 ? pw / 2 : (pw * i) / (n - 1));
  const yAt = (v) => P.t + ph * (1 - (Number(v) - min) / span);
  const id = dvId("line");
  const xLabels = (clean[0].points || []).map((p, i) =>
    typeof xFormat === "function" ? xFormat(p.x, i) : String(p.x ?? i));

  // Registry for hover: fractions of the full svg box (preserveAspectRatio=none
  // makes the mapping linear on both axes).
  const reg = { n, xFrac: [], series: [], xLabels, yFormat: (v) => dvNum(v, yFormat) };
  for (let i = 0; i < n; i++) reg.xFrac.push(xAt(i) / VBW);

  // Gridlines live in the SVG (non-scaling-stroke keeps them 1px under the
  // stretched preserveAspectRatio=none). Axis labels are crisp HTML overlays —
  // SVG <text> would be distorted by the non-uniform scaling.
  const gridY = 4;
  let grid = "";
  const yTicks = [];
  for (let g = 0; g <= gridY; g++) {
    const v = min + (span * g) / gridY;
    const y = yAt(v);
    grid += `<line class="dv-grid" x1="${P.l}" y1="${y.toFixed(1)}" x2="${VBW - P.r}" y2="${y.toFixed(1)}"/>`;
    yTicks.push({ topPct: (y / VBH) * 100, label: dvNum(v, yFormat) });
  }
  const gutterPct = (P.l / VBW) * 100;
  const yAxisHtml = yTicks.map((t) =>
    `<span class="dv-axis-y" style="top:${t.topPct.toFixed(2)}%;width:${gutterPct.toFixed(2)}%">${dvEsc(t.label)}</span>`).join("");
  const xAxisHtml = `<span class="dv-axis-x" style="left:${gutterPct.toFixed(2)}%">${dvEsc(xLabels[0] ?? "")}</span>` +
    (n > 1 ? `<span class="dv-axis-x end">${dvEsc(xLabels[n - 1] ?? "")}</span>` : "");

  const paths = clean.map((s) => {
    const color = dvSeries(s.seriesIndex);
    const pts = s.points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.y).toFixed(1)}`).join(" ");
    reg.series.push({
      name: s.name || "",
      color,
      yFrac: s.points.map((p) => yAt(p.y) / VBH),
      values: s.points.map((p) => Number(p.y) || 0),
    });
    return `<polyline class="dv-line" points="${pts}" style="stroke:${color}"/>`;
  }).join("");

  // Direct end-labels for ≤4 series (ink token, positioned by fraction as HTML).
  let endLabels = "";
  if (clean.length >= 2 && clean.length <= 4 && n > 1) {
    endLabels = clean.map((s) => {
      const last = s.points[s.points.length - 1];
      const top = (yAt(last.y) / VBH) * 100;
      return `<span class="dv-endlabel" style="top:${top.toFixed(2)}%">${dvEsc(s.name || "")}</span>`;
    }).join("");
  }
  _dvLineReg[id] = reg;

  const legend = clean.length >= 2
    ? chartLegend({ series: clean.map((s) => ({ name: s.name, seriesIndex: s.seriesIndex })) })
    : "";
  const yLab = yLabel ? `<div class="dv-ylabel">${dvEsc(yLabel)}</div>` : "";

  return `${yLab}<div class="dv-linechart${small ? " small" : ""}" data-dv-chart="${id}">
    <svg class="dv-line-svg" viewBox="0 0 ${VBW} ${VBH}" preserveAspectRatio="none" role="img" aria-label="${dvEsc(yLabel || (clean[0].name || "serie"))}">
      ${grid}${paths}
    </svg>
    <div class="dv-axes">${yAxisHtml}${xAxisHtml}${endLabels}</div>
    <div class="dv-crosshair"></div>
    <div class="dv-markers"></div>
  </div>${legend}`;
}

function dvLineHover(chart, e) {
  const reg = _dvLineReg[chart.dataset.dvChart];
  if (!reg) return;
  const rect = chart.getBoundingClientRect();
  const xf = (e.clientX - rect.left) / rect.width;
  let idx = 0, best = Infinity;
  for (let i = 0; i < reg.n; i++) {
    const d = Math.abs(reg.xFrac[i] - xf);
    if (d < best) { best = d; idx = i; }
  }
  const px = reg.xFrac[idx] * 100;
  const cross = chart.querySelector(".dv-crosshair");
  if (cross) { cross.style.left = `${px}%`; cross.style.display = "block"; }
  const mk = chart.querySelector(".dv-markers");
  if (mk) {
    mk.innerHTML = reg.series.map((s) => s.yFrac[idx] == null ? "" :
      `<span class="dv-marker" style="left:${px}%;top:${(s.yFrac[idx] * 100).toFixed(2)}%;background:${s.color}"></span>`).join("");
  }
  const rows = reg.series.map((s) =>
    `<div class="dv-tt-row"><span class="dv-swatch" style="background:${s.color}"></span><span class="dv-tt-name">${dvEsc(s.name)}</span><b>${dvEsc(reg.yFormat(s.values[idx]))}</b></div>`).join("");
  dvShowTip(`<div class="dv-tt-title">${dvEsc(reg.xLabels[idx] ?? "")}</div>${rows}`, e.clientX, e.clientY);
  _dvActiveLine = chart;
}
function dvClearLineHover() {
  if (!_dvActiveLine) return;
  const cross = _dvActiveLine.querySelector(".dv-crosshair");
  if (cross) cross.style.display = "none";
  const mk = _dvActiveLine.querySelector(".dv-markers");
  if (mk) mk.innerHTML = "";
  _dvActiveLine = null;
}

// -- smallMultiples: grid of mini lineCharts (no dual axes) --------------------
function smallMultiples({ charts = [] } = {}) {
  if (!charts.length) return `<div class="chart-empty">sin datos</div>`;
  const body = charts.map((c) => `<div class="dv-sm-cell">
      <div class="dv-sm-title">${dvEsc(c.title || "")}</div>
      ${lineChart({ ...c, small: true })}
    </div>`).join("");
  return `<div class="dv-smallmultiples">${body}</div>`;
}

// -- dotRangePlot: latency percentiles per agent (p50→p99 range) --------------
// Thin range line with distinct markers at p50 (filled), p90 (ring), p99
// (diamond); tabular-nums labels; hover tooltip per marker.
function dotRangePlot({ rows = [], valueFormat, unit = "ms" } = {}) {
  if (!rows.length) return `<div class="chart-empty">sin datos</div>`;
  const max = Math.max(1, ...rows.map((r) => Number(r.p99) || 0));
  const pos = (v) => `${Math.max(0, Math.min(100, (Number(v) / max) * 100))}%`;
  const fmt = (v) => dvNum(v, valueFormat);
  const body = rows.map((r) => {
    const color = dvSeries(r.seriesIndex);
    const tip = `${dvEsc(r.label)} · p50 ${fmt(r.p50)}${unit} · p90 ${fmt(r.p90)}${unit} · p99 ${fmt(r.p99)}${unit}`;
    return `<div class="dv-range-row">
      <span class="dv-range-label" title="${dvEsc(r.label)}">${dvEsc(r.label)}</span>
      <span class="dv-range-track" data-dv-tip="${dvEsc(tip)}">
        <span class="dv-range-line" style="left:${pos(r.p50)};right:calc(100% - ${pos(r.p99)});background:${color}"></span>
        <span class="dv-dot p50" style="left:${pos(r.p50)};--c:${color}" title="p50 ${fmt(r.p50)}${unit}"></span>
        <span class="dv-dot p90" style="left:${pos(r.p90)};--c:${color}" title="p90 ${fmt(r.p90)}${unit}"></span>
        <span class="dv-dot p99" style="left:${pos(r.p99)};--c:${color}" title="p99 ${fmt(r.p99)}${unit}"></span>
      </span>
      <span class="dv-range-vals"><b>${dvEsc(fmt(r.p50))}</b><span>${dvEsc(fmt(r.p90))}</span><span>${dvEsc(fmt(r.p99))}</span></span>
    </div>`;
  }).join("");
  return `<div class="dv-rangeplot">
    <div class="dv-range-head"><span></span><span></span><span class="dv-range-vals dv-range-legend"><b>p50</b><span>p90</span><span>p99</span></span></div>
    ${body}
  </div>`;
}

// -- heatmap: 2D magnitude matrix on the sequential blue ramp -----------------
// Sequential ramp (light→dark = low→high), 2px surface gap between cells,
// near-zero cells recede toward the surface, per-cell tooltip, compact colorbar.
function dvRampStep(v, max) {
  if (!max || v <= 0) return 0;
  const t = Math.max(0, Math.min(1, v / max));
  return Math.max(1, Math.min(5, Math.round(t * 5)));
}
function heatmap({ rows = [], cols = [], matrix = [], valueFormat } = {}) {
  if (!rows.length || !cols.length) return `<div class="chart-empty">sin datos</div>`;
  const max = Math.max(1, ...matrix.flat().map((v) => Number(v) || 0));
  const fmt = (v) => dvNum(v, valueFormat);
  const head = `<div class="dv-hm-cell dv-hm-corner"></div>` +
    cols.map((c) => `<div class="dv-hm-col" title="${dvEsc(c)}">${dvEsc(c)}</div>`).join("");
  const body = rows.map((rlab, ri) => {
    const cells = cols.map((clab, ci) => {
      const v = Number(matrix[ri]?.[ci]) || 0;
      const step = dvRampStep(v, max);
      const tip = `${dvEsc(rlab)} × ${dvEsc(clab)}: ${fmt(v)}`;
      return `<div class="dv-hm-cell dv-ramp-${step}" data-dv-tip="${dvEsc(tip)}">${v > 0 ? dvEsc(fmt(v)) : ""}</div>`;
    }).join("");
    return `<div class="dv-hm-row" style="grid-template-columns:var(--hm-rowlabel) repeat(${cols.length}, 1fr)"><div class="dv-hm-rowlabel" title="${dvEsc(rlab)}">${dvEsc(rlab)}</div>${cells}</div>`;
  }).join("");
  const bar = [0, 1, 2, 3, 4, 5].map((s) => `<span class="dv-ramp-${s}"></span>`).join("");
  return `<div class="dv-heatmap" style="--hm-cols:${cols.length}">
    <div class="dv-hm-grid" style="grid-template-columns:var(--hm-rowlabel) repeat(${cols.length}, 1fr)">${head}</div>
    <div class="dv-hm-rows">${body}</div>
    <div class="dv-hm-legend"><span>bajo</span><span class="dv-hm-bar">${bar}</span><span>alto</span></div>
  </div>`;
}

// -- dataTable: sortable table (doubles as the accessible table view) ---------
const _dvTables = {};
function dataTable({ columns = [], rows = [], sortable = true, defaultSort } = {}) {
  const id = dvId("tbl");
  _dvTables[id] = { columns, rows, sort: defaultSort || null, dir: 1 };
  return `<div class="dv-table-wrap"><table class="dv-table" data-dv-table="${id}">
    <thead>${dvTableHead(id)}</thead>
    <tbody>${dvTableBody(id)}</tbody>
  </table></div>`;
}
function dvTableHead(id) {
  const t = _dvTables[id];
  return `<tr>${t.columns.map((c) => {
    const align = c.align || (c.numeric ? "right" : "left");
    const sortable = t.sortableCols !== false;
    const active = t.sort === c.key;
    const arrow = active ? (t.dir > 0 ? " ▲" : " ▼") : "";
    return `<th class="al-${align}${c.numeric ? " num" : ""}"${sortable ? ` data-dv-sort="${dvEsc(c.key)}"` : ""}>${dvEsc(c.label ?? c.key)}<span class="dv-sort-ico">${arrow}</span></th>`;
  }).join("")}</tr>`;
}
function dvTableBody(id) {
  const t = _dvTables[id];
  let rows = t.rows.slice();
  if (t.sort) {
    const col = t.columns.find((c) => c.key === t.sort);
    rows.sort((a, b) => {
      const av = a[t.sort], bv = b[t.sort];
      const na = Number(av), nb = Number(bv);
      const both = Number.isFinite(na) && Number.isFinite(nb);
      const cmp = both ? na - nb : String(av ?? "").localeCompare(String(bv ?? ""));
      return cmp * t.dir;
    });
  }
  return rows.map((row) => `<tr>${t.columns.map((c) => {
    const align = c.align || (c.numeric ? "right" : "left");
    const raw = row[c.key];
    const val = typeof c.format === "function" ? c.format(raw, row) : dvEsc(raw ?? "");
    const dot = c.dot && row.seriesIndex != null
      ? `<span class="dv-idot" style="background:${dvSeries(row.seriesIndex)}"></span>` : "";
    return `<td class="al-${align}${c.numeric ? " num" : ""}">${dot}${val}</td>`;
  }).join("")}</tr>`).join("");
}
function dvSortTable(th) {
  const table = th.closest(".dv-table");
  const id = table?.dataset.dvTable;
  const t = _dvTables[id];
  if (!t) return;
  const key = th.dataset.dvSort;
  if (t.sort === key) t.dir = -t.dir; else { t.sort = key; t.dir = 1; }
  table.querySelector("thead").innerHTML = dvTableHead(id);
  table.querySelector("tbody").innerHTML = dvTableBody(id);
}

// -- chartLegend: reusable legend (ink text, series-coloured swatches) --------
function chartLegend({ series = [] } = {}) {
  if (!series.length) return "";
  return `<div class="dv-legend">${series.map((s) => {
    const st = dvStatus(s.status);
    const color = st ? st.v : (s.color || dvSeries(s.seriesIndex));
    return `<span class="dv-legend-item"><span class="dv-swatch" style="background:${color}"></span>${dvEsc(s.name ?? "")}</span>`;
  }).join("")}</div>`;
}

// -- chartFrame: consistent .card wrapper with optional "ver tabla" toggle -----
function chartFrame({ title, subtitle, controls, body, table } = {}) {
  const id = dvId("frame");
  const toggle = table
    ? `<button type="button" class="dv-table-toggle" data-dv-table-toggle="${id}">ver tabla</button>`
    : "";
  return `<section class="card dv-frame" data-dv-frame="${id}">
    <header class="card-h">
      <span class="dv-frame-title">${dvEsc(title ?? "")}${subtitle ? ` <span class="hint">${dvEsc(subtitle)}</span>` : ""}</span>
      <span class="dv-frame-controls">${controls || ""}${toggle}</span>
    </header>
    <div class="dv-frame-body">
      <div class="dv-frame-chart">${body || ""}</div>
      ${table ? `<div class="dv-frame-table" hidden>${table}</div>` : ""}
    </div>
  </section>`;
}
function dvToggleTable(btn) {
  const frame = btn.closest(".dv-frame");
  if (!frame) return;
  const chart = frame.querySelector(".dv-frame-chart");
  const table = frame.querySelector(".dv-frame-table");
  if (!table) return;
  const showTable = table.hidden;
  table.hidden = !showTable;
  chart.hidden = showTable;
  btn.textContent = showTable ? "ver gráfico" : "ver tabla";
}

// One-time delegated interaction wiring for every dataviz component instance.
function initDataviz() {
  if (document._dvBound) return;
  document._dvBound = true;
  document.addEventListener("pointermove", (e) => {
    const chart = e.target.closest?.(".dv-linechart[data-dv-chart]");
    if (chart) { dvLineHover(chart, e); return; }
    dvClearLineHover();
    const tipEl = e.target.closest?.("[data-dv-tip]");
    if (tipEl) dvShowTip(tipEl.getAttribute("data-dv-tip"), e.clientX, e.clientY);
    else dvHideTip();
  }, { passive: true });
  document.addEventListener("pointerleave", () => { dvClearLineHover(); dvHideTip(); }, true);
  document.addEventListener("click", (e) => {
    const th = e.target.closest?.(".dv-table th[data-dv-sort]");
    if (th) { dvSortTable(th); return; }
    const tog = e.target.closest?.("[data-dv-table-toggle]");
    if (tog) dvToggleTable(tog);
  });
}

function nodeActivitySeries(nodeId) {
  state.nodeActivityHistory ||= {};
  const node = (state.lastObservability?.nodes || []).find((item) => item.id === nodeId);
  const series = (state.nodeActivityHistory[nodeId] ||= []);
  series.push(node?.task_count || 0);
  if (series.length > 24) series.shift();
  return series;
}

// Skill usage across the system: how much each skill was used and by which agents.
function renderSkillUsagePanel(nodes) {
  const totals = {};
  const agentsBySkill = {};
  nodes.forEach((node) => {
    const usage = node.skill_usage || {};
    Object.entries(usage).forEach(([skill, count]) => {
      totals[skill] = (totals[skill] || 0) + Number(count || 0);
      (agentsBySkill[skill] ||= new Set()).add(node.name.split("(")[0].trim().split(",")[0].trim());
    });
  });
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!entries.length) {
    return `<section class="skill-usage-panel"><h4>Uso de skills</h4><div class="chart-empty">Aún no se ha usado ninguna skill.</div></section>`;
  }
  const max = Math.max(...entries.map(([, v]) => v), 1);
  return `<section class="skill-usage-panel">
    <h4>Uso de skills · por agente</h4>
    ${entries
      .map(([skill, count]) => {
        const pct = Math.max(6, Math.round((count / max) * 100));
        const agents = [...(agentsBySkill[skill] || [])];
        return `<div>
          <div class="skill-usage-row">
            <span title="${escapeHtml(skill)}">${escapeHtml(skill)}</span>
            <div class="skill-usage-bar"><i style="width:${pct}%"></i></div>
            <b>${count}</b>
          </div>
          <div class="skill-usage-agents">${agents.map((a) => `<em>${escapeHtml(a)}</em>`).join("") || "<em>—</em>"}</div>
        </div>`;
      })
      .join("")}
  </section>`;
}

// `detail=true` (the single-agent filtered view) folds the node's own spec
// (model/provider) and its own skill usage into this same card, instead of
// stacking the separate system-wide skill-usage/performance panels above it —
// one compact card per node instead of three sections for one node.
function agentChartCard(node, { selected, detail = false } = {}) {
  const status = node.status === "error" ? "bad" : (node.status === "completed" || node.status === "idle") ? "ok" : "warn";
  const shortName = (node.name || "Nodo").split("(")[0].trim().split(",")[0].trim();
  const total = Math.max(1, node.task_count || 0);
  const successPct = node.task_count ? Math.round(((node.task_count - (node.error_count || 0)) / total) * 100) : 100;
  const successTone = successPct >= 90 ? "ok" : successPct >= 60 ? "warn" : "bad";
  const tokens = node.total_tokens || 0;
  // Prefer the shared /agents/performance aggregate (stable per provider_name)
  // for coste/latencia; fall back to the observability node's own values when no
  // matching run aggregate exists so behaviour never regresses.
  const perf = (state.agentPerformance || []).find((p) => p.provider_name && node.provider && p.provider_name === node.provider);
  const cost = perf ? Number(perf.total_cost || 0) : Number(node.estimated_cost || 0);
  const latency = perf ? Math.round(perf.avg_latency_ms || 0) : (node.latency_ms || 0);
  const activity = nodeActivitySeries(node.id);
  const caps = (node.active_capabilities || []).slice(0, 4).map((c) => `<em>${escapeHtml(c)}</em>`).join("");
  const skillEntries = Object.entries(node.skill_usage || {}).sort((a, b) => b[1] - a[1]);
  const specLine = detail
    ? `<div class="agent-chart-spec"><span>${escapeHtml(node.active_model || "auto")}</span><span>${escapeHtml(node.provider || "—")}</span></div>`
    : "";
  const skillChips = detail && skillEntries.length
    ? `<div class="agent-chart-skills">${skillEntries
        .map(([skill, count]) => `<span class="skill-chip">${escapeHtml(skill)} <b>${count}</b></span>`)
        .join("")}</div>`
    : "";
  return `<article class="agent-chart-card ${selected ? "selected" : ""} ${detail ? "detail" : ""}" data-node="${escapeHtml(node.id)}">
    <div class="agent-chart-head">
      <span class="status-dot ${status}"></span>
      <b>${escapeHtml(shortName)}</b>
      <span class="agent-chart-role">${escapeHtml(node.role)}</span>
    </div>
    ${specLine}
    <div class="agent-chart-rings">
      <div class="agent-chart-ring-label">${svgDonut(successPct, { tone: successTone, sub: "éxito" })}<span>tasa de éxito</span></div>
      <div class="agent-chart-ring-label" style="align-items:flex-start">${svgTokenRing(tokens, node.token_budget)}</div>
    </div>
    <div class="agent-chart-activity">
      <small>Actividad (tareas en el tiempo)</small>
      ${svgSparkline(activity, { tone: status })}
    </div>
    <div class="agent-chart-stats">
      <span><small>Pila</small><b>${node.task_count || 0}</b></span>
      <span><small>Errores</small><b>${node.error_count || 0}</b></span>
      <span><small>Coste</small><b>$${cost.toFixed(4)}</b></span>
      <span><small>Latencia</small><b>${latency}ms</b></span>
    </div>
    ${caps ? `<div class="agent-chart-caps">${caps}</div>` : ""}
    ${skillChips}
    ${node.token_budget ? `<div class="agent-chart-note">* consumo acumulado del histórico, no mensual.</div>` : ""}
  </article>`;
}

// Compact "performance" card: model tier / task status breakdown. Sits side by
// side with the skill-usage panel; the wider per-model usage list (below,
// full width) needs more room than a half-width column allows.
function renderPerformancePanel(metrics) {
  const modelEntries = Object.entries(metrics?.by_model || {}).slice(0, 6);
  const statusEntries = Object.entries(metrics?.by_status || {});
  return `<section class="skill-usage-panel">
    <h4>Rendimiento</h4>
    <div class="monitor-graph-grid">
      ${miniBarPanel("Tier de modelo", modelEntries, TIER_LABEL)}
      ${miniBarPanel("Estado de tareas", statusEntries)}
    </div>
  </section>`;
}

function renderModelUsagePanel(modelUsage) {
  const usageRows = modelUsage.length
    ? modelUsage
        .map(
          (item) => `<div class="usage-row">
            <div><b>${escapeHtml(item.model)}</b><span>${escapeHtml(item.provider)}</span></div>
            <span>${item.calls} llamadas</span>
            <span>${item.latency_ms || 0}ms</span>
            <strong>$${Number(item.estimated_cost || 0).toFixed(4)}</strong>
          </div>`
        )
        .join("")
    : `<div class="chart-empty">sin llamadas a modelo</div>`;
  return `<section class="skill-usage-panel">
    <h4>Uso por modelo</h4>
    <div class="usage-list">${usageRows}</div>
  </section>`;
}

// Monitor's per-agent cost/latency table, backed by GET /agents/performance
// (stable GROUP BY provider_name over `runs`) — the audit surface's replacement
// for each view recomputing these numbers independently.
function renderAgentPerformancePanel(perf = state.agentPerformance || []) {
  const rows = perf.length
    ? perf
        .slice()
        .sort((a, b) => (b.task_count || 0) - (a.task_count || 0))
        .map(
          (p) => `<div class="usage-row">
            <div><b>${escapeHtml(p.provider_name)}</b><span>${p.task_count || 0} ejec. · ${p.error_count || 0} err.</span></div>
            <span>${p.avg_latency_ms != null ? Math.round(p.avg_latency_ms) : 0}ms</span>
            <span>${p.total_tokens || 0} tok</span>
            <strong>$${Number(p.total_cost || 0).toFixed(4)}</strong>
          </div>`
        )
        .join("")
    : `<div class="chart-empty">sin ejecuciones registradas</div>`;
  return `<section class="skill-usage-panel">
    <h4>Rendimiento por agente <span class="cost-tag">coste · latencia</span></h4>
    <div class="usage-list">${rows}</div>
  </section>`;
}

// ---- Analítica (Fase 3: DuckDB) --------------------------------------------
// Fetched on Monitor view entry (enterView), NOT on the 20s poll — analytics
// trends don't need sub-second reactivity, so this stays off the hot refresh
// path. Degrades to a friendly "no disponible" state when DuckDB is absent
// (`available:false`, HTTP 200) instead of throwing.
async function renderAnalyticsSection() {
  const body = $("#analyticsBody");
  if (!body) return;
  let data;
  try {
    data = await api("/analytics/dashboard?days=30");
  } catch (error) {
    $("#analyticsWindow").textContent = "";
    body.innerHTML = `<div class="analytics-unavailable"><b>Analítica no disponible</b><span>${escapeHtml(error.message)}</span></div>`;
    return;
  }
  if (!data || data.available === false) {
    $("#analyticsWindow").textContent = "";
    body.innerHTML = `<div class="analytics-unavailable"><b>Analítica no disponible</b><span>${escapeHtml((data && data.reason) || "DuckDB no está instalado (extra opcional).")}</span></div>`;
    return;
  }
  $("#analyticsWindow").textContent = `últimos ${data.window_days} días`;
  body.innerHTML = `
    <div class="monitor-panels-row">
      ${renderTrendCard(data.runs_over_time || [])}
      ${renderCostByProviderCard(data.cost_by_provider_by_day || [])}
    </div>
    <div class="monitor-panels-row">
      ${renderSuccessByTypePanel(data.success_rate_by_task_type || [])}
      ${renderLeaderboardPanel(data.provider_leaderboard || [])}
    </div>`;
}

function renderTrendCard(over) {
  if (!over.length) {
    return `<section class="skill-usage-panel"><h4>Actividad en el tiempo</h4><div class="chart-empty">sin ejecuciones en la ventana</div></section>`;
  }
  const runs = over.map((b) => Number(b.run_count || 0));
  const cost = over.map((b) => Number(b.total_cost || 0));
  const lat = over.map((b) => Math.round(b.avg_latency_ms || 0));
  const totalRuns = runs.reduce((a, b) => a + b, 0);
  const totalCost = cost.reduce((a, b) => a + b, 0);
  return `<section class="skill-usage-panel">
    <h4>Actividad en el tiempo <span class="cost-tag">${totalRuns} ejec · $${totalCost.toFixed(4)}</span></h4>
    <div class="analytics-spark-row">
      <div class="analytics-spark"><small>Ejecuciones</small>${svgSparkline(runs, { tone: "accent" })}</div>
      <div class="analytics-spark"><small>Coste (USD)</small>${svgSparkline(cost, { tone: "ok" })}</div>
      <div class="analytics-spark"><small>Latencia media (ms)</small>${svgSparkline(lat, { tone: "warn" })}</div>
    </div>
    <div class="analytics-buckets">
      ${over
        .map(
          (b) => `<div class="analytics-bucket">
            <span>${escapeHtml(String(b.bucket || "").slice(0, 10))}</span>
            <b>${b.run_count || 0} ejec</b>
            <em>$${Number(b.total_cost || 0).toFixed(4)} · ${Math.round(b.avg_latency_ms || 0)}ms</em>
          </div>`
        )
        .join("")}
    </div>
  </section>`;
}

function renderCostByProviderCard(rows) {
  const totals = {};
  rows.forEach((r) => {
    totals[r.provider_name] = (totals[r.provider_name] || 0) + Number(r.total_cost || 0);
  });
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1e-9, ...entries.map(([, v]) => v));
  const rowsHtml = entries.length
    ? entries
        .map(([name, v]) => {
          const pct = Math.max(4, Math.round((v / max) * 100));
          return `<div class="skill-usage-row">
            <span title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <div class="skill-usage-bar"><i style="width:${pct}%"></i></div>
            <b>$${v.toFixed(4)}</b>
          </div>`;
        })
        .join("")
    : `<div class="chart-empty">sin coste registrado en la ventana</div>`;
  return `<section class="skill-usage-panel"><h4>Coste por proveedor</h4>${rowsHtml}</section>`;
}

function renderSuccessByTypePanel(rows) {
  const list = rows.length
    ? rows
        .map((r) => {
          const pct = Math.round((r.success_rate || 0) * 100);
          const tone = pct >= 90 ? "ok" : pct >= 60 ? "warn" : "bad";
          return `<div class="usage-row">
            <div><b>${escapeHtml(r.task_type || "—")}</b><span>${r.run_count || 0} ejec · ${Math.round(r.avg_latency_ms || 0)}ms</span></div>
            <span class="pill ${tone}">${pct}%</span>
            <strong>$${Number(r.total_cost || 0).toFixed(4)}</strong>
          </div>`;
        })
        .join("")
    : `<div class="chart-empty">sin datos por tipo de tarea</div>`;
  return `<section class="skill-usage-panel"><h4>Éxito por tipo de tarea</h4><div class="usage-list">${list}</div></section>`;
}

function renderLeaderboardPanel(rows) {
  const list = rows.length
    ? rows
        .map((r) => {
          const errPct = Math.round((r.error_rate || 0) * 100);
          return `<div class="usage-row">
            <div><b>${escapeHtml(r.provider_name || "—")}</b><span>${r.run_count || 0} ejec · ${errPct}% err · ${Math.round(r.avg_latency_ms || 0)}ms</span></div>
            <span>$${Number(r.avg_cost_per_run || 0).toFixed(4)}/ejec</span>
            <strong>$${Number(r.total_cost || 0).toFixed(4)}</strong>
          </div>`;
        })
        .join("")
    : `<div class="chart-empty">sin ejecuciones registradas</div>`;
  return `<section class="skill-usage-panel">
    <h4>Ranking de proveedores <span class="cost-tag">coste · latencia · error</span></h4>
    <div class="usage-list">${list}</div>
  </section>`;
}

// ---- Predicciones (Fase 4: XGBoost) ----------------------------------------
// The expected normal state right now is meets_gate=false (production has ~42
// usable runs vs the 200 gate) — that renders as informative progress, never an
// error. meets_gate + untrained → offer training; trained → a compact predict form.
async function renderPredictionsPanel() {
  const body = $("#predictionsBody");
  if (!body) return;
  const hint = $("#predictionsHint");
  let s;
  try {
    s = await api("/analytics/predictions/status");
  } catch (error) {
    if (hint) hint.textContent = "";
    body.innerHTML = `<div class="analytics-unavailable"><b>Predicciones no disponibles</b><span>${escapeHtml(error.message)}</span></div>`;
    return;
  }
  state.predictionStatus = s;
  const min = s.min_required || 200;
  const samples = s.samples || 0;
  const pct = Math.min(100, Math.round((samples / min) * 100));
  const remaining = Math.max(0, min - samples);

  if (s.reason && !s.trained && !s.meets_gate) {
    // ML libs (xgboost) unavailable — treated distinctly from "not enough data".
    if (hint) hint.textContent = "";
    body.innerHTML = `<div class="analytics-unavailable"><b>Predicciones no disponibles</b><span>${escapeHtml(s.reason)}</span></div>`;
    return;
  }
  if (s.trained) {
    if (hint) hint.textContent = "modelos entrenados";
    body.innerHTML = renderPredictForm(s);
    $("#predictBtn")?.addEventListener("click", runPrediction);
    return;
  }
  if (s.meets_gate) {
    if (hint) hint.textContent = "listo para entrenar";
    body.innerHTML = `<div class="predict-progress">
      <div class="predict-progress-head"><b>${samples}/${min} ejecuciones</b><span>umbral alcanzado</span></div>
      <div class="predict-bar"><i style="width:${pct}%"></i></div>
      <p>Hay datos suficientes. Entrena los modelos de éxito, coste y latencia.</p>
      <button type="button" class="primary" id="trainModelsBtn">Entrenar modelos</button>
    </div>`;
    $("#trainModelsBtn")?.addEventListener("click", trainPredictiveModels);
    return;
  }
  if (hint) hint.textContent = `${remaining} restantes`;
  body.innerHTML = `<div class="predict-progress">
    <div class="predict-progress-head"><b>${samples}/${min} ejecuciones</b><span>${remaining} más para activar predicciones</span></div>
    <div class="predict-bar"><i style="width:${pct}%"></i></div>
    <p>Las predicciones (éxito, coste, latencia y anomalías) se activan al alcanzar ${min} ejecuciones completadas. Sigue ejecutando tareas para acumular historial.</p>
  </div>`;
}

async function trainPredictiveModels() {
  const btn = $("#trainModelsBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Entrenando…";
  }
  try {
    await api("/analytics/train", { method: "POST" });
    toast("Modelos entrenados.");
  } catch (error) {
    toast(`Entrenamiento: ${error.message}`);
  } finally {
    renderPredictionsPanel().catch(() => {});
  }
}

const PREDICT_CRITERIA = [
  "ambiguity",
  "context_required",
  "reasoning_depth",
  "autonomy_required",
  "operational_risk",
  "validation_difficulty",
];
function renderPredictForm(s) {
  return `<div class="predict-form">
    <p>Modelos entrenados sobre ${s.samples || 0} ejecuciones. Estima éxito, coste y latencia de una tarea borrador.</p>
    <div class="predict-criteria">
      <label class="predict-field"><span>intención</span><input type="text" id="pfIntent" value="implement" /></label>
      <label class="predict-field"><span>complejidad (0-1)</span><input type="number" id="pfComplexity" min="0" max="1" step="0.1" value="0.5" /></label>
      ${PREDICT_CRITERIA.map(
        (k) => `<label class="predict-field"><span>${k}</span><input type="number" class="pf-crit" data-crit="${k}" min="0" max="5" step="0.5" value="2.5" /></label>`
      ).join("")}
    </div>
    <button type="button" class="primary" id="predictBtn">Predecir</button>
    <div id="predictResult"></div>
  </div>`;
}

async function runPrediction() {
  const criteria = {};
  $$(".pf-crit").forEach((i) => (criteria[i.dataset.crit] = Number(i.value) || 0));
  const payload = {
    intent: ($("#pfIntent")?.value || "implement").trim() || "implement",
    criteria,
    complexity_score: Number($("#pfComplexity")?.value) || 0,
  };
  const out = $("#predictResult");
  if (out) out.innerHTML = `<div class="chart-empty">Prediciendo…</div>`;
  try {
    const r = await api("/predict/task", { method: "POST", body: JSON.stringify(payload) });
    if (out)
      out.innerHTML = `<div class="predict-out">
        <div><small>Prob. de éxito</small><b>${Math.round((r.predicted_success_prob || 0) * 100)}%</b></div>
        <div><small>Coste estimado</small><b>$${Number(r.predicted_cost_usd || 0).toFixed(4)}</b></div>
        <div><small>Latencia estimada</small><b>${Math.round(r.predicted_latency_ms || 0)}ms</b></div>
        <div><small>Anomalía</small><b>${r.is_anomaly ? "sí" : "no"}</b></div>
      </div>`;
  } catch (error) {
    if (out) out.innerHTML = `<div class="chart-empty">${escapeHtml(error.message)}</div>`;
  }
}

// ---- Búsqueda de tareas (Fase 3: FTS5) -------------------------------------
// Debounced full-text search over /search/tasks; a result selects/scrolls-to the
// matching row in the tasks table when it's currently loaded.
let taskSearchTimer = null;
function initTaskSearch() {
  const input = $("#taskSearch");
  if (!input) return;
  input.addEventListener("input", () => {
    clearTimeout(taskSearchTimer);
    const q = input.value.trim();
    if (!q) {
      hideTaskSearchResults();
      return;
    }
    taskSearchTimer = setTimeout(() => runTaskSearch(q), 300);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".task-search")) hideTaskSearchResults();
  });
}

function hideTaskSearchResults() {
  const box = $("#taskSearchResults");
  if (box) {
    box.hidden = true;
    box.innerHTML = "";
  }
}

async function runTaskSearch(q) {
  const box = $("#taskSearchResults");
  if (!box) return;
  let data;
  try {
    data = await api(`/search/tasks?q=${encodeURIComponent(q)}&limit=20`);
  } catch (error) {
    box.hidden = false;
    box.innerHTML = `<div class="task-search-empty">${escapeHtml(error.message)}</div>`;
    return;
  }
  const results = data.results || [];
  box.hidden = false;
  if (!results.length) {
    box.innerHTML = `<div class="task-search-empty">Sin resultados para “${escapeHtml(q)}”.</div>`;
    return;
  }
  box.innerHTML =
    `<div class="task-search-count">${data.count} resultado${data.count === 1 ? "" : "s"}</div>` +
    results
      .map((r) => {
        const created = r.created_at ? String(r.created_at).slice(0, 10) : "";
        return `<button type="button" class="task-search-item" data-legacy="${escapeHtml(r.legacy_task_id || "")}">
          <b>${escapeHtml(r.title || r.legacy_task_id || r.id || "tarea")}</b>
          <span>${escapeHtml(r.task_type || "—")} · ${escapeHtml(r.status || "")} · ${created}</span>
        </button>`;
      })
      .join("");
  $$(".task-search-item", box).forEach((btn) =>
    btn.addEventListener("click", () => selectSearchResult(btn.dataset.legacy))
  );
}

function selectSearchResult(legacyId) {
  hideTaskSearchResults();
  const input = $("#taskSearch");
  if (input) input.value = "";
  if (!legacyId) {
    toast("La tarea no tiene id legacy asociado.");
    return;
  }
  const row = $(`#taskRows tr[data-id="${CSS.escape(legacyId)}"]`);
  if (row) {
    row.click();
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.add("search-flash");
    setTimeout(() => row.classList.remove("search-flash"), 1200);
  } else {
    toast("La tarea no está en la lista visible actual.");
  }
}

// "Todos" shows every agent's chart card; picking one agent filters the same
// grid down to just that card instead of routing to a second, separate detail
// surface — one render path, no duplicated logic between the two views.
function renderNodeFilterTabs(nodes) {
  const active = nodes.some((n) => n.id === state.nodeFilter) ? state.nodeFilter : "__all__";
  const chip = (id, label, selected) =>
    `<button type="button" class="node-filter-chip ${selected ? "active" : ""}" data-node-filter="${escapeHtml(id)}">${escapeHtml(label)}</button>`;
  return `<div class="node-filter-tabs">
    ${chip("__all__", "Todos", active === "__all__")}
    ${nodes
      .map((node) => chip(node.id, (node.name || "Nodo").split("(")[0].trim().split(",")[0].trim(), active === node.id))
      .join("")}
  </div>`;
}

function renderNodeOverview(nodes, metrics, modelUsage = []) {
  const target = $("#nodeOverview");
  if (!target) return;
  if (!nodes.length) {
    target.innerHTML = `<div class="chart-empty">Sin nodos observados todavía.</div>`;
    return;
  }
  const active = nodes.some((n) => n.id === state.nodeFilter) ? state.nodeFilter : "__all__";
  const visible = active === "__all__" ? nodes : nodes.filter((n) => n.id === active);
  // "Todos" keeps the system-wide skill-usage/performance panels above the
  // grid; a single agent instead gets one condensed spec+stats card (detail
  // mode) so its spec isn't spread across three stacked sections.
  target.innerHTML =
    active === "__all__"
      ? `${renderNodeFilterTabs(nodes)}
    <div class="monitor-panels-row">
      ${renderSkillUsagePanel(nodes)}
      ${renderPerformancePanel(metrics)}
    </div>
    ${renderModelUsagePanel(modelUsage)}
    ${renderAgentPerformancePanel()}
    <div class="agent-chart-grid">
      ${visible.map((node) => agentChartCard(node, { selected: node.id === state.selectedNodeId })).join("")}
    </div>`
      : `${renderNodeFilterTabs(nodes)}
    <div class="agent-chart-grid single">
      ${visible.map((node) => agentChartCard(node, { selected: true, detail: true })).join("")}
    </div>`;

  $$("#nodeOverview .node-filter-chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      state.nodeFilter = chip.dataset.nodeFilter;
      if (state.nodeFilter !== "__all__") state.selectedNodeId = state.nodeFilter;
      setMonitorSide(true);
      renderNodeOverview(nodes, metrics, modelUsage);
      _renderAgentPanels(nodes, state.lastObservability?.execution_flow || [], state.lastObservability?.audit_timeline || []);
    })
  );
  $$("#nodeOverview .agent-chart-card").forEach((card) =>
    card.addEventListener("click", () => {
      state.selectedNodeId = card.dataset.node;
      setMonitorSide(true);
      renderNodeOverview(nodes, metrics, modelUsage);
      _renderAgentPanels(nodes, state.lastObservability?.execution_flow || [], state.lastObservability?.audit_timeline || []);
    })
  );
}

function miniBarPanel(title, entries, labelMap = {}) {
  const max = Math.max(1, ...entries.map(([, value]) => Number(value || 0)));
  const rows = entries.length
    ? entries
        .map(([key, value]) => {
          const pct = Math.max(4, Math.round((Number(value || 0) / max) * 100));
          return `<div class="mini-bar-row"><span>${escapeHtml(labelMap[key] || key)}</span><b>${value}</b><i style="width:${pct}%"></i></div>`;
        })
        .join("")
    : `<div class="chart-empty">sin datos</div>`;
  return `<section class="mini-graph-card"><h4>${escapeHtml(title)}</h4>${rows}</section>`;
}

function latencyPanel(health) {
  const latency = Number(health?.avg_latency_ms || 0);
  const pct = Math.min(100, Math.round((latency / 2000) * 100));
  return `<section class="mini-graph-card latency-card">
    <h4>Latencia media</h4>
    <div class="latency-ring" style="--pct:${pct}%"><b>${latency}ms</b><span>media</span></div>
    <p>${health?.blocked_tasks || 0} bloqueadas · $${Number(health?.total_cost || 0).toFixed(4)} coste</p>
  </section>`;
}

async function showProviderSetup(name) {
  const targets = $$(`[data-provider-setup-target="${CSS.escape(name)}"]`);
  if (!targets.length) return;
  targets.forEach((target) => {
    target.hidden = false;
    target.innerHTML = `<div class="human-home-empty">Cargando pasos de configuración…</div>`;
  });
  try {
    const setup = await api(`/providers/${encodeURIComponent(name)}/setup`);
    const html = `<div class="provider-setup-box">
      ${(setup.steps || []).map((step) => `<div><span>${escapeHtml(step)}</span></div>`).join("") || "<div><span>Sin pasos disponibles.</span></div>"}
    </div>`;
    targets.forEach((target) => (target.innerHTML = html));
  } catch (error) {
    const html = `<div class="provider-setup-box"><div><span>${escapeHtml(error.message)}</span></div></div>`;
    targets.forEach((target) => (target.innerHTML = html));
  }
}

// Single source of truth for provider cost/latency: GET /agents/performance
// (Fase 1, GROUP BY provider_name over `runs`). Views consume this cached
// aggregate instead of each recomputing coste/latencia from /metrics+/observability.
function computeCostLatency(perf = state.agentPerformance || []) {
  let totalCost = 0, tasks = 0, errors = 0, tokens = 0, latSum = 0, latWeight = 0;
  perf.forEach((p) => {
    const weight = Number(p.task_count || 0) || 1;
    totalCost += Number(p.total_cost || 0);
    tasks += Number(p.task_count || 0);
    errors += Number(p.error_count || 0);
    tokens += Number(p.total_tokens || 0);
    if (p.avg_latency_ms != null) { latSum += Number(p.avg_latency_ms) * weight; latWeight += weight; }
  });
  return { totalCost, tasks, errors, tokens, avgLatency: latWeight ? Math.round(latSum / latWeight) : 0, hasData: perf.length > 0 };
}

function renderSummaryMetrics(metrics, tasks, observability) {
  if (!$("#summaryMetrics")) return; // Phase D removed the legacy Tareas summary card.
  const nodes = observability.nodes || [];
  const usage = observability.model_usage || [];
  const totalCalls = usage.reduce((acc, item) => acc + Number(item.calls || 0), 0);
  const perf = computeCostLatency();
  // /agents/performance is authoritative for coste/latencia; fall back to the
  // legacy /metrics+/observability numbers only while `runs` has no rows yet.
  const avgLatency = perf.hasData ? perf.avgLatency : (observability.health?.avg_latency_ms || 0);
  const totalCost = perf.hasData ? perf.totalCost : Number(metrics.total_estimated_cost_usd || 0);
  const completed = metrics.by_status?.completed || 0;
  const delegated = metrics.by_status?.delegated || metrics.delegated_tasks || 0;
  const items = [
    ["Nodos", nodes.length || observability.health?.observed_nodes || 0],
    ["Llamadas", totalCalls],
    ["Completadas", completed],
    ["Delegadas", delegated],
    ["Latencia media", `${avgLatency}ms`],
    ["Coste total", `$${Number(totalCost).toFixed(4)}`],
  ];
  $("#summaryMetrics").innerHTML = `<div class="summary-hero">
      <span>Actividad total</span>
      <b>${metrics.total_subtasks || totalCalls || tasks.length}</b>
      <small>${delegated} delegadas · ${completed} completadas</small>
    </div>
    <div class="summary-grid">
      ${items
        .map(([label, value]) => `<div class="summary-item"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`)
        .join("")}
    </div>`;
}

function renderAuditTimeline(events) {
  const target = $("#auditTimeline");
  if (!target) return;
  const node = (state.lastObservability?.nodes || []).find((item) => item.id === state.selectedNodeId);
  if (!node) {
    target.innerHTML = `<div class="chart-empty">Selecciona un agente.</div>`;
    return;
  }
  const total = Math.max(1, node.task_count || 0);
  const errors = Math.min(total, node.error_count || 0);
  const ok = Math.max(0, total - errors);
  const cost = Number(node.estimated_cost || 0);
  const latency = Number(node.latency_ms || 0);
  target.innerHTML = `<div class="agent-usage-panel">
    <div class="usage-split">
      <span style="--w:${Math.round((ok / total) * 100)}%"><b>${ok}</b><small>ok</small></span>
      <span style="--w:${Math.round((errors / total) * 100)}%"><b>${errors}</b><small>err.</small></span>
    </div>
    <div class="side-mini-grid">
      <span><b>${latency}ms</b><small>latencia</small></span>
      <span><b>$${cost.toFixed(4)}</b><small>coste</small></span>
      <span><b>${(node.active_capabilities || []).length}</b><small>capacidades</small></span>
      <span><b>${(node.skills || []).length}</b><small>skills</small></span>
    </div>
    <div class="side-tags">${(node.active_capabilities || []).map((cap) => `<em>${escapeHtml(cap)}</em>`).join("") || "<em>sin capacidades</em>"}</div>
  </div>`;
}

function eventList(events, emptyText) {
  return events.length
    ? events
        .map(
          (event) => `<div class="event-row ${escapeHtml(event.status || "")}">
            <span class="event-dot" aria-hidden="true"></span>
            <div class="event-main">
              <div class="event-line">
                <time>${formatTime(event.timestamp)}</time>
                <b>${escapeHtml(friendlyEventType(event.event_type))}</b>
                <em>${event.cost ? `$${Number(event.cost).toFixed(4)}` : event.latency_ms ? `${event.latency_ms}ms` : ""}</em>
              </div>
              <span>${escapeHtml(cleanEventSummary(event.summary))}</span>
              <small>${escapeHtml(event.source_node || "Agent")}${event.target_node ? ` → ${escapeHtml(event.target_node)}` : ""}${event.model ? ` · ${escapeHtml(TIER_LABEL[event.model] || event.model)}` : ""}</small>
            </div>
          </div>`
        )
        .join("")
    : `<div class="chart-empty">${emptyText}</div>`;
}

function friendlyEventType(type = "") {
  const map = {
    prompt_received: "Solicitud recibida",
    task_classified: "Clasificación",
    task_assigned: "Asignación",
    task_delegated: "Delegación",
    provider_fallback: "Reserva de proveedor",
    task_reassigned: "Reasignación",
    validation: "Validación",
    validator_approved: "Validación aprobada",
    validator_rejected: "Validación rechazada",
    task_queued: "En cola",
    waiting_for_agent: "Esperando agente libre",
    tier_escalated: "Escalado de nivel",
    validator_escalated_to_root: "Escalado a raíz",
    task_revised: "Revisión solicitada",
    error_detected: "Error detectado",
    execution: "Ejecución",
  };
  return map[type] || type.replace(/_/g, " ");
}

function cleanEventSummary(summary = "") {
  return String(summary)
    .replace(/\bsub_\d+\s*[:·-]?\s*/gi, "")
    .replace(/\bmodel=[^;\s]+;?/gi, "")
    .replace(/\bstrategy=[^;\s]+;?/gi, "")
    .replace(/\bts(?:k)?_[a-z0-9]+/gi, "")
    .replace(/\s*[·;]\s*$/g, "")
    .trim();
}

function renderModelUsage(items) {
  $("#modelUsage").innerHTML = items.length
    ? items
        .map(
          (item) => `<div class="usage-row">
            <div><b>${escapeHtml(item.model)}</b><span>${escapeHtml(item.provider)}</span></div>
            <span>${item.calls} llamadas</span>
            <span>${item.latency_ms || 0}ms</span>
            <strong>$${Number(item.estimated_cost || 0).toFixed(4)}</strong>
          </div>`
        )
        .join("")
    : `<div class="chart-empty">sin llamadas a modelo</div>`;
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function renderKpis(metrics) {
  const topModel = Object.entries(metrics.by_model).sort((a, b) => b[1] - a[1])[0];
  const cells = [
    ["Tareas", metrics.total_tasks, "M0,15 L20,12 L40,18 L60,8 L80,14 L100,10"],
    ["Delegadas", metrics.delegated_tasks ?? 0, "M0,18 L20,15 L40,10 L60,12 L80,5 L100,8"],
    ["Subtareas", metrics.total_subtasks ?? 0, "M0,15 L20,15 L40,15 L60,5 L80,10 L100,5"],
    ["Score medio", metrics.average_complexity_score.toFixed(2), "M0,15 L20,13 L40,11 L60,10 L80,9 L100,10"],
    ["Revisión humana", metrics.human_review_required, "M0,18 L70,18 L100,5"],
    ["Coste est.", `$${metrics.total_estimated_cost_usd.toFixed(4)}`, "M0,15 L20,16 L40,17 L60,14 L80,12 L100,10"],
    ["Modelo top", topModel ? TIER_LABEL[topModel[0]] || topModel[0] : "—", "M0,10 L100,10"],
  ];
  $("#kpis").innerHTML = cells
    .map(
      ([label, value, path]) => `<div class="kpi"><span>${label}</span><b>${escapeHtml(value)}</b>
        <svg viewBox="0 0 100 22" aria-hidden="true"><path d="${path}" vector-effect="non-scaling-stroke"></path></svg>
      </div>`
    )
    .join("");
}

// inline SVG horizontal bar chart — no external lib
function barCard(title, entries, labelMap) {
  const max = Math.max(1, ...entries.map(([, v]) => v));
  const rows = entries.length
    ? entries
        .map(([key, value]) => {
          const label = labelMap ? labelMap[key] || key : key;
          const pct = Math.round((value / max) * 100);
          return `<div class="chart-row"><span class="chart-lbl">${escapeHtml(label)}</span>
            <span class="chart-bar"><span style="width:${pct}%"></span></span>
            <span class="chart-val">${value}</span></div>`;
        })
        .join("")
    : `<div class="chart-empty">sin datos</div>`;
  return `<section class="chart-card"><header class="card-h">${title}</header><div class="chart-body">${rows}</div></section>`;
}

function renderCharts(metrics) {
  const byLevel = LEVELS.map(([key]) => [key, metrics.by_level[key] || 0]).filter(([, v]) => v || true);
  const reviewRatio = metrics.total_tasks
    ? Math.round((metrics.human_review_required / metrics.total_tasks) * 100)
    : 0;
  const gauge = `<section class="chart-card"><header class="card-h">Revisión humana</header>
    <div class="gauge"><div class="gauge-num">${reviewRatio}%</div>
      <div class="gauge-track"><div class="gauge-fill" style="width:${reviewRatio}%"></div></div>
      <div class="gauge-sub">${metrics.human_review_required}/${metrics.total_tasks} tareas · score medio ${metrics.average_complexity_score.toFixed(
        2
      )}</div></div></section>`;
  $("#charts").innerHTML =
    barCard("Por nivel de complejidad", byLevel, LEVEL_FULL) +
    barCard("Por modelo / tier", Object.entries(metrics.by_model), TIER_LABEL) +
    barCard("Por backend", Object.entries(metrics.by_backend)) +
    barCard("Por estado", Object.entries(metrics.by_status || {})) +
    barCard("Por skill", Object.entries(metrics.by_skill || {})) +
    gauge;
}

function statusPill(status) {
  const cls = status === "completed" ? "ok" : status === "failed" ? "bad" : "warn";
  return `<span class="pill ${cls}">${status}</span>`;
}

function renderTaskRows(tasks) {
  // Phase D replaced the legacy Tareas table with renderTareas(); this legacy
  // renderer no-ops when its old targets are gone so refreshMonitor() stays safe.
  if (!$("#taskRows")) return;
  $("#taskCount").textContent = tasks.length ? `${tasks.length}` : "";
  $("#taskRows").innerHTML = tasks
    .map((task) => {
      const c = task.classification;
      const level = c.complexity_level.replace("level_", "L").replace(/_.*/, "");
      const sel = task.task_id === state.selected ? "selected" : "";
      return `<tr class="${sel}" data-id="${task.task_id}">
        <td>${task.task_id}</td><td>${level} · ${c.complexity_score}</td>
        <td>${TIER_LABEL[c.recommended_model] || c.recommended_model}</td>
        <td>${statusPill(task.status)}</td></tr>`;
    })
    .join("");
  $$("#taskRows tr").forEach((row) =>
    row.addEventListener("click", () => {
      state.selected = row.dataset.id;
      $$("#taskRows tr").forEach((r) => r.classList.toggle("selected", r === row));
      const task = state.tasks.find((t) => t.task_id === row.dataset.id);
      if (task) renderDetail(task);
    })
  );
}

async function renderDetail(task) {
  // Phase D replaced this cramped side-card with the full-width Tareas drill-down
  // (renderTareasDetail). Kept + guarded so refreshMonitor()'s call is a no-op.
  if (!$("#detail")) return;
  const c = task.classification;
  $("#detailEmpty").hidden = true;
  $("#detail").hidden = false;
  $("#dId").textContent = task.task_id;
  $("#dIntent").textContent = c.intent;
  $("#dDomains").textContent = c.domain.join(", ");
  $("#dStrategy").textContent = c.recommended_strategy;
  $("#dBy").textContent = c.classified_by;
  $("#dReason").textContent = c.reason;
  $("#dSkills").innerHTML = (c.recommended_skills || [])
    .map((skill) => `<span class="tag">${escapeHtml(skill)}</span>`)
    .join("");

  $("#dCriteria").innerHTML = Object.entries(c.criteria)
    .map(([name, value]) => {
      const pct = Math.round((Number(value) / 5) * 100);
      return `<div class="bar-row"><div class="bar-label"><span>${name}</span><span>${Number(value).toFixed(1)}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div></div>`;
    })
    .join("");

  const execs = new Map((task.delegation?.executions || []).map((e) => [e.subtask_id, e]));
  $("#dSubtasks").innerHTML = c.subtasks
    .map((sub) => {
      const ex = execs.get(sub.id);
      const meta = ex
        ? `${ex.backend}:${ex.model_used} · ${ex.status} · ${ex.latency_ms}ms · $${ex.estimated_cost_usd.toFixed(5)}`
        : `${TIER_LABEL[sub.recommended_model] || sub.recommended_model} · pendiente`;
      const skill = sub.recommended_skill ? ` · skill: ${escapeHtml(sub.recommended_skill)}` : "";
      return `<div class="subtask"><code>${sub.id}</code> <b>${escapeHtml(sub.name)}</b>
        <div class="meta">${escapeHtml(meta)}${skill}</div></div>`;
    })
    .join("");

  try {
    const decisions = await api(`/tasks/${task.task_id}/decisions`);
    const approval = task.status === "delegated" && c.requires_human_review
      ? `<button class="approve-review" data-approve="${task.task_id}">Aprobar revisión humana</button>`
      : "";
    $("#dDecisions").innerHTML =
      decisions
        .map(
          (d) =>
            `<div class="row"><b>[${d.phase}]</b> ${escapeHtml(d.decision)}${
              d.reason ? ` — ${escapeHtml(d.reason)}` : ""
            }</div>`
        )
        .join("") + approval || `<div class="row">Sin decisiones registradas.</div>${approval}`;
  } catch {
    $("#dDecisions").innerHTML = `<div class="row">No disponible.</div>`;
  }
}

// ---- DECISION DIAGRAM ------------------------------------------------------
function ensureEntities() {
  if (!state.entities.length) {
    const saved = loadEntityState();
    if (saved.length) {
      state.entities = saved;
      normalizeEntityPositions();
      return;
    }
    state.entities = [
      {
        id: "entity-parent",
        name: "Padre",
        role: "parent",
        provider: "",
        levels: [],
        parentId: "",
        skills: [],
        x: 24,
        y: 36,
      },
    ];
  }
  normalizeEntityPositions();
}

function loadEntityState() {
  try {
    const parsed = JSON.parse(localStorage.getItem("karajan-decision-entities") || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function ensureGroups() {
  if (!Array.isArray(state.groups) || !state.groups.length) {
    try {
      const parsed = JSON.parse(localStorage.getItem("karajan-decision-groups") || "[]");
      if (Array.isArray(parsed)) state.groups = parsed;
    } catch {
      state.groups = state.groups || [];
    }
  }
  normalizeGroups();
}

function persistEntityState() {
  localStorage.setItem("karajan-decision-entities", JSON.stringify(state.entities));
  localStorage.setItem("karajan-decision-groups", JSON.stringify(state.groups || []));
  clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(saveRoutingLayout, 500);
}

async function loadRoutingLayout() {
  try {
    const layout = await api("/routing-layout");
    if (Array.isArray(layout.groups)) {
      state.groups = layout.groups;
      localStorage.setItem("karajan-decision-groups", JSON.stringify(state.groups));
      normalizeGroups();
    }
    if (layout.entities?.length) {
      state.entities = layout.entities;
      state.diagramZoom = layout.zoom || state.diagramZoom;
      state.drawerWidth = layout.drawer_width || state.drawerWidth;
      const hasLocalOpenClawPos = !!localStorage.getItem(OPENCLAW_POS_KEY);
      const layoutOpenClawIsDefault = Number(layout.openclaw_pos?.x || 0) === 0 && Number(layout.openclaw_pos?.y || 0) === 0;
      if (
        layout.openclaw_pos &&
        Number.isFinite(Number(layout.openclaw_pos.x)) &&
        Number.isFinite(Number(layout.openclaw_pos.y)) &&
        (!hasLocalOpenClawPos || !layoutOpenClawIsDefault)
      ) {
        state.openclawPos = layout.openclaw_pos;
        localStorage.setItem(OPENCLAW_POS_KEY, JSON.stringify(state.openclawPos));
      }
      localStorage.setItem("karajan-decision-entities", JSON.stringify(state.entities));
      localStorage.setItem("karajan-diagram-zoom", String(state.diagramZoom));
      localStorage.setItem("karajan-model-drawer-width", String(state.drawerWidth));
      normalizeEntityPositions();
    }
  } catch {
    // LocalStorage remains the offline fallback for the diagram.
  }
}

async function saveRoutingLayout() {
  try {
    await api("/routing-layout", {
      method: "PUT",
      body: JSON.stringify({
        entities: state.entities,
        groups: state.groups,
        zoom: state.diagramZoom,
        drawer_width: state.drawerWidth,
        openclaw_pos: state.openclawPos,
      }),
    });
  } catch {
    // Keep UI edits responsive even if the backend is temporarily unavailable.
  }
}

function normalizeEntityPositions() {
  const levelOwners = [];
  state.entities.forEach((entity, index) => {
    entity.x = Number.isFinite(Number(entity.x)) ? Number(entity.x) : 24 + index * 344;
    entity.y = Number.isFinite(Number(entity.y)) ? Number(entity.y) : 36;
    entity.levels ||= [];
    entity.skills ||= [];
    entity.capabilities ||= [];
    entity.memberships = normalizeMemberships(entity.memberships);
    entity.tier = Number.isFinite(Number(entity.tier)) ? Number(entity.tier) : 2;
    entity.max_concurrent = Number.isFinite(Number(entity.max_concurrent)) && entity.max_concurrent > 0 ? Number(entity.max_concurrent) : 1;
    if (entity.role === "skill" || entity.role === "worker") {
      entity.role = "child";
    }
    if (entity.role === "agent") entity.role = "parent";
    if (!ROLE_DEFS[entity.role]) entity.role = "child";
    entity.role_tags = normalizeRoleTags(entity);
    if (!canOwnLevels(entity.role)) entity.levels = [];
    if (!isAgentRole(entity.role)) {
      entity.capabilities = [];
      entity.parentId ||= state.entities.find((item) => isAgentRole(item.role))?.id || "";
    }
    entity.levels = [...new Set(entity.levels)].filter((level) => {
      const conflict = levelOwners.some((owner) => owner.level === level && !canShareLevelOwnership(entity, owner.entity));
      if (conflict) return false;
      levelOwners.push({ level, entity });
      return true;
    });
  });
}

function sharedGroupIds(a, b) {
  const aGroups = new Set(entityMemberships(a).map((membership) => membership.group_id));
  return entityMemberships(b).some((membership) => aGroups.has(membership.group_id));
}

function canShareLevelOwnership(a, b) {
  if (!a || !b || a.id === b.id) return true;
  return sharedGroupIds(a, b);
}

// A membership is { group_id, prio }. Drop malformed entries and any pointing
// at a group that no longer exists (defensive against a deleted group leaving
// orphaned references). Prio is coerced to an integer >= 1.
function normalizeMemberships(memberships) {
  if (!Array.isArray(memberships)) return [];
  const knownGroupIds = new Set((state.groups || []).map((group) => group.id));
  const seen = new Set();
  return memberships
    .filter((m) => m && typeof m.group_id === "string")
    .filter((m) => !knownGroupIds.size || knownGroupIds.has(m.group_id))
    .map((m) => ({ group_id: m.group_id, prio: Math.max(1, parseInt(m.prio, 10) || 1) }))
    .filter((m) => {
      if (seen.has(m.group_id)) return false; // one membership per group
      seen.add(m.group_id);
      return true;
    });
}

function normalizeGroups() {
  if (!Array.isArray(state.groups)) {
    state.groups = [];
    return;
  }
  state.groups.forEach((group, index) => {
    group.id ||= `grp_${Date.now().toString(36)}_${index}`;
    group.name = typeof group.name === "string" && group.name ? group.name : "Nueva jerarquía";
    group.color = typeof group.color === "string" && group.color ? group.color : GROUP_COLOR_PALETTE[index % GROUP_COLOR_PALETTE.length];
    group.x = Number.isFinite(Number(group.x)) ? Number(group.x) : 24 + index * 344;
    group.y = Number.isFinite(Number(group.y)) ? Number(group.y) : 640;
  });
}

function findGroup(id) {
  return (state.groups || []).find((group) => group.id === id);
}

function entityMemberships(entity) {
  return Array.isArray(entity.memberships) ? entity.memberships : [];
}

function providerOptions(current) {
  return [`<option value="">(auto / simulado)</option>`]
    .concat(
      state.catalog.map(
        (p) => `<option value="${p.name}" ${p.name === current ? "selected" : ""}>${escapeHtml(p.label || p.name)}</option>`
      )
    )
    .join("");
}

function renderDiagram() {
  ensureGroups();
  ensureEntities();
  $("#diagramNodes").innerHTML =
    state.entities.map(entityCard).join("") + state.groups.map(groupCard).join("");
  renderOpenClawDiagramCard();
  renderOpenClawDrawerCard();
  bindGroupCardEvents();
  bindDiagramLinkFocus();

  $$("#diagramNodes .entity-model-toggle").forEach((button) =>
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const picker = button.closest(".model-chip-picker");
      const isOpen = picker.classList.contains("open");
      $$(".model-chip-picker.open").forEach((item) => item.classList.remove("open"));
      picker.classList.toggle("open", !isOpen);
    })
  );
  $$("#diagramNodes .entity-model-option").forEach((button) =>
    button.addEventListener("click", (event) => {
      const entity = findEntity(event.currentTarget.dataset.entity);
      if (!entity) return;
      entity.provider = event.currentTarget.dataset.provider;
      const provider = state.catalog.find((item) => item.name === entity.provider);
      entity.name = provider?.label || roleDef(entity.role).label;
      renderDiagram();
      scheduleRoutingSave("Modelo actualizado. Guardando…");
    })
  );
  $$("#diagramNodes .role-tag-toggle").forEach((button) =>
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const picker = button.closest(".role-tag-picker");
      const isOpen = picker.classList.contains("open");
      $$(".role-tag-picker.open").forEach((item) => item.classList.remove("open"));
      picker.classList.toggle("open", !isOpen);
    })
  );
  $$("#diagramNodes .role-tag-option").forEach((button) =>
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const entity = findEntity(event.currentTarget.dataset.entity);
      if (!entity) return;
      if (event.currentTarget.dataset.capability) {
        toggleAgentCapability(entity, event.currentTarget.dataset.capability);
      } else {
        toggleRoleTag(entity, event.currentTarget.dataset.role);
      }
      applyRoleSideEffects(entity);
      renderDiagram();
      scheduleRoutingSave("Etiquetas de rol actualizadas. Guardando…");
    })
  );
  $$("#diagramNodes .role-tag-remove").forEach((button) =>
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const entity = findEntity(event.currentTarget.dataset.entity);
      if (!entity) return;
      removeRoleTag(entity, event.currentTarget.dataset.removeRole);
      applyRoleSideEffects(entity);
      renderDiagram();
      scheduleRoutingSave("Etiqueta de rol eliminada. Guardando…");
    })
  );
  $$("#diagramNodes .entity-parent-link").forEach((sel) =>
    sel.addEventListener("change", (event) => {
      const entity = findEntity(event.target.dataset.entity);
      if (!entity) return;
      entity.parentId = event.target.value;
      renderDiagram();
      scheduleRoutingSave("Conexión actualizada. Guardando…");
    })
  );
  $$("#diagramNodes .entity-target-add").forEach((select) =>
    select.addEventListener("change", (event) => {
      const entity = findEntity(event.currentTarget.dataset.entity);
      const targetId = event.currentTarget.value;
      if (!entity || !targetId) return;
      if (!Array.isArray(entity.target_ids)) entity.target_ids = [];
      if (!entity.target_ids.includes(targetId)) entity.target_ids.push(targetId);
      renderDiagram();
      scheduleRoutingSave("Asociación de supervisión actualizada. Guardando…");
    })
  );
  $$("#diagramNodes [data-remove-target]").forEach((button) =>
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const entity = findEntity(event.currentTarget.dataset.entity);
      if (!entity || !Array.isArray(entity.target_ids)) return;
      entity.target_ids = entity.target_ids.filter((targetId) => targetId !== event.currentTarget.dataset.target);
      renderDiagram();
      scheduleRoutingSave("Asociación de supervisión actualizada. Guardando…");
    })
  );
  $$("#diagramNodes .level-chip").forEach((btn) =>
    btn.addEventListener("click", () => {
      const entity = findEntity(btn.dataset.entity);
      if (!entity) return;
      entity.levels ||= [];
      if (entity.levels.includes(btn.dataset.level)) {
        entity.levels = entity.levels.filter((item) => item !== btn.dataset.level);
      } else {
        state.entities.forEach((item) => {
          if (item.id !== entity.id && !canShareLevelOwnership(entity, item)) {
            item.levels = (item.levels || []).filter((level) => level !== btn.dataset.level);
          }
        });
        entity.levels.push(btn.dataset.level);
      }
      renderDiagram();
      scheduleRoutingSave("Niveles actualizados. Guardando…");
    })
  );
  $$("#diagramNodes .entity-max-concurrent").forEach((input) =>
    input.addEventListener("change", (event) => {
      const entity = findEntity(event.target.dataset.entity);
      if (!entity) return;
      entity.max_concurrent = Math.max(1, parseInt(event.target.value, 10) || 1);
      renderDiagram();
      scheduleRoutingSave("Concurrencia máxima actualizada. Guardando…");
    })
  );
  $$("#diagramNodes .entity-skill").forEach((box) =>
    box.addEventListener("change", (event) => {
      const entity = findEntity(event.target.dataset.entity);
      if (!entity) return;
      entity.skills ||= [];
      if (event.target.checked && !entity.skills.includes(event.target.value)) entity.skills.push(event.target.value);
      if (!event.target.checked) entity.skills = entity.skills.filter((item) => item !== event.target.value);
      state.openSkillPanels.add(entity.id);
      renderDiagram();
      scheduleRoutingSave("Skills actualizadas. Guardando…");
    })
  );
  $$("#diagramNodes .skill-picker").forEach((panel) =>
    panel.addEventListener("toggle", () => {
      if (panel.open) state.openSkillPanels.add(panel.dataset.entity);
      else state.openSkillPanels.delete(panel.dataset.entity);
    })
  );
  $$("#diagramNodes .node-x").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.entities = state.entities.filter((item) => item.id !== btn.dataset.remove);
      ensureEntities();
      renderDiagram();
      scheduleRoutingSave("Entidad eliminada. Guardando…");
    })
  );
  bindCanvasDropTarget();
  bindDiagramDropTargets();
  bindEntityMove();
  applyDiagramZoom();

  scheduleDrawWires();
}

function setDiagramLinkFocus(focus) {
  state.focusedDiagramLink = focus;
  updateDiagramFocusClasses();
  scheduleDrawWires();
}

function clearDiagramLinkFocus(focus) {
  if (!state.focusedDiagramLink) return;
  if (focus && (state.focusedDiagramLink.type !== focus.type || state.focusedDiagramLink.id !== focus.id)) return;
  state.focusedDiagramLink = null;
  updateDiagramFocusClasses();
  scheduleDrawWires();
}

function relatedFocusEntityIds(focus) {
  if (!focus) return new Set();
  if (focus.type === "group") {
    const group = findGroup(focus.id);
    return new Set(group ? groupMembers(group).map(({ entity }) => entity.id) : []);
  }
  const entity = findEntity(focus.id);
  if (!entity) return new Set();
  const ids = new Set([entity.id]);
  (entity.target_ids || []).forEach((id) => ids.add(id));
  state.entities.forEach((item) => {
    if ((item.target_ids || []).includes(entity.id)) ids.add(item.id);
    if (sharedGroupIds(entity, item)) ids.add(item.id);
  });
  return ids;
}

function updateDiagramFocusClasses() {
  const focus = state.focusedDiagramLink;
  const relatedIds = relatedFocusEntityIds(focus);
  const focusColor = focus?.type === "group"
    ? safeColor(findGroup(focus.id)?.color)
    : entityAccent(findEntity(focus?.id || "") || {}).color;
  $$("#diagramNodes .node.entity").forEach((node) => {
    const active = focus?.type === "entity" && node.dataset.entity === focus.id;
    const related = relatedIds.has(node.dataset.entity);
    node.classList.toggle("link-focus", active);
    node.classList.toggle("link-related", related && !active);
    if (related && !active) node.style.setProperty("--link-color", focusColor);
    else node.style.removeProperty("--link-color");
  });
  $$("#diagramNodes .node.group").forEach((node) => {
    node.classList.toggle("link-focus", focus?.type === "group" && node.dataset.group === focus.id);
    if (focus?.type === "group" && node.dataset.group === focus.id) node.style.setProperty("--link-color", focusColor);
    else node.style.removeProperty("--link-color");
  });
}

function bindDiagramLinkFocus() {
  $$("#diagramNodes .node.entity").forEach((node) => {
    const focus = { type: "entity", id: node.dataset.entity };
    node.addEventListener("mouseenter", () => setDiagramLinkFocus(focus));
    node.addEventListener("mouseleave", () => clearDiagramLinkFocus(focus));
    node.addEventListener("focusin", () => setDiagramLinkFocus(focus));
    node.addEventListener("focusout", () => clearDiagramLinkFocus(focus));
  });
  $$("#diagramNodes .node.group").forEach((node) => {
    const focus = { type: "group", id: node.dataset.group };
    node.addEventListener("mouseenter", () => setDiagramLinkFocus(focus));
    node.addEventListener("mouseleave", () => clearDiagramLinkFocus(focus));
    node.addEventListener("focusin", () => setDiagramLinkFocus(focus));
    node.addEventListener("focusout", () => clearDiagramLinkFocus(focus));
  });
  updateDiagramFocusClasses();
}

function entityCard(entity) {
  if (entity.role === "skill" || entity.role === "worker") entity.role = "child";
  if (entity.role === "agent") entity.role = "parent";
  entity.role_tags = normalizeRoleTags(entity);
  const role = roleDef(entity.role);
  const roleLabel = roleLabels(entity).join(" · ");
  const remove = entity.id !== "entity-parent" ? `<button class="node-x" data-remove="${entity.id}" title="Quitar entidad">×</button>` : "";
  const title = entity.provider ? modelTitle(entity.provider) : roleLabel;
  const model = modelMeta(entity);
  const accent = entityAccent(entity);
  const parentOptions = state.entities
    .filter((item) => isAgentRole(item.role) && item.id !== entity.id)
    .map((item) => `<option value="${item.id}" ${entity.parentId === item.id ? "selected" : ""}>${escapeHtml(item.name || "Agent")}</option>`)
    .join("");
  const levelControls =
    canOwnLevels(entity.role)
      ? `<div class="level-picker">
          ${LEVELS.map(([level, short]) => levelChip(entity, level, short)).join("")}
        </div>`
      : "";
  const concurrencyControls =
    canOwnLevels(entity.role)
      ? `<label>Concurrencia máx.
          <input type="number" class="entity-max-concurrent" data-entity="${entity.id}" min="1" step="1" value="${entity.max_concurrent ?? 1}">
        </label>`
      : "";
  // One "Grupo · Prio N" chip per hierarchy-group membership, tinted with that
  // group's color. 0 memberships → no chips (an entity need not join any group).
  const membershipChips = entityMemberships(entity)
    .map((m) => {
      const group = findGroup(m.group_id);
      if (!group) return "";
      return `<span class="prio-chip" style="--prio-color:${escapeHtml(group.color)}" title="${escapeHtml(group.name)} · ${escapeHtml(prioChipLabel(m.prio))}">
          <span class="prio-chip-dot"></span>${escapeHtml(group.name)} · ${escapeHtml(prioChipLabel(m.prio))}
        </span>`;
    })
    .join("");
  const membershipRow = membershipChips ? `<div class="prio-chip-row">${membershipChips}</div>` : "";
  const connection =
    canConnectToAgent(entity.role)
      ? `<label>Conexión padre
          <select class="entity-parent-link" data-entity="${entity.id}">
            <option value="">Sin conexión</option>${parentOptions}
          </select>
        </label>`
      : "";
  // Guardian/Validator are support tags (role_tags), not primary roles — this
  // is the "which elements am I supervising/validating" association, distinct
  // from parent/child hierarchy. Multi-target (1-to-N): a validator can watch
  // many entities, so this is a checkbox list, not a single select.
  const targetLabels = [];
  if (entity.role_tags.includes("guardian")) targetLabels.push("Supervisa a");
  if (entity.role_tags.includes("validator")) targetLabels.push("Valida a");
  const targetIds = Array.isArray(entity.target_ids) ? entity.target_ids : [];
  const eligibleTargets = state.entities.filter((item) => item.id !== entity.id && !isAgentRole(item.role));
  const selectedTargetChips = targetIds
    .map((targetId) => {
      const target = findEntity(targetId);
      if (!target) return "";
      return `<span class="entity-target-chip">
          <span>${escapeHtml(target.name || roleDef(target.role).label)}</span>
          <button type="button" data-entity="${entity.id}" data-target="${target.id}" data-remove-target title="Quitar objetivo">×</button>
        </span>`;
    })
    .join("");
  const targetOptions = eligibleTargets
    .filter((item) => !targetIds.includes(item.id))
    .map((item) => `<option value="${item.id}">${escapeHtml(item.name || roleDef(item.role).label)}</option>`)
    .join("");
  const supervises = targetLabels.length
    ? `<div class="entity-target-field">
        <div class="role-tag-label">${escapeHtml(targetLabels.join(" / "))}</div>
        <div class="entity-target-tags">${selectedTargetChips || '<small class="entity-target-empty">Sin objetivos seleccionados</small>'}</div>
        <select class="entity-target-add" data-entity="${entity.id}" ${targetOptions ? "" : "disabled"}>
          <option value="">+ Añadir objetivo…</option>
          ${targetOptions}
        </select>
      </div>`
    : "";
  const skills = skillPicker(entity);
  const classRole = isAgentRole(entity.role) ? "parent" : "child";
  return `<div class="node entity ${classRole} role-${escapeHtml(entity.role)}" data-entity="${entity.id}">
      <div class="drop-hint">Suelta modelo aquí</div>
      ${remove}
      <div class="node-port" title="Punto de conexión"></div>
      <div class="role">Entidad · ${roleLabel}</div>
      <div class="node-title">${escapeHtml(title)}</div>
      <div class="model-meta">${model}</div>
      ${membershipRow}
      <div class="entity-controls">
        ${roleTagPicker(entity)}
        ${connection}
        ${supervises}
        ${levelControls}
        ${concurrencyControls}
        ${skills}
      </div>
    </div>`.replace('<div class="node entity', `<div style="left:${screenX(entity.x || 0)}px; top:${screenY(entity.y || 0)}px; --entity-accent:${accent.color}; --entity-ink:${accent.ink}" class="node entity`);
}

function roleDef(role) {
  return ROLE_DEFS[role] || ROLE_DEFS.child;
}

function roleLabels(entity) {
  return normalizeRoleTags(entity).map((role) => roleDef(role).label);
}

function normalizeRoleTags(entity) {
  let tags = Array.isArray(entity.role_tags) ? entity.role_tags.filter((role) => ROLE_DEFS[role]) : [];
  const legacyRole = entity.role === "agent" ? "parent" : entity.role === "worker" ? "child" : entity.role;
  if (!tags.length && ROLE_DEFS[legacyRole]) tags = [legacyRole];

  const primary = tags.find((role) => PRIMARY_ROLES.includes(role)) || (PRIMARY_ROLES.includes(legacyRole) ? legacyRole : "child");
  const support = [...new Set(tags.filter((role) => SUPPORT_ROLES.includes(role)))];
  // Hierarchy is no longer a role tag — role_tags is just one primary + support
  // tags now. Tier/prio lives in entity.memberships (state.groups).
  const normalized = [primary, ...support];
  entity.role = primary;
  entity.role_tags = normalized;
  syncAgentCapabilities(entity);
  return normalized;
}

function toggleRoleTag(entity, role) {
  if (!ROLE_DEFS[role]) return;
  const tags = new Set(normalizeRoleTags(entity));
  if (PRIMARY_ROLES.includes(role)) {
    PRIMARY_ROLES.forEach((item) => tags.delete(item));
    tags.add(role);
  } else if (tags.has(role)) {
    tags.delete(role);
  } else {
    tags.add(role);
  }
  entity.role_tags = [...tags];
  normalizeRoleTags(entity);
}

function removeRoleTag(entity, role) {
  const capabilityNames = new Set(AGENT_CAPABILITY_DEFS.map(([name]) => name));
  if (capabilityNames.has(role)) {
    entity.capabilities_touched = true;
    entity.capabilities = (entity.capabilities || []).filter((name) => name !== role);
    return;
  }
  if (!ROLE_DEFS[role]) return;
  const tags = new Set(normalizeRoleTags(entity));
  tags.delete(role);
  if (PRIMARY_ROLES.includes(role) && ![...tags].some((item) => PRIMARY_ROLES.includes(item))) {
    tags.add("child");
    entity.role = "child";
  }
  entity.role_tags = [...tags];
  normalizeRoleTags(entity);
}

function syncAgentCapabilities(entity) {
  const known = new Set(AGENT_CAPABILITY_DEFS.map(([name]) => name));
  if (!isAgentRole(entity.role)) {
    entity.capabilities = [];
    return [];
  }
  const selected = new Set((entity.capabilities || []).filter((name) => known.has(name)));
  if (!entity.capabilities_touched && !entity.capabilities?.length) {
    AGENT_INTERNAL_CAPABILITIES.forEach((name) => selected.add(name));
  }
  entity.capabilities = [...selected];
  return entity.capabilities;
}

function toggleAgentCapability(entity, capability) {
  if (!isAgentRole(entity.role)) return;
  const known = new Set(AGENT_CAPABILITY_DEFS.map(([name]) => name));
  if (!known.has(capability)) return;
  entity.capabilities_touched = true;
  const selected = new Set(syncAgentCapabilities(entity));
  if (selected.has(capability)) selected.delete(capability);
  else selected.add(capability);
  entity.capabilities = [...selected];
  syncAgentCapabilities(entity);
}

function applyRoleSideEffects(entity) {
  normalizeRoleTags(entity);
  if (isAgentRole(entity.role)) {
    syncAgentCapabilities(entity);
    state.entities.forEach((item) => {
      if (item.id !== entity.id && isAgentRole(item.role)) {
        item.role = "child";
        item.role_tags = ["child", ...(item.role_tags || []).filter((role) => SUPPORT_ROLES.includes(role))];
        normalizeRoleTags(item);
      }
    });
    entity.parentId = "";
  } else {
    entity.parentId ||= state.entities.find((item) => isAgentRole(item.role))?.id || "";
    entity.capabilities = [];
  }
  if (!canOwnLevels(entity.role)) entity.levels = [];
}

function roleOptions(current) {
  return Object.entries(ROLE_DEFS)
    .map(([value, role]) => `<option value="${value}" ${value === current ? "selected" : ""}>${role.label}</option>`)
    .join("");
}

function roleTagPicker(entity) {
  const tags = normalizeRoleTags(entity);
  const selected = new Set(tags);
  const capabilities = isAgentRole(entity.role) ? syncAgentCapabilities(entity) : [];
  const chips = [
    ...tags.map((role) => roleChip(entity, role, roleDef(role).label, `role-chip-${roleDef(role).restriction.toLowerCase()}`)),
    ...capabilities.map((name) => roleChip(entity, name, name, "role-chip-cap")),
  ].join("");
  const groups = ROLE_GROUPS.map((group) => {
    const roles = Object.entries(ROLE_DEFS).filter(([, def]) => def.group === group);
    return `<div class="role-tag-group">
      <div class="role-tag-group-title">${escapeHtml(group)}</div>
      ${roles.map(([value, def]) => roleTagOption(entity, value, def, selected)).join("")}
    </div>`;
  }).join("") + capabilityTagGroup(entity, new Set(capabilities));
  const summary = roleSummary(entity);
  return `<div class="role-tag-field">
      <div class="role-tag-label">Rol</div>
      <div class="role-tag-picker">
        <button type="button" class="role-tag-toggle" data-entity="${entity.id}">
          <span class="role-chip-list">${chips}</span>
          <span class="role-tag-caret"></span>
        </button>
        <div class="role-tag-menu">${groups}</div>
      </div>
      <small>${escapeHtml(summary)}</small>
    </div>`;
}

function roleChip(entity, value, label, className) {
  return `<span class="role-chip ${className}">
    <span>${escapeHtml(label)}</span>
    <span class="role-tag-remove" role="button" tabindex="0" data-entity="${escapeHtml(entity.id)}" data-remove-role="${escapeHtml(value)}" title="Quitar ${escapeHtml(label)}">×</span>
  </span>`;
}

function capabilityTagGroup(entity, selected) {
  if (!isAgentRole(entity.role)) return "";
  const options = AGENT_CAPABILITY_DEFS.map(([name, group, description]) =>
    capabilityTagOption(entity, name, group, description, selected)
  ).join("");
  return `<div class="role-tag-group role-tag-capabilities">
      <div class="role-tag-group-title">Capacidades Agent</div>
      ${options}
    </div>`;
}

function capabilityTagOption(entity, name, group, description, selected) {
  const isSelected = selected.has(name);
  return `<button type="button" class="role-tag-option capability ${isSelected ? "selected" : ""}" data-entity="${entity.id}" data-capability="${escapeHtml(name)}" title="${escapeHtml(description)}">
      <span class="role-option-check">${isSelected ? "✓" : ""}</span>
      <span><b>${escapeHtml(name)}</b><small>${escapeHtml(group)}</small></span>
    </button>`;
}

function roleTagOption(entity, value, def, selected) {
  const isSelected = selected.has(value);
  const isPrimary = PRIMARY_ROLES.includes(value);
  const exclusiveGroup = isPrimary ? PRIMARY_ROLES : null;
  const willReplace = exclusiveGroup ? [...selected].some((role) => exclusiveGroup.includes(role) && role !== value) : false;
  const note = isPrimary ? "primario" : def.restriction === "R2" ? "auxiliar" : "estado";
  // Autoridad is an exclusive (radio) group: an entity always needs exactly one
  // primary role, so the active option can't be unchecked, only replaced by
  // picking another one in the same group. Rendering it as a disabled radio dot
  // instead of a live checkbox avoids the silent no-op click a checkmark implies.
  const locked = !!(exclusiveGroup && isSelected);
  const indicator = exclusiveGroup ? (isSelected ? "●" : "") : (isSelected ? "✓" : "");
  return `<button type="button" class="role-tag-option ${isSelected ? "selected" : ""} ${willReplace ? "will-replace" : ""} ${exclusiveGroup ? "radio" : ""} ${locked ? "locked" : ""}" data-entity="${entity.id}" data-role="${value}" ${locked ? `disabled title="Elige otra opción de este grupo para reemplazarla"` : ""}>
      <span class="role-option-check">${indicator}</span>
      <span><b>${escapeHtml(def.label)}</b><small>${escapeHtml(def.restriction)} · ${note}</small></span>
    </button>`;
}

function roleSummary(entity) {
  const tags = normalizeRoleTags(entity);
  const capabilities = isAgentRole(entity.role) ? syncAgentCapabilities(entity) : [];
  const hasAgent = tags.includes("parent");
  const hasWorker = tags.includes("child");
  const hasBackup = tags.includes("backup");
  const supports = tags.filter((role) => SUPPORT_ROLES.includes(role)).map((role) => roleDef(role).label);
  if (hasAgent) {
    const capSummary = capabilities.length ? ` Capacidades: ${capabilities.join(", ")}.` : "";
    return `R0 autoridad global.${supports.length ? ` Complementos: ${supports.join(", ")}.` : ""}${capSummary}`;
  }
  if (hasBackup) return `R1 fallback. Reclama niveles solo cuando actúa como reserva o promoción controlada.`;
  if (hasWorker) return `R1 ejecución. ${supports.length ? `Con etiquetas auxiliares: ${supports.join(", ")}.` : "Puede recibir niveles N1-N5."}`;
  return supports.length ? `R2/R3 soporte sin ownership de niveles: ${supports.join(", ")}.` : "Selecciona una etiqueta primaria.";
}

function isAgentRole(role) {
  return role === "parent" || role === "agent";
}

function canOwnLevels(role) {
  return !!roleDef(role).canOwnLevels;
}

function canConnectToAgent(role) {
  return !!roleDef(role).canConnectToAgent;
}

function findEntity(id) {
  return state.entities.find((item) => item.id === id);
}

function modelTitle(providerName) {
  const provider = state.catalog.find((p) => p.name === providerName);
  return provider?.label || providerName || "Modelo";
}

function entityAccent(entity) {
  const key = `${entity.provider || entity.role || ""}`.toLowerCase();
  if (isAgentRole(entity.role)) return { color: "var(--accent)", ink: "var(--accent-ink)" };
  if (key.includes("backup")) return { color: "#f2c84b", ink: "#201600" };
  if (key.includes("guardian")) return { color: "#b9a7ff", ink: "#15102b" };
  if (key.includes("validator")) return { color: "#ffb25f", ink: "#261303" };
  if (key.includes("memory")) return { color: "#a8ddff", ink: "#061929" };
  if (key.includes("monitor")) return { color: "#f08cc3", ink: "#250719" };
  if (key.includes("google") || key.includes("gemini")) return { color: "#65d6ad", ink: "#08241b" };
  if (key.includes("groq")) return { color: "#7cb7ff", ink: "#071827" };
  if (key.includes("openai")) return { color: "#69d2ff", ink: "#071923" };
  if (key.includes("anthropic") || key.includes("claude")) return { color: "#d5a36a", ink: "#251507" };
  if (key.includes("mistral")) return { color: "#ff9c74", ink: "#2a1009" };
  if (key.includes("ollama")) return { color: "#8ddf8f", ink: "#071f0b" };
  return { color: "var(--accent)", ink: "var(--accent-ink)" };
}

function modelMeta(entity) {
  const providerName = entity.provider || "";
  const provider = state.catalog.find((p) => p.name === providerName);
  const label = providerName ? provider?.label || providerName : "sin asignar";
  const backend = provider?.backend || "provider";
  const options = [`<button class="entity-model-option ${!providerName ? "active" : ""}" data-entity="${entity.id}" data-provider="">(auto / simulado)</button>`]
    .concat(
      state.catalog.map(
        (p) =>
          `<button class="entity-model-option ${p.name === providerName ? "active" : ""}" data-entity="${entity.id}" data-provider="${escapeHtml(p.name)}">${escapeHtml(p.label || p.name)}</button>`
      )
    )
    .join("");
  return `<div class="model-chip-picker">
      <button type="button" class="model-chip entity-model-toggle ${providerName ? "" : "ghost"}" title="Cambiar modelo">
        <small>modelo</small><b>${escapeHtml(label)}</b><small>${escapeHtml(providerName ? backend : "auto")}</small>
      </button>
      <div class="model-menu">${options}</div>
    </div>`;
}

function relatedEntityIds(entity) {
  if (isAgentRole(entity.role)) {
    return state.entities.filter((item) => item.parentId === entity.id || item.id === entity.id).map((item) => item.id);
  }
  if (canConnectToAgent(entity.role) && entity.parentId) {
    return state.entities.filter((item) => item.id === entity.parentId || item.parentId === entity.parentId).map((item) => item.id);
  }
  return [entity.id];
}

function conflictingLevelOwner(entity, level) {
  return state.entities.find(
    (item) =>
      item.id !== entity.id &&
      canOwnLevels(item.role) &&
      item.levels?.includes(level) &&
      !canShareLevelOwnership(entity, item)
  );
}

function levelChip(entity, level, short) {
  const owner = conflictingLevelOwner(entity, level);
  const selected = entity.levels?.includes(level);
  const occupied = !!owner;
  const ownerAccent = owner ? entityAccent(owner) : entityAccent(entity);
  const ownerName = owner ? owner.name || modelTitle(owner.provider) || "otra entidad" : "";
  return `<button class="level-chip ${selected ? "on" : ""} ${occupied ? "occupied" : ""}" style="--level-accent:${ownerAccent.color}; --level-ink:${ownerAccent.ink}" data-entity="${entity.id}" data-level="${level}" title="${occupied ? `Mover desde ${ownerName}` : LEVEL_FULL[level]}">
      <span>${short}</span><small>${occupied ? ownerName : LEVEL_FULL[level].replace(`${short} · `, "")}</small>
    </button>`;
}

function skillPicker(entity) {
  if (!state.skills.length) return "";
  const selected = new Set(entity.skills || []);
  const open = state.openSkillPanels.has(entity.id) ? "open" : "";
  return `<details class="skill-picker" data-entity="${entity.id}" ${open}>
      <summary>Skills <span>${selected.size}</span></summary>
      <div class="skill-options">
        ${state.skills
          .map(
            (skill) => `<label><input class="entity-skill" data-entity="${entity.id}" type="checkbox" value="${escapeHtml(skill.name)}" ${selected.has(skill.name) ? "checked" : ""}/> ${escapeHtml(skill.name)}</label>`
          )
          .join("")}
      </div>
    </details>`;
}

function assignProviderToNode(target, providerName) {
  const entity = state.entities.find((item) => item.id === target);
  if (entity) {
    const provider = state.catalog.find((item) => item.name === providerName);
    entity.provider = providerName;
    entity.name = provider?.label || providerName || entity.name;
  }
  renderDiagram();
  scheduleRoutingSave("Modelo conectado. Guardando…");
}

function addEntityFromProvider(providerName, role = "child", position = null) {
  const provider = state.catalog.find((item) => item.name === providerName);
  const nextIndex = state.entities.length;
  const entity = {
    id: `entity-${Date.now().toString(36)}`,
    name: provider?.label || providerName,
    role,
    provider: providerName,
    parentId: canConnectToAgent(role) ? state.entities.find((item) => isAgentRole(item.role))?.id || "" : "",
    levels: [],
    skills: [],
    capabilities: [],
    x: position?.x ?? 360 + nextIndex * 28,
    y: position?.y ?? 48 + nextIndex * 28,
  };
  state.entities.push(entity);
  renderDiagram();
  scheduleRoutingSave("Entidad añadida. Guardando…");
  return entity;
}

function diagramPointFromClient(clientX, clientY) {
  const diagram = $("#diagram");
  const rect = diagram.getBoundingClientRect();
  return {
    x: (clientX - rect.left + diagram.scrollLeft) / state.diagramZoom - DIAGRAM_PAD_X - 120,
    y: (clientY - rect.top + diagram.scrollTop) / state.diagramZoom - DIAGRAM_PAD_Y - 30,
  };
}

function scaled(value) {
  return Math.round((Number(value) || 0) * state.diagramZoom);
}

function screenX(value) {
  return scaled(DIAGRAM_PAD_X + (Number(value) || 0));
}

function screenY(value) {
  return scaled(DIAGRAM_PAD_Y + (Number(value) || 0));
}

function clampZoom(value) {
  return Math.min(1.65, Math.max(0.55, value));
}

function applyDiagramZoom() {
  const diagram = $("#diagram");
  const layer = $("#diagramLayer");
  if (!diagram || !layer) return;
  const zoom = state.diagramZoom;
  diagram.style.setProperty("--diagram-zoom", String(zoom));
  layer.style.width = `${scaled(DIAGRAM_BASE_WIDTH + DIAGRAM_PAD_X * 2)}px`;
  layer.style.height = `${scaled(DIAGRAM_BASE_HEIGHT + DIAGRAM_PAD_Y * 2)}px`;
  $$("#diagramNodes .node.entity").forEach((node) => {
    const entity = findEntity(node.dataset.entity);
    if (!entity) return;
    node.style.left = `${screenX(entity.x)}px`;
    node.style.top = `${screenY(entity.y)}px`;
  });
  $$("#diagramNodes .node.group").forEach((node) => {
    const group = findGroup(node.dataset.group);
    if (!group) return;
    node.style.left = `${screenX(group.x)}px`;
    node.style.top = `${screenY(group.y)}px`;
  });
  if (!state.diagramCentered && $("#view-decision").classList.contains("active")) {
    diagram.scrollLeft = Math.max(0, screenX(0) - Math.round(diagram.clientWidth * 0.18));
    diagram.scrollTop = Math.max(0, screenY(0) - Math.round(diagram.clientHeight * 0.18));
    state.diagramCentered = true;
  }
  scheduleDrawWires();
}

function bindCanvasDropTarget() {
  const diagram = $("#diagram");
  if (!diagram) return;
  if (diagram.dataset.dropBound) return;
  diagram.dataset.dropBound = "1";
  diagram.addEventListener("dragover", (event) => event.preventDefault());
  diagram.addEventListener("drop", (event) => {
    if (event.target.closest(".node")) return;
    event.preventDefault();
    const provider = event.dataTransfer.getData("text/provider");
    if (provider) addEntityFromProvider(provider, "child", diagramPointFromClient(event.clientX, event.clientY));
  });
}

function bindDiagramDropTargets() {
  state.entities.forEach((entity) => {
    const node = $(`.node.entity[data-entity="${entity.id}"]`);
    if (!node) return;
    node.addEventListener("dragover", (event) => {
      event.preventDefault();
      node.classList.add("drop-ready");
    });
    node.addEventListener("dragleave", () => node.classList.remove("drop-ready"));
    node.addEventListener("drop", (event) => {
      event.preventDefault();
      node.classList.remove("drop-ready");
      const provider = event.dataTransfer.getData("text/provider");
      if (provider) assignProviderToNode(entity.id, provider);
    });
  });
}

function scheduleDrawWires() {
  if (state.draggingDiagramNode) return;
  if (wiresFrame !== null) return;
  wiresFrame = requestAnimationFrame(() => {
    wiresFrame = null;
    drawWires();
  });
}

function setDiagramNodeDragging(on) {
  state.draggingDiagramNode = on;
  $("#diagram")?.classList.toggle("node-dragging", on);
  if (!on) scheduleDrawWires();
}

function drawWires() {
  const svg = $("#wires");
  const parent = $(".node.entity.parent");
  if (svg) svg.innerHTML = "";
  if (!svg || !parent) return;
  $$("#diagramNodes .node.entity").forEach((node) => {
    node.style.removeProperty("--port-x");
    node.style.removeProperty("--port-y");
  });
  const layer = $("#diagramLayer");
  if (layer) {
    svg.setAttribute("width", String(layer.offsetWidth));
    svg.setAttribute("height", String(layer.offsetHeight));
    svg.setAttribute("viewBox", `0 0 ${layer.offsetWidth} ${layer.offsetHeight}`);
  }
  const rootStyle = getComputedStyle(document.documentElement);
  const accent = rootStyle.getPropertyValue("--diagram-wire").trim() || rootStyle.getPropertyValue("--accent").trim();
  const opacity = rootStyle.getPropertyValue("--diagram-wire-opacity").trim() || "0.62";
  const focus = state.focusedDiagramLink;
  const isFocusedEntity = (id) => focus?.type === "entity" && focus.id === id;
  const isFocusedGroup = (id) => focus?.type === "group" && focus.id === id;
  const hierarchyWires = $$("#diagramNodes .node.entity.child")
    .filter((node) => node.dataset.entity && findEntity(node.dataset.entity)?.parentId)
    .map((node) => {
      const route = connectionRoute(parent, node);
      setNodePort(parent, route.from);
      setNodePort(node, route.to);
      return `<path d="${wirePath(route.start, route.end, route.from, route.to)}" fill="none" stroke="${accent}" stroke-width="1.5" opacity="${opacity}"/>`;
    })
    .join("");

  // Guardian/Validator supervision wires: dashed, role-accent colored, drawn
  // directly between the two specific nodes (not routed through the root) so
  // they read as "supervision/validation," not hierarchy.
  let supportWires = "";
  state.entities.forEach((entity) => {
    const targetIds = Array.isArray(entity.target_ids) ? entity.target_ids : [];
    if (!targetIds.length) return;
    const isGuardian = (entity.role_tags || []).includes("guardian");
    const isValidator = (entity.role_tags || []).includes("validator");
    if (!isGuardian && !isValidator) return;
    const fromNode = $(`.node.entity[data-entity="${entity.id}"]`);
    if (!fromNode) return;
    const color = isGuardian ? "#b9a7ff" : "#5bbcff";
    targetIds.forEach((targetId) => {
      if (!isFocusedEntity(entity.id) && !isFocusedEntity(targetId)) return;
      const toNode = $(`.node.entity[data-entity="${targetId}"]`);
      if (!toNode) return;
      const route = connectionRoute(fromNode, toNode);
      supportWires += `<path class="wire-context wire-support" d="${wirePath(route.start, route.end, route.from, route.to)}" fill="none" stroke="${color}" stroke-width="1.8" stroke-dasharray="4,5" opacity="0.82"/>`;
    });
  });

  // Hierarchy-group wires: dashed line from each group card to each of its
  // member entities, colored with that group's custom color (mirrors the
  // guardian/validator dashed pattern but per-group tinted).
  let groupWires = "";
  (state.groups || []).forEach((group) => {
    const fromNode = $(`.node.group[data-group="${group.id}"]`);
    if (!fromNode) return;
    groupMembers(group).forEach(({ entity }) => {
      if (!isFocusedGroup(group.id) && !isFocusedEntity(entity.id)) return;
      const toNode = $(`.node.entity[data-entity="${entity.id}"]`);
      if (!toNode) return;
      const route = connectionRoute(fromNode, toNode);
      groupWires += `<path class="wire-context wire-group" d="${wirePath(route.start, route.end, route.from, route.to)}" fill="none" stroke="${safeColor(group.color)}" stroke-width="1.9" stroke-dasharray="6,5" opacity="0.84"/>`;
    });
  });

  // Third wire type: OpenClaw's link to the root Agent — dotted and in its own
  // color, so it reads as "connected to the system" without looking like a
  // routing/hierarchy relationship.
  let openclawWire = "";
  const openclawCard = $("#openclawDiagramCard");
  if (openclawCard) {
    const route = connectionRoute(openclawCard, parent);
    openclawWire = `<path d="${wirePath(route.start, route.end, route.from, route.to)}" fill="none" stroke="${OPENCLAW_NODE_ACCENT}" stroke-width="1.3" stroke-dasharray="2,5" opacity="0.55"/>`;
  }

  svg.innerHTML = hierarchyWires + supportWires + groupWires + openclawWire;
}

function nodeBox(node) {
  const zoom = state.diagramZoom;
  return {
    left: node.offsetLeft,
    top: node.offsetTop,
    width: node.offsetWidth * zoom,
    height: node.offsetHeight * zoom,
  };
}

function sidePoint(box, side) {
  if (side === "left") return { x: box.left, y: box.top + box.height / 2 };
  if (side === "right") return { x: box.left + box.width, y: box.top + box.height / 2 };
  if (side === "top") return { x: box.left + box.width / 2, y: box.top };
  return { x: box.left + box.width / 2, y: box.top + box.height };
}

function connectionRoute(fromNode, toNode) {
  const fromBox = nodeBox(fromNode);
  const toBox = nodeBox(toNode);
  const fromCenter = { x: fromBox.left + fromBox.width / 2, y: fromBox.top + fromBox.height / 2 };
  const toCenter = { x: toBox.left + toBox.width / 2, y: toBox.top + toBox.height / 2 };
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const fromSide = horizontal ? (dx >= 0 ? "right" : "left") : dy >= 0 ? "bottom" : "top";
  const toSide = horizontal ? (dx >= 0 ? "left" : "right") : dy >= 0 ? "top" : "bottom";
  return { from: fromSide, to: toSide, start: sidePoint(fromBox, fromSide), end: sidePoint(toBox, toSide) };
}

function setNodePort(node, side) {
  const point = sidePoint({ left: 0, top: 0, width: node.offsetWidth, height: node.offsetHeight }, side);
  node.style.setProperty("--port-x", `${point.x}px`);
  node.style.setProperty("--port-y", `${point.y}px`);
}

function wirePath(start, end, fromSide, toSide) {
  const gap = Math.max(58, Math.min(180, Math.hypot(end.x - start.x, end.y - start.y) * 0.32));
  const c1 = controlPoint(start, fromSide, gap);
  const c2 = controlPoint(end, toSide, gap);
  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
}

function controlPoint(point, side, distance) {
  if (side === "left") return { x: point.x - distance, y: point.y };
  if (side === "right") return { x: point.x + distance, y: point.y };
  if (side === "top") return { x: point.x, y: point.y - distance };
  return { x: point.x, y: point.y + distance };
}

const OPENCLAW_NODE_ACCENT = "#3ecf9a"; // teal — visually distinct from routing-entity accents
const OPENCLAW_POS_KEY = "karajan-openclaw-pos";

function readOpenClawPos() {
  try {
    const stored = JSON.parse(localStorage.getItem(OPENCLAW_POS_KEY) || "null");
    if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) return stored;
  } catch {
    /* fall through to default */
  }
  return { x: -300, y: 40 };
}

// OpenClaw isn't a RoutingEntity (it doesn't classify/execute subtasks), but the
// user wants it shown as part of the architecture, styled like the routing
// entity cards (compact, summarized) and visibly connected to the main system —
// signaling "additional integration," not a hidden extra. It's a plain status
// card (no click-to-expand) that can be dragged around like any other node;
// activation itself lives in the "Arquitectura activa" side drawer
// (renderOpenClawDrawerCard). A dedicated dashed wire to the root Agent is
// drawn in drawWires().
function openClawCardBody(detail, dotClass) {
  return `
    <div class="node-port" title="Punto de conexión"></div>
    <div class="role">Integración adicional</div>
    <div class="node-title">OpenClaw</div>
    <div class="model-meta"><span class="status-dot ${dotClass}"></span> ${escapeHtml(detail)}</div>`;
}

function renderOpenClawDiagramCard() {
  const card = $("#openclawDiagramCard");
  if (!card) return;
  card.style.left = `${screenX(state.openclawPos.x)}px`;
  card.style.top = `${screenY(state.openclawPos.y)}px`;
  card.style.setProperty("--entity-accent", OPENCLAW_NODE_ACCENT);
  card.style.setProperty("--entity-ink", "#04231a");
  card.innerHTML = openClawCardBody("comprobando…", "warn");
  bindOpenClawMove();
  api("/integrations/openclaw/status")
    .then((status) => {
      const dot = status.ready ? "ok" : status.cli_available ? "warn" : "bad";
      const detail = status.ready ? "activo" : status.cli_available ? "sin iniciar" : "CLI no encontrado";
      card.innerHTML = openClawCardBody(detail, dot);
    })
    .catch(() => {
      card.innerHTML = openClawCardBody("sin datos", "bad");
    });
}

let activeOpenclawMove = null;

function bindOpenClawMove() {
  const card = $("#openclawDiagramCard");
  if (!card || card.dataset.dragBound) return;
  card.dataset.dragBound = "1";
  card.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    activeOpenclawMove = {
      originX: state.openclawPos.x,
      originY: state.openclawPos.y,
      startX: event.clientX,
      startY: event.clientY,
    };
    card.classList.add("moving");
    document.body.classList.add("moving-node");
    setDiagramNodeDragging(true);
    document.addEventListener("pointermove", onOpenClawMove);
    document.addEventListener("pointerup", stopOpenClawMove, { once: true });
  });
}

function onOpenClawMove(event) {
  if (!activeOpenclawMove) return;
  const card = $("#openclawDiagramCard");
  if (!card) return;
  state.openclawPos = {
    x: activeOpenclawMove.originX + (event.clientX - activeOpenclawMove.startX) / state.diagramZoom,
    y: activeOpenclawMove.originY + (event.clientY - activeOpenclawMove.startY) / state.diagramZoom,
  };
  card.style.left = `${screenX(state.openclawPos.x)}px`;
  card.style.top = `${screenY(state.openclawPos.y)}px`;
}

function stopOpenClawMove() {
  $("#openclawDiagramCard")?.classList.remove("moving");
  activeOpenclawMove = null;
  document.body.classList.remove("moving-node");
  document.removeEventListener("pointermove", onOpenClawMove);
  setDiagramNodeDragging(false);
  localStorage.setItem(OPENCLAW_POS_KEY, JSON.stringify(state.openclawPos));
  scheduleRoutingSave("Posición de OpenClaw actualizada. Guardando…");
}

// "Arquitectura activa" side drawer entry point for OpenClaw — the diagram
// card itself is now a plain draggable status indicator; the actual
// activation UI (openOpenClawPanel) is only reachable from here.
function renderOpenClawDrawerCard() {
  const target = $("#openclawDrawerCard");
  if (!target) return;
  target.innerHTML = `
    <div class="openclaw-drawer-card">
      <div class="openclaw-drawer-info">
        <span class="status-dot warn"></span>
        <b>OpenClaw</b>
        <span class="openclaw-drawer-detail">comprobando…</span>
      </div>
      <button type="button" class="openclaw-activate-btn" data-openclaw-open>Configurar</button>
    </div>`;
  target.querySelector("[data-openclaw-open]")?.addEventListener("click", () => openOpenClawPanel());
  api("/integrations/openclaw/status")
    .then((status) => {
      const dot = status.ready ? "ok" : status.cli_available ? "warn" : "bad";
      const detail = status.ready ? "Activo" : status.cli_available ? "CLI listo, sin iniciar" : "CLI no encontrado";
      const dotEl = target.querySelector(".status-dot");
      const detailEl = target.querySelector(".openclaw-drawer-detail");
      if (dotEl) dotEl.className = `status-dot ${dot}`;
      if (detailEl) detailEl.textContent = detail;
    })
    .catch(() => {
      const detailEl = target.querySelector(".openclaw-drawer-detail");
      if (detailEl) detailEl.textContent = "sin datos";
    });
}

function bindEntityMove() {
  $$("#diagramNodes .node.entity").forEach((node) => {
    node.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest("button, input, select, label, summary, details, .node-x, .level-chip")) return;
      const entity = findEntity(node.dataset.entity);
      if (!entity) return;
      event.preventDefault();
      activeEntityMove = {
        id: entity.id,
        node,
        originX: entity.x || 0,
        originY: entity.y || 0,
        startX: event.clientX,
        startY: event.clientY,
      };
      node.classList.add("moving");
      document.body.classList.add("moving-node");
      setDiagramNodeDragging(true);
      document.addEventListener("pointermove", onEntityMove);
      document.addEventListener("pointerup", stopEntityMove, { once: true });
    });
  });
}

function onEntityMove(event) {
  if (!activeEntityMove) return;
  const entity = findEntity(activeEntityMove.id);
  if (!entity) return;
  entity.x = activeEntityMove.originX + (event.clientX - activeEntityMove.startX) / state.diagramZoom;
  entity.y = activeEntityMove.originY + (event.clientY - activeEntityMove.startY) / state.diagramZoom;
  activeEntityMove.node.style.left = `${screenX(entity.x)}px`;
  activeEntityMove.node.style.top = `${screenY(entity.y)}px`;
}

function stopEntityMove() {
  if (activeEntityMove) activeEntityMove.node.classList.remove("moving");
  activeEntityMove = null;
  document.body.classList.remove("moving-node");
  document.removeEventListener("pointermove", onEntityMove);
  setDiagramNodeDragging(false);
  persistEntityState();
  scheduleRoutingSave("Posición actualizada. Guardando…");
}

// ---- HIERARCHY GROUPS (Prio) -----------------------------------------------
// Draggable cards on the Decisión canvas (same visual language as entity cards)
// representing a named/colored Prio hierarchy. Entities join via
// entity.memberships; within one group Prio numbers are unique (enforced here in
// the UI by locking taken values, and server-side by RoutingLayout's validator).

function groupMembers(group) {
  // Entities that carry a membership pointing at this group, each paired with
  // the prio it holds in this group.
  return state.entities
    .map((entity) => {
      const membership = entityMemberships(entity).find((m) => m.group_id === group.id);
      return membership ? { entity, prio: membership.prio } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.prio - b.prio);
}

function nextFreePrio(group) {
  const taken = new Set(groupMembers(group).map((m) => m.prio));
  let n = 1;
  while (taken.has(n)) n += 1;
  return n;
}

function createGroup() {
  ensureGroups();
  const diagram = $("#diagram");
  // Drop the new card somewhere visible near the current viewport, offset from
  // any existing group so two clicks don't stack them exactly.
  let x = 40 + state.groups.length * 40;
  let y = 620 + state.groups.length * 32;
  if (diagram) {
    const point = diagramPointFromClient(
      diagram.getBoundingClientRect().left + diagram.clientWidth * 0.28,
      diagram.getBoundingClientRect().top + diagram.clientHeight * 0.5
    );
    // Cascade new cards clearly apart (they overlap badly if spawned on top of
    // each other); they remain freely draggable afterwards.
    x = point.x + state.groups.length * 200;
    y = point.y + (state.groups.length % 2) * 60;
  }
  const group = {
    id: `grp_${Date.now().toString(36)}`,
    name: "Nueva jerarquía",
    color: nextGroupColor(),
    x,
    y,
  };
  state.groups.push(group);
  renderDiagram();
  scheduleRoutingSave("Jerarquía creada. Guardando…");
}

function deleteGroup(groupId) {
  state.groups = (state.groups || []).filter((group) => group.id !== groupId);
  // Strip every membership referencing the deleted group so no orphaned
  // group_id survives on any entity.
  state.entities.forEach((entity) => {
    if (Array.isArray(entity.memberships)) {
      entity.memberships = entity.memberships.filter((m) => m.group_id !== groupId);
    }
  });
  renderDiagram();
  scheduleRoutingSave("Jerarquía eliminada. Guardando…");
}

function addEntityToGroup(groupId, entityId) {
  const group = findGroup(groupId);
  const entity = findEntity(entityId);
  if (!group || !entity) return;
  entity.memberships = normalizeMemberships(entity.memberships);
  if (entity.memberships.some((m) => m.group_id === groupId)) return;
  entity.memberships.push({ group_id: groupId, prio: nextFreePrio(group) });
  renderDiagram();
  scheduleRoutingSave("Agente añadido a la jerarquía. Guardando…");
}

function removeEntityFromGroup(groupId, entityId) {
  const entity = findEntity(entityId);
  if (!entity || !Array.isArray(entity.memberships)) return;
  entity.memberships = entity.memberships.filter((m) => m.group_id !== groupId);
  renderDiagram();
  scheduleRoutingSave("Agente retirado de la jerarquía. Guardando…");
}

function setMemberPrio(groupId, entityId, prio) {
  const group = findGroup(groupId);
  const entity = findEntity(entityId);
  if (!group || !entity) return;
  // Defensive: never let a click assign a prio another member already holds.
  const takenByOther = groupMembers(group).some((m) => m.entity.id !== entityId && m.prio === prio);
  if (takenByOther) return;
  const membership = entityMemberships(entity).find((m) => m.group_id === groupId);
  if (!membership) return;
  membership.prio = prio;
  renderDiagram();
  scheduleRoutingSave("Prioridad actualizada. Guardando…");
}

function setGroupMemberOrder(groupId, orderedEntityIds) {
  const group = findGroup(groupId);
  if (!group) return;
  orderedEntityIds.forEach((entityId, index) => {
    const entity = findEntity(entityId);
    const membership = entity ? entityMemberships(entity).find((m) => m.group_id === groupId) : null;
    if (membership) membership.prio = index + 1;
  });
  renderDiagram();
  scheduleRoutingSave("Prioridades reordenadas. Guardando…");
}

function moveGroupMember(groupId, entityId, direction) {
  const members = groupMembers(findGroup(groupId) || {}).map(({ entity }) => entity.id);
  const index = members.indexOf(entityId);
  if (index < 0) return;
  const nextIndex = Math.max(0, Math.min(members.length - 1, index + direction));
  if (nextIndex === index) return;
  const [moved] = members.splice(index, 1);
  members.splice(nextIndex, 0, moved);
  setGroupMemberOrder(groupId, members);
}

function groupCard(group) {
  const members = groupMembers(group);
  const memberRows = members
    .map(({ entity, prio }) => {
      return `<div class="group-member-row" draggable="true" data-group="${group.id}" data-member="${entity.id}">
          <span class="group-member-name" title="${escapeHtml(entity.name || roleDef(entity.role).label)}">${escapeHtml(entity.name || roleDef(entity.role).label)}</span>
          <span class="group-prio-badge" title="Prioridad asignada">${prio}</span>
          <span class="group-member-controls">
            <button type="button" class="group-member-remove" data-group="${group.id}" data-member="${entity.id}" title="Quitar de la jerarquía">×</button>
          </span>
        </div>`;
    })
    .join("");
  const available = state.entities.filter(
    (entity) => !entityMemberships(entity).some((m) => m.group_id === group.id)
  );
  const addControl = available.length
    ? `<select class="group-add-member" data-group="${group.id}">
        <option value="">+ Añadir agente…</option>
        ${available
          .map((entity) => `<option value="${entity.id}">${escapeHtml(entity.name || roleDef(entity.role).label)}</option>`)
          .join("")}
      </select>`
    : `<small class="group-add-empty">Todos los agentes ya pertenecen a este grupo.</small>`;
  return `<div style="left:${screenX(group.x || 0)}px; top:${screenY(group.y || 0)}px; --group-color:${escapeHtml(group.color)}" class="node group" data-group="${group.id}">
      <button class="node-x group-delete" data-delete-group="${group.id}" title="Eliminar jerarquía">×</button>
      <div class="node-port" title="Punto de conexión"></div>
      <div class="role">Jerarquía · Prio</div>
      <div class="group-head">
        <input type="color" class="group-color-input" data-group="${group.id}" value="${escapeHtml(group.color)}" title="Color de la jerarquía" />
        <input type="text" class="group-name-input" data-group="${group.id}" value="${escapeHtml(group.name)}" placeholder="Nombre de la jerarquía" />
      </div>
      <div class="group-members">
        ${memberRows || '<small class="group-add-empty">Sin miembros todavía.</small>'}
      </div>
      <div class="group-add">${addControl}</div>
    </div>`;
}

function bindGroupCardEvents() {
  $$("#diagramNodes .node.group").forEach((card) => {
    const groupId = card.dataset.group;
    card.querySelector(".group-name-input")?.addEventListener("change", (event) => {
      const group = findGroup(groupId);
      if (!group) return;
      group.name = event.target.value.trim() || "Nueva jerarquía";
      renderDiagram();
      scheduleRoutingSave("Jerarquía renombrada. Guardando…");
    });
    card.querySelector(".group-color-input")?.addEventListener("change", (event) => {
      const group = findGroup(groupId);
      if (!group) return;
      group.color = event.target.value;
      renderDiagram();
      scheduleRoutingSave("Color de jerarquía actualizado. Guardando…");
    });
    card.querySelector(".group-delete")?.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteGroup(groupId);
    });
    card.querySelector(".group-add-member")?.addEventListener("change", (event) => {
      if (event.target.value) addEntityToGroup(groupId, event.target.value);
    });
    card.querySelectorAll(".group-member-remove").forEach((button) =>
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        removeEntityFromGroup(groupId, button.dataset.member);
      })
    );
    card.querySelectorAll(".group-member-row").forEach((row) => {
      row.addEventListener("dragstart", (event) => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/group-member", row.dataset.member);
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
      row.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        row.classList.add("drop-target");
      });
      row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        row.classList.remove("drop-target");
        const draggedId = event.dataTransfer.getData("text/group-member");
        const targetId = row.dataset.member;
        if (!draggedId || draggedId === targetId) return;
        const ordered = groupMembers(findGroup(groupId) || {}).map(({ entity }) => entity.id);
        const from = ordered.indexOf(draggedId);
        const to = ordered.indexOf(targetId);
        if (from < 0 || to < 0) return;
        const [moved] = ordered.splice(from, 1);
        ordered.splice(to, 0, moved);
        setGroupMemberOrder(groupId, ordered);
      });
    });
  });
  bindGroupMove();
}

function bindGroupMove() {
  $$("#diagramNodes .node.group").forEach((node) => {
    node.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest("button, input, select, label, summary, details, .node-x, .group-member-row")) return;
      const group = findGroup(node.dataset.group);
      if (!group) return;
      event.preventDefault();
      activeGroupMove = {
        id: group.id,
        node,
        originX: group.x || 0,
        originY: group.y || 0,
        startX: event.clientX,
        startY: event.clientY,
      };
      node.classList.add("moving");
      document.body.classList.add("moving-node");
      setDiagramNodeDragging(true);
      document.addEventListener("pointermove", onGroupMove);
      document.addEventListener("pointerup", stopGroupMove, { once: true });
    });
  });
}

function onGroupMove(event) {
  if (!activeGroupMove) return;
  const group = findGroup(activeGroupMove.id);
  if (!group) return;
  group.x = activeGroupMove.originX + (event.clientX - activeGroupMove.startX) / state.diagramZoom;
  group.y = activeGroupMove.originY + (event.clientY - activeGroupMove.startY) / state.diagramZoom;
  activeGroupMove.node.style.left = `${screenX(group.x)}px`;
  activeGroupMove.node.style.top = `${screenY(group.y)}px`;
}

function stopGroupMove() {
  if (activeGroupMove) activeGroupMove.node.classList.remove("moving");
  activeGroupMove = null;
  document.body.classList.remove("moving-node");
  document.removeEventListener("pointermove", onGroupMove);
  setDiagramNodeDragging(false);
  persistEntityState();
  scheduleRoutingSave("Posición de jerarquía actualizada. Guardando…");
}

function initDiagramViewport() {
  const storedZoom = Number(localStorage.getItem("karajan-diagram-zoom"));
  if (Number.isFinite(storedZoom)) state.diagramZoom = clampZoom(storedZoom);
  bindDiagramPanZoom();
  applyDiagramZoom();
}

function bindDiagramPanZoom() {
  const diagram = $("#diagram");
  if (!diagram || diagram.dataset.viewportBound) return;
  diagram.dataset.viewportBound = "1";
  diagram.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest(".node, .model-menu")) return;
    event.preventDefault();
    activeDiagramPan = {
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: diagram.scrollLeft,
      scrollTop: diagram.scrollTop,
    };
    state.panningDiagram = true;
    diagram.classList.add("panning");
    document.addEventListener("pointermove", onDiagramPan);
    document.addEventListener("pointerup", stopDiagramPan, { once: true });
  });
  diagram.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const rect = diagram.getBoundingClientRect();
      const beforeX = (event.clientX - rect.left + diagram.scrollLeft) / state.diagramZoom;
      const beforeY = (event.clientY - rect.top + diagram.scrollTop) / state.diagramZoom;
      const direction = event.deltaY > 0 ? -1 : 1;
      state.diagramZoom = clampZoom(state.diagramZoom + direction * 0.08);
      localStorage.setItem("karajan-diagram-zoom", String(state.diagramZoom));
      persistEntityState();
      applyDiagramZoom();
      diagram.scrollLeft = beforeX * state.diagramZoom - (event.clientX - rect.left);
      diagram.scrollTop = beforeY * state.diagramZoom - (event.clientY - rect.top);
      scheduleDrawWires();
    },
    { passive: false }
  );
}

function onDiagramPan(event) {
  if (!activeDiagramPan) return;
  const diagram = $("#diagram");
  diagram.scrollLeft = activeDiagramPan.scrollLeft - (event.clientX - activeDiagramPan.startX);
  diagram.scrollTop = activeDiagramPan.scrollTop - (event.clientY - activeDiagramPan.startY);
  scheduleDrawWires();
}

function stopDiagramPan() {
  activeDiagramPan = null;
  state.panningDiagram = false;
  $("#diagram")?.classList.remove("panning");
  document.removeEventListener("pointermove", onDiagramPan);
}

function applyDrawerState() {
  document.documentElement.style.setProperty("--drawer-width", `${state.drawerWidth}px`);
  scheduleDrawWires();
}

function initDrawerControls() {
  const storedWidth = Number(localStorage.getItem("karajan-model-drawer-width"));
  if (Number.isFinite(storedWidth) && storedWidth >= 240) {
    state.drawerWidth = Math.min(520, Math.max(240, storedWidth));
  }
  applyDrawerState();

  const splitter = $("#drawerSplitter");
  if (!splitter) return;
  splitter.addEventListener("pointerdown", (event) => {
    if (!state.modelDrawerOpen) return;
    event.preventDefault();
    state.resizingDrawer = true;
    splitter.classList.add("dragging");
    document.body.classList.add("resizing-drawer");
    document.addEventListener("pointermove", onDrawerResize);
    document.addEventListener("pointerup", stopDrawerResize, { once: true });
  });
}

function onDrawerResize(event) {
  if (!state.resizingDrawer) return;
  const workbench = $(".decision-workbench");
  if (!workbench) return;
  const rect = workbench.getBoundingClientRect();
  const maxWidth = Math.min(560, rect.width * 0.55);
  const nextWidth = Math.round(Math.min(maxWidth, Math.max(240, rect.right - event.clientX)));
  state.drawerWidth = nextWidth;
  document.documentElement.style.setProperty("--drawer-width", `${nextWidth}px`);
  localStorage.setItem("karajan-model-drawer-width", String(nextWidth));
  persistEntityState();
  scheduleDrawWires();
}

function stopDrawerResize() {
  state.resizingDrawer = false;
  $("#drawerSplitter")?.classList.remove("dragging");
  document.body.classList.remove("resizing-drawer");
  document.removeEventListener("pointermove", onDrawerResize);
}

async function saveRouting(auto = false) {
  if (!state.config) return;
  persistEntityState();
  const prefs = { ...state.config.provider_preferences };
  const parent = state.entities.find((item) => isAgentRole(item.role) && item.provider);
  Object.values(state.config.level_to_model).forEach((tier) => delete prefs[tier]);
  if (parent) {
    prefs.strong_model = parent.provider;
    prefs.strong_model_with_human_review = parent.provider;
  } else {
    delete prefs.strong_model;
    delete prefs.strong_model_with_human_review;
  }
  state.entities
    .filter((item) => canOwnLevels(item.role) && item.provider)
    .forEach((entity) => {
      (entity.levels || []).forEach((level) => {
        const tier = state.config.level_to_model[level];
        if (tier) prefs[tier] = entity.provider;
      });
  });
  state.config.provider_preferences = prefs;
  await putConfig(auto ? "Enrutado autoguardado." : "Enrutado guardado.");
}

// ---- MODELS ----------------------------------------------------------------
async function renderModels({ restoreSearchFocus = false } = {}) {
  const [catalog, providers] = await Promise.all([api("/catalog"), api("/providers")]);
  state.catalog = catalog;
  state.providers = providers;
  try {
    state.skills = await api("/skills");
  } catch {
    state.skills = [];
  }
  const status = new Map(providers.map((p) => [p.provider, p]));
  const advanced = $("#modelsAdvanced").checked;
  const activeProviders = activeArchitectureProviderNames();
  const query = (state.decisionCatalogQuery || "").trim().toLowerCase();
  const matchesQuery = (provider) => {
    if (!query) return activeProviders.has(provider.name);
    return [provider.label, provider.name, provider.backend, provider.auth_method]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
  };
  const visibleCatalog = catalog
    .filter((provider) => provider.name !== "openclaw" && matchesQuery(provider))
    .sort((a, b) => {
      const activeDelta = Number(activeProviders.has(b.name)) - Number(activeProviders.has(a.name));
      if (activeDelta) return activeDelta;
      return (a.label || a.name).localeCompare(b.label || b.name, "es", { sensitivity: "base" });
    });

  const groups = {};
  visibleCatalog.forEach((p) => (groups[p.backend] || (groups[p.backend] = [])).push(p));
  const groupTitle = { cli: "Local / terminal", api: "Nube (API)", simulated: "Simulado" };

  $("#providerGroups").innerHTML = `
    <div class="decision-catalog-tools">
      <input type="search" data-decision-catalog-search placeholder="Buscar agente..." value="${escapeHtml(state.decisionCatalogQuery || "")}" autocomplete="off" />
      <span>${query ? `${activeProviders.size} en mapa · ${visibleCatalog.length} resultado${visibleCatalog.length === 1 ? "" : "s"}` : `${activeProviders.size} en mapa`}</span>
    </div>
    ${Object.entries(groups)
      .filter(([, list]) => list.length)
      .map(([backend, list]) => {
      const cards = list.map((p) => providerCard(p, status.get(p.name), advanced, activeProviders.has(p.name))).join("");
      return `<section class="provider-group"><h3>${groupTitle[backend] || backend}</h3>
        <div class="provider-cards">${cards}</div></section>`;
    })
    .join("") || `<div class="config-empty">${query ? "No hay agentes que coincidan con la búsqueda." : "Busca un agente para añadirlo al mapa de Decisión."}</div>`}
  `;

  $$("#providerGroups .model-card").forEach((card) => {
    card.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/provider", card.dataset.name);
      event.dataTransfer.effectAllowed = "copy";
    });
    card.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button, a, input, select")) return;
      startModelPointerDrag(event, card.dataset.name, card.querySelector(".name")?.textContent?.trim() || card.dataset.name);
    });
  });
  const searchInput = $("[data-decision-catalog-search]");
  searchInput?.addEventListener("input", (event) => {
    state.decisionCatalogQuery = event.target.value;
    renderModels({ restoreSearchFocus: true });
  });
  if (restoreSearchFocus && searchInput) {
    searchInput.focus();
    const end = searchInput.value.length;
    searchInput.setSelectionRange(end, end);
  }
  if ($("#view-decision").classList.contains("active")) renderDiagram();
}

function activeArchitectureProviderNames() {
  return new Set((state.entities || []).map((entity) => entity.provider).filter((provider) => provider && provider !== "openclaw"));
}

function startModelPointerDrag(event, providerName, label) {
  event.preventDefault();
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  ghost.textContent = label;
  document.body.appendChild(ghost);
  activeModelDrag = { providerName, ghost, over: null };
  moveModelGhost(event.clientX, event.clientY);
  document.addEventListener("pointermove", onModelPointerMove);
  document.addEventListener("pointerup", onModelPointerUp, { once: true });
}

function moveModelGhost(x, y) {
  if (!activeModelDrag) return;
  activeModelDrag.ghost.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
}

function onModelPointerMove(event) {
  if (!activeModelDrag) return;
  moveModelGhost(event.clientX, event.clientY);
  const node = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".node");
  if (activeModelDrag.over !== node) {
    document.querySelectorAll(".node.drop-ready").forEach((item) => item.classList.remove("drop-ready"));
    if (node) node.classList.add("drop-ready");
    activeModelDrag.over = node;
  }
}

function onModelPointerUp(event) {
  document.removeEventListener("pointermove", onModelPointerMove);
  const drag = activeModelDrag;
  activeModelDrag = null;
  document.querySelectorAll(".node.drop-ready").forEach((item) => item.classList.remove("drop-ready"));
  if (!drag) return;
  drag.ghost.remove();
  const dropElement = document.elementFromPoint(event.clientX, event.clientY);
  const node = dropElement?.closest?.(".node");
  const entityId = node?.dataset?.entity;
  if (entityId) {
    assignProviderToNode(entityId, drag.providerName);
    return;
  }
  if (dropElement?.closest?.("#diagram")) {
    addEntityFromProvider(drag.providerName, "child", diagramPointFromClient(event.clientX, event.clientY));
  }
}

function providerCard(provider, status, advanced, active = false) {
  const ready = status?.ready;
  const available = status?.available;
  const dot = ready ? "ok" : available ? "warn" : "bad";
  const stateText = ready ? "listo" : available ? "instalado, no listo" : "no configurado";
  const entity = (state.entities || []).find((item) => item.provider === provider.name);
  const roleSummary = entity ? roleLabels(entity).join(" · ") : "fuera de jerarquia";
  const levelSummary =
    entity && entity.levels?.length
      ? entity.levels.map((level) => LEVEL_FULL[level] || level).join(" · ")
      : "sin niveles directos";
  const models = Object.entries(provider.tiers || {})
    .map(([tier, model]) => `<div>${TIER_LABEL[tier] || tier}: ${escapeHtml(model)}</div>`)
    .join("");
  const advBlock = advanced
    ? `<div class="models">${models || "<div>—</div>"}
        ${provider.env_var ? `<div>env: ${provider.env_var}</div>` : ""}
        ${provider.cli_command ? `<div>cli: ${escapeHtml(provider.cli_command)}</div>` : ""}
        ${provider.endpoint ? `<div>${escapeHtml(provider.endpoint)}</div>` : ""}</div>`
    : "";
  const action = active
    ? `<button type="button" class="decision-agent-action remove" data-decision-agent-remove="${escapeHtml(provider.name)}" title="Quitar de Decisión" aria-label="Quitar ${escapeHtml(provider.label)} de Decisión">−</button>`
    : `<button type="button" class="decision-agent-action add" data-decision-agent-add="${escapeHtml(provider.name)}" title="Añadir a Decisión" aria-label="Añadir ${escapeHtml(provider.label)} a Decisión">+</button>`;
  return `<div class="pcard model-card ${advanced ? "adv" : ""} ${active ? "active" : ""}" draggable="true" data-name="${escapeHtml(provider.name)}">
      <div class="top">
        <span class="name"><span class="status-dot ${dot}"></span>${escapeHtml(provider.label)} <span class="cost-tag ${provider.is_free ? "free" : "paid"}">${provider.is_free ? "Gratis" : "Pago"}</span></span>
        <span class="model-card-actions">
          ${action}
        </span>
      </div>
      <div class="free">${escapeHtml(roleSummary)} · ${escapeHtml(levelSummary)}</div>
      <div class="free">${status ? escapeHtml(status.detail) : stateText}</div>
      ${advBlock}
    </div>`;
}

// ---- FLOW / PARAMETERS -----------------------------------------------------
function field(label, control) {
  return `<div class="field"><div class="field-label">${label}</div><div class="control-cell">${control}</div></div>`;
}
function numberInput(id, value, step = "1", min = "0") {
  return `<input type="number" id="${id}" value="${value}" step="${step}" min="${min}" />`;
}
function selectInput(id, value, options, labels = {}) {
  return `<select id="${id}">${options
    .map((o) => `<option value="${o}" ${o === value ? "selected" : ""}>${labels[o] || o}</option>`)
    .join("")}</select>`;
}
function checkbox(id, checked) {
  return `<label class="toggle"><input type="checkbox" id="${id}" ${checked ? "checked" : ""} /><span></span></label>`;
}

// All 5 config sections stay visible in one continuous scrollable page. A nav
// entry (or a search match) no longer hides the others — it just highlights the
// current nav button and, when `scroll` is set, scroll-jumps to that section.
function setConfigTab(tab, { scroll = true } = {}) {
  state.configTab = tab;
  $$(".config-tab").forEach((button) => button.classList.toggle("active", button.dataset.configTab === tab));
  if (scroll) {
    $(`#flowGrid [data-config-panel="${tab}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// Lightweight scroll-spy: highlight whichever section is nearest the top of the
// viewport as the user scrolls the continuous config page. Rebuilt on each
// renderFlow() so it always tracks the freshly-rendered panels.
let configScrollSpy = null;
function initConfigScrollSpy() {
  if (configScrollSpy) {
    configScrollSpy.disconnect();
    configScrollSpy = null;
  }
  const panels = $$("#flowGrid [data-config-panel]");
  if (!panels.length || typeof IntersectionObserver === "undefined") return;
  configScrollSpy = new IntersectionObserver(
    (entries) => {
      const top = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!top) return;
      const tab = top.target.dataset.configPanel;
      state.configTab = tab;
      $$(".config-tab").forEach((button) => button.classList.toggle("active", button.dataset.configTab === tab));
    },
    { rootMargin: "-15% 0px -75% 0px", threshold: 0 },
  );
  panels.forEach((panel) => configScrollSpy.observe(panel));
}

function setConfigMode(mode) {
  state.configMode = mode;
  const view = $("#view-flow");
  view?.classList.toggle("mode-traditional", mode === "traditional");
  view?.classList.toggle("mode-prompting", mode === "prompting");
  $$("#configModeTabs button").forEach((button) => button.classList.toggle("active", button.dataset.configMode === mode));
  $$(".config-mode-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `config-mode-${mode}`));
  if (mode === "prompting") renderPromptConfiguration();
}

function renderFlow() {
  const c = state.config;
  if (!c) return;
  const o = c.orchestration;
  c.policy ||= defaultPolicyConfig();

  const general = `<div class="fcard fcard-general"><h3>General</h3>
    ${field("Perfil", selectInput("cfg-profile", c.profile, ["simple", "pro", "offline"]))}
    ${field("Backend", selectInput("cfg-backend", c.backend, ["simulated", "api", "cli"]))}
    ${field("Preferir gratis", checkbox("cfg-prefer_free", c.prefer_free))}</div>`;

  const orchestration = `<div class="fcard fcard-control"><h3>Control de flujo</h3>
    ${field("Paralelo", checkbox("cfg-parallel", o.parallel))}
    ${field("Máx. paralelo", numberInput("cfg-max_parallel", o.max_parallel, "1", "1"))}
    ${field("Timeout subtarea (s)", numberInput("cfg-subtask_timeout_s", o.subtask_timeout_s, "1", "1"))}
    ${field("Reintentos", numberInput("cfg-max_retries", o.max_retries, "1", "0"))}
    ${field("Puerta revisión humana", checkbox("cfg-review_gate", o.require_human_review_gate))}</div>`;

  const weights = `<div class="fcard fcard-weights"><h3>Pesos de criterios</h3>
    ${CRITERIA.map((name) => field(name, numberInput(`cfg-w-${name}`, c.criteria_weights[name] ?? 0, "0.05", "0"))).join("")}
    <div class="weights-sum" id="weightsSum"></div></div>`;

  const levels = `<div class="fcard fcard-rules"><h3>Umbrales y reglas</h3>
    ${c.level_thresholds
      .map((value, index) => field(`Umbral ${index + 1}`, numberInput(`cfg-th-${index}`, value, "0.1", "0")))
      .join("")}
    <h4>Nivel → modelo</h4>
    ${LEVELS.map(([level]) => field(LEVEL_FULL[level], selectInput(`cfg-l2m-${level}`, c.level_to_model[level], TIERS, TIER_LABEL))).join("")}</div>`;

  const tables = `<div class="fcard fcard-cost"><h3>Coste y latencia (avanzado)</h3>
    <h4>Guardrails de coste</h4>
    ${field("Máx. coste por tarea ($)", numberInput("cfg-max_cost_per_task_usd", o.max_cost_per_task_usd ?? 0, "0.0001", "0"))}
    ${field("Máx. coste diario ($)", numberInput("cfg-max_daily_cost_usd", o.max_daily_cost_usd ?? 0, "0.0001", "0"))}
    <h4>Coste por modelo ($)</h4>
    ${TIERS.map((tier) => field(TIER_LABEL[tier], numberInput(`cfg-cost-${tier}`, c.cost_table[tier] ?? 0, "0.0001", "0"))).join("")}
    <h4>Latencia base (ms)</h4>
    ${TIERS.map((tier) => field(TIER_LABEL[tier], numberInput(`cfg-lat-${tier}`, c.latency_table[tier] ?? 0, "10", "0"))).join("")}</div>`;

  const sections = [
    ["general", general],
    ["flow", orchestration],
    ["weights", weights],
    ["rules", levels],
    ["cost", tables],
  ];
  // Render ALL sections up front — they all stay visible in one continuous
  // scrollable page (the sidebar nav scroll-jumps between them). Rendering them
  // together also lets bindFlowAutosave() below bind every input/select in one
  // pass — do NOT swap innerHTML per tab click or autosave bindings are lost.
  $("#flowGrid").innerHTML = sections
    .map(([id, html]) => `<div class="config-panel" data-config-panel="${id}">${html}</div>`)
    .join("");
  updateWeightsSum();
  CRITERIA.forEach((name) => $(`#cfg-w-${name}`).addEventListener("input", updateWeightsSum));
  bindFlowAutosave();
  renderPromptConfiguration();
  renderTraditionalLibrary();
  setConfigMode(state.configMode);
  // Highlight the current nav entry WITHOUT yanking scroll on first paint.
  setConfigTab(state.configTab, { scroll: false });
  initConfigScrollSpy();
}

function renderPromptConfiguration() {
  const target = $("#promptConfigPanel");
  if (!target || !state.config) return;
  const prompts = buildConfigPrompts();
  if (!prompts.some((prompt) => prompt.id === state.selectedPromptTemplate)) state.selectedPromptTemplate = prompts[0]?.id || "hierarchy";
  const selected = prompts.find((prompt) => prompt.id === state.selectedPromptTemplate) || prompts[0];
  const allResources = buildPromptResourceLibrary();
  const resources = filterPromptResources(allResources, state.promptLibraryQuery);
  if (!state.selectedPromptResourceId || !allResources.some((resource) => resource.id === state.selectedPromptResourceId)) {
    state.selectedPromptResourceId = resources[0]?.id || allResources[0]?.id || "";
  }
  const selectedResource = allResources.find((resource) => resource.id === state.selectedPromptResourceId) || resources[0] || null;
  const templateHeaderActions = state.promptSideMode === "templates" ? `<div class="prompt-library-header-actions">
          <button type="button" class="icon-btn" data-new-prompt-template title="Nueva plantilla" aria-label="Nueva plantilla">+</button>
          <button type="button" class="icon-btn" data-delete-prompt-template="${escapeHtml(selected.id)}" title="${selected.isDefault ? "Las plantillas base no se pueden eliminar" : "Eliminar plantilla"}" aria-label="Eliminar plantilla" ${selected.isDefault ? "disabled" : ""}>🗑</button>
        </div>` : "";
  const resourceDetailPanel = state.promptSideMode === "library" ? `<section class="prompt-resource-detail-panel">
      ${promptResourceDetailCard(selectedResource)}
    </section>` : "";
  target.innerHTML = `<div class="prompt-config-shell ${state.promptLibraryOpen ? "" : "library-collapsed"} ${state.promptSideMode === "library" ? "has-resource-detail" : "no-resource-detail"}">
    <section class="prompt-mode-panel config-mode-tabs">
      <div class="config-mode-copy">
        <span class="eyebrow">Prompting configuration</span>
        <h2>Editor de plantilla</h2>
        <p>Carga una plantilla, edítala y copia el prompt final. La biblioteca contiene piezas documentadas para construir jerarquías, reglas y proveedores.</p>
      </div>
      <div class="config-mode-actions">
        <button type="button" data-config-mode="traditional">Configuración tradicional</button>
        <button class="active" type="button" data-config-mode="prompting">Prompting configuration</button>
      </div>
    </section>
    ${resourceDetailPanel}
    <section class="prompt-config-main">
      <article class="prompt-editor-card">
        <header>
          <div>
            <span>${escapeHtml(selected.scope)}</span>
            <h3>${escapeHtml(selected.title)}</h3>
            <p>${escapeHtml(selected.description)}</p>
          </div>
          <div class="prompt-editor-actions">
            <button type="button" data-save-prompt="${escapeHtml(selected.id)}">Guardar cambios</button>
            <button type="button" data-copy-prompt="${escapeHtml(selected.id)}" class="primary">Copiar prompt</button>
            <button type="button" data-apply-prompt="${escapeHtml(selected.id)}">Aplicar con agente</button>
          </div>
        </header>
        <textarea data-prompt-template="${escapeHtml(selected.id)}">${escapeHtml(selected.body)}</textarea>
      </article>
    </section>
    <aside class="prompt-config-side">
      <section class="prompt-library-panel">
        <header>
          <div class="prompt-library-title">
            <span class="eyebrow">Resource library</span>
            <h3>${state.promptSideMode === "templates" ? "Plantillas" : "Biblioteca de recursos"}</h3>
          </div>
          <div class="prompt-library-tools">
            ${templateHeaderActions}
            <button type="button" class="icon-btn" data-toggle-prompt-library title="Mostrar u ocultar biblioteca">◧</button>
          </div>
        </header>
        <div class="prompt-library-body">
          <div class="prompt-library-switch">
            <button type="button" class="${state.promptSideMode === "templates" ? "active" : ""}" data-prompt-side-mode="templates">Plantillas</button>
            <button type="button" class="${state.promptSideMode === "library" ? "active" : ""}" data-prompt-side-mode="library">Biblioteca</button>
          </div>
          ${state.promptSideMode === "templates" ? promptTemplateSidebar(prompts, selected) : promptResourceSidebar(resources, selectedResource)}
        </div>
      </section>
    </aside>
  </div>`;
}

function renderPromptResourceGrid() {
  renderPromptConfiguration();
  renderTraditionalLibrary();
}

// Reuses the SAME resource-library rendering as Prompting mode (buildPromptResourceLibrary
// / filterPromptResources / promptResourceSidebar), but placed on the LEFT in traditional
// mode via the #traditionalLibraryPanel container.
function renderTraditionalLibrary() {
  const target = $("#traditionalLibraryPanel");
  if (!target || !state.config) return;
  const allResources = buildPromptResourceLibrary();
  const resources = filterPromptResources(allResources, state.promptLibraryQuery);
  if (!state.selectedPromptResourceId || !allResources.some((resource) => resource.id === state.selectedPromptResourceId)) {
    state.selectedPromptResourceId = resources[0]?.id || allResources[0]?.id || "";
  }
  const selectedResource = allResources.find((resource) => resource.id === state.selectedPromptResourceId) || resources[0] || null;
  target.innerHTML = `<section class="prompt-library-panel">
      <header>
        <div class="prompt-library-title">
          <span class="eyebrow">Resource library</span>
          <h3>Biblioteca de recursos</h3>
        </div>
      </header>
      <div class="prompt-library-body">
        ${promptResourceSidebar(resources, selectedResource)}
        <div class="traditional-resource-detail">
          ${promptResourceDetailCard(selectedResource)}
        </div>
      </div>
    </section>`;
}

// Live typeahead over every setting row's .field-label across all 5 sections.
// On the first match, switch to that field's section tab and flash-highlight it.
function filterConfigFields(query) {
  const q = (query || "").trim().toLowerCase();
  clearTimeout(configHitTimer);
  $$("#flowGrid .field.config-field-hit").forEach((field) => field.classList.remove("config-field-hit"));
  if (!q) return;
  let firstHit = null;
  $$("#flowGrid [data-config-panel]").forEach((panel) => {
    $$(".field", panel).forEach((field) => {
      const label = $(".field-label", field);
      if (label && label.textContent.toLowerCase().includes(q)) {
        field.classList.add("config-field-hit");
        if (!firstHit) firstHit = { panel, field };
      }
    });
  });
  if (!firstHit) return;
  // Everything is always visible now — just highlight the section's nav button
  // (no show/hide) and scroll the matched field itself into view.
  setConfigTab(firstHit.panel.dataset.configPanel, { scroll: false });
  firstHit.field.scrollIntoView({ block: "center", behavior: "smooth" });
  configHitTimer = setTimeout(() => {
    $$("#flowGrid .field.config-field-hit").forEach((field) => field.classList.remove("config-field-hit"));
  }, 2600);
}

function promptTemplateSidebar(prompts, selected) {
  return `<div class="prompt-template-sidebar">
    ${state.promptTemplateFormOpen ? promptTemplateForm() : ""}
    <div class="prompt-side-list">
      ${prompts.map((prompt) => `<button type="button" class="prompt-side-item ${prompt.id === selected.id ? "active" : ""}" data-select-prompt="${escapeHtml(prompt.id)}">
        <span>${escapeHtml(prompt.scope)}</span>
        <b>${escapeHtml(prompt.title)}</b>
        <small>${escapeHtml(prompt.description)}</small>
      </button>`).join("")}
    </div>
  </div>`;
}

function promptTemplateForm() {
  return `<form class="prompt-template-form" data-prompt-template-form onsubmit="return false">
    <label>
      <span>Nombre</span>
      <input type="text" id="newPromptTitle" placeholder="Nombre de la plantilla" autocomplete="off" />
    </label>
    <label>
      <span>Descripción</span>
      <input type="text" id="newPromptDescription" placeholder="Qué hace esta plantilla" autocomplete="off" />
    </label>
    <label>
      <span>Prompt</span>
      <textarea id="newPromptBody" placeholder="Escribe aquí el prompt nuevo"></textarea>
    </label>
    <div class="prompt-template-form-actions">
      <button type="button" class="primary" data-save-new-prompt-template>Crear plantilla</button>
      <button type="button" data-cancel-new-prompt-template>Cancelar</button>
    </div>
  </form>`;
}

function promptResourceSidebar(resources, selectedResource) {
  const grouped = resources.reduce((acc, resource) => {
    (acc[resource.group] ||= []).push(resource);
    return acc;
  }, {});
  return `<div class="prompt-resource-sidebar">
    <input type="search" id="promptResourceSearch" placeholder="Buscar roles, niveles, restricciones..." value="${escapeHtml(state.promptLibraryQuery)}" />
    <div class="prompt-resource-layout">
      <div class="prompt-resource-index">
        ${Object.entries(grouped).map(([group, items]) => {
          const open = items.some((resource) => resource.id === selectedResource?.id);
          return `<details class="prompt-resource-group" ${open ? "open" : ""}>
            <summary>${escapeHtml(group)}<small>${items.length}</small></summary>
            <div class="prompt-resource-group-items">
              ${items.map((resource) => `<button type="button" class="${resource.id === selectedResource?.id ? "active" : ""}" data-select-prompt-resource="${escapeHtml(resource.id)}">
                ${escapeHtml(resource.title)}
              </button>`).join("")}
            </div>
          </details>`;
        }).join("") || `<div class="config-empty">Sin recursos para esa búsqueda.</div>`}
      </div>
    </div>
  </div>`;
}

function promptResourceDetailCard(selectedResource) {
  return selectedResource ? `<article class="prompt-resource-detail">
      <span>${escapeHtml(selectedResource.group)}</span>
      <h4>${escapeHtml(selectedResource.title)}</h4>
      <p>${escapeHtml(selectedResource.description)}</p>
      <code>${escapeHtml(selectedResource.example)}</code>
      <button type="button" data-insert-prompt-resource="${escapeHtml(selectedResource.id)}">Insertar en plantilla</button>
    </article>` : `<div class="prompt-resource-detail config-empty">Selecciona un recurso para ver el detalle.</div>`;
}

function promptTemplateCard(template) {
  return `<article class="prompt-template-card">
    <header>
      <div>
        <span>${escapeHtml(template.scope)}</span>
        <h3>${escapeHtml(template.title)}</h3>
      </div>
      <button type="button" data-copy-prompt="${escapeHtml(template.id)}">Copiar</button>
    </header>
    <p>${escapeHtml(template.description)}</p>
    <textarea readonly data-prompt-template="${escapeHtml(template.id)}">${escapeHtml(template.body)}</textarea>
  </article>`;
}

function promptResourceCard(resource) {
  return `<article class="prompt-resource-card">
    <header>
      <span>${escapeHtml(resource.group)}</span>
      <b>${escapeHtml(resource.title)}</b>
    </header>
    <p>${escapeHtml(resource.description)}</p>
    <code>${escapeHtml(resource.example)}</code>
    <button type="button" data-insert-prompt-resource="${escapeHtml(resource.id)}">Insertar en plantilla</button>
  </article>`;
}

function buildPromptResourceLibrary() {
  const roleResources = Object.entries(ROLE_DEFS).map(([key, role]) => ({
    id: `role:${key}`,
    group: "Roles",
    title: role.label,
    description: `${role.restriction || "R?"} · ${role.group || "Rol"} · ${role.summary}`,
    example: `Usa ${role.label} para ${role.summary.toLowerCase()}`,
    snippet: `\n\n## Rol sugerido: ${role.label}\n- Restricción: ${role.restriction || "R?"}\n- Uso: ${role.summary}\n- Prompt breve: asigna este rol solo si aporta valor operativo claro.`,
  }));
  const levelResources = LEVELS.map(([key, label], index) => ({
    id: `level:${key}`,
    group: "Niveles",
    title: LEVEL_FULL[key],
    description: `Nivel de actuación ${label}. Úsalo para repartir propiedad de complejidad sin solapes.`,
    example: `${label}: asignar a un único agente responsable.`,
    snippet: `\n\n## Nivel de actuación: ${LEVEL_FULL[key]}\n- Propietario único recomendado.\n- No permitir solape con otros Workers.\n- Criterio: complejidad aproximada ${index + 1}/5.`,
  }));
  const criteriaResources = CRITERIA.map((name) => ({
    id: `criterion:${name}`,
    group: "Criterios",
    title: name,
    description: `Criterio ponderado para calcular complejidad y decidir modelo/ruta.`,
    example: `Ajusta ${name} de 0 a 5 según el prompt.`,
    snippet: `\n\n## Criterio: ${name}\n- Evalúa este criterio en escala 0-5.\n- Justifica por qué sube o baja la complejidad.\n- Mantén consistencia con el resto de criterios.`,
  }));
  const policyResources = [
    ["policy:sensitive", "Restricciones", "Dominio sensible", "Bloquea o pide revisión si hay seguridad, operaciones, credenciales, legal o despliegue real.", "Si domain incluye security u operations, requiere revisión humana."],
    ["policy:intent", "Restricciones", "Intención crítica", "Usa critical_intents para tareas que pueden modificar producción, coste, permisos o seguridad.", "Si intent=security_architecture_review, aplicar puerta humana."],
    ["policy:paid", "Coste", "Proveedor de pago", "Marca proveedores de pago como sujetos a aprobación cuando activen modelos fuertes.", "No habilitar proveedor de pago sin aprobación explícita."],
    ["policy:credentials", "Credenciales", "Credenciales pendientes", "Cuando falte API key, login CLI o servicio local, el sistema debe bloquear ejecución real.", "Si falta API key, generar setup_action y no delegar ejecución real."],
  ].map(([id, group, title, description, example]) => ({
    id, group, title, description, example,
    snippet: `\n\n## ${title}\n- ${description}\n- Prompt breve: ${example}`,
  }));
  const providerResources = (state.catalog || []).slice(0, 8).map((provider) => ({
    id: `provider:${provider.name}`,
    group: "Proveedores",
    title: provider.label,
    description: `${provider.backend} · ${provider.is_free ? "Gratis" : "Pago"} · auth=${provider.env_var || provider.login_command || provider.auth_method}`,
    example: `Usar ${provider.label} para tiers compatibles si está disponible.`,
    snippet: `\n\n## Proveedor: ${provider.label}\n- Backend: ${provider.backend}\n- Coste: ${provider.is_free ? "Gratis" : "Pago"}\n- Auth: ${provider.env_var || provider.login_command || provider.auth_method}\n- Prompt breve: úsalo solo si está listo o genera acción de configuración.`,
  }));
  return [...roleResources, ...levelResources, ...criteriaResources, ...policyResources, ...providerResources];
}

function filterPromptResources(resources, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return resources;
  return resources.filter((resource) => `${resource.group} ${resource.title} ${resource.description} ${resource.example}`.toLowerCase().includes(q));
}

function insertPromptResource(id) {
  const resource = buildPromptResourceLibrary().find((item) => item.id === id);
  const textarea = $(`[data-prompt-template="${CSS.escape(state.selectedPromptTemplate)}"]`);
  if (!resource || !textarea) return;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  textarea.value = `${textarea.value.slice(0, start)}${resource.snippet}${textarea.value.slice(end)}`;
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = start + resource.snippet.length;
  toast("Recurso insertado en la plantilla.");
}

const CUSTOM_PROMPT_TEMPLATES_KEY = "karajan.customPromptTemplates";
const PROMPT_DRAFT_PREFIX = "karajan.promptDraft.";

function getCustomPromptTemplates() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_PROMPT_TEMPLATES_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => item?.id && item?.title) : [];
  } catch {
    return [];
  }
}

function saveCustomPromptTemplates(templates) {
  localStorage.setItem(CUSTOM_PROMPT_TEMPLATES_KEY, JSON.stringify(templates));
}

function getPromptDraft(id) {
  return localStorage.getItem(`${PROMPT_DRAFT_PREFIX}${id}`) || "";
}

function savePromptDraft(id, body) {
  localStorage.setItem(`${PROMPT_DRAFT_PREFIX}${id}`, body);
}

function applyStoredPromptTemplates(basePrompts) {
  const defaults = basePrompts.map((prompt) => ({
    ...prompt,
    isDefault: true,
    body: getPromptDraft(prompt.id) || prompt.body,
  }));
  const custom = getCustomPromptTemplates().map((prompt) => ({
    ...prompt,
    scope: prompt.scope || "Personal",
    isDefault: false,
  }));
  return [...defaults, ...custom];
}

function saveCurrentPromptTemplate(id) {
  const textarea = $(`[data-prompt-template="${CSS.escape(id)}"]`);
  const template = buildConfigPrompts().find((prompt) => prompt.id === id);
  if (!textarea || !template) return toast("No se ha encontrado la plantilla.");
  if (template.isDefault) {
    savePromptDraft(id, textarea.value);
  } else {
    const templates = getCustomPromptTemplates();
    const match = templates.find((prompt) => prompt.id === id);
    if (match) {
      match.body = textarea.value;
      saveCustomPromptTemplates(templates);
    }
  }
  toast("Cambios guardados.");
  renderPromptConfiguration();
}

function createPromptTemplateFromForm() {
  const title = $("#newPromptTitle")?.value.trim() || "";
  const description = $("#newPromptDescription")?.value.trim() || "";
  const body = $("#newPromptBody")?.value.trim() || "";
  if (!title) return toast("Pon un nombre para la plantilla.");
  if (!body) return toast("Escribe el prompt de la plantilla.");
  const templates = getCustomPromptTemplates();
  const id = `custom-${Date.now().toString(36)}`;
  templates.push({
    id,
    scope: "Personal",
    title,
    description: description || "Plantilla creada manualmente.",
    body,
  });
  saveCustomPromptTemplates(templates);
  state.selectedPromptTemplate = id;
  state.promptTemplateFormOpen = false;
  renderPromptConfiguration();
  toast("Plantilla creada.");
}

function deletePromptTemplate(id) {
  const template = buildConfigPrompts().find((prompt) => prompt.id === id);
  if (!template) return toast("No se ha encontrado la plantilla.");
  if (template.isDefault) return toast("Las plantillas base no se pueden eliminar.");
  saveCustomPromptTemplates(getCustomPromptTemplates().filter((prompt) => prompt.id !== id));
  state.selectedPromptTemplate = "hierarchy";
  renderPromptConfiguration();
  toast("Plantilla eliminada.");
}

function buildConfigPrompts() {
  const c = state.config;
  const entities = state.entities || [];
  const hierarchy = entities.length
    ? entities
        .map((entity) => {
          const roles = (entity.role_tags || []).map((role) => ROLE_DEFS[role]?.label || role).join(", ") || "sin rol";
          const levels = (entity.levels || []).map((level) => LEVEL_FULL[level] || level).join(", ") || "sin niveles";
          const parent = entity.parentId ? `padre=${entityLabel(entity.parentId)}` : "sin padre";
          return `- ${entityLabel(entity.id)} | proveedor=${entity.provider || "auto"} | roles=${roles} | niveles=${levels} | ${parent}`;
        })
        .join("\n")
    : "- Sin jerarquía definida todavía. Propón Agent principal, Workers y Backup.";
  const policy = c.policy || defaultPolicyConfig();
  const levelModels = LEVELS.map(([level]) => `- ${LEVEL_FULL[level]} => ${TIER_LABEL[c.level_to_model[level]] || c.level_to_model[level]}`).join("\n");
  const weights = CRITERIA.map((name) => `- ${name}: ${c.criteria_weights[name] ?? 0}`).join("\n");
  const providers = (state.catalog || [])
    .map((provider) => `- ${provider.label} (${provider.backend}) | ${provider.is_free ? "Gratis" : "Pago"} | auth=${provider.env_var || provider.login_command || provider.auth_method}`)
    .join("\n") || "- Catálogo no cargado.";
  const modelCosts = TIERS.map((tier) => `- ${TIER_LABEL[tier]}: coste=$${c.cost_table[tier] ?? 0}, latencia=${c.latency_table[tier] ?? 0}ms`).join("\n");

  return applyStoredPromptTemplates([
    {
      id: "hierarchy",
      scope: "01 · Jerarquía",
      title: "Diseñar jerarquía de agentes",
      description: "Define qué agentes intervienen, qué rol tiene cada uno, cómo se conectan y qué niveles cubren.",
      body: `# Objetivo
Configura una jerarquía KARAJAN para enrutar tareas entre Agent, Worker, Backup y roles auxiliares.

# Estado actual
${hierarchy}

# Roles disponibles
- Agent: autoridad global. Clasifica, planifica, enruta y delega.
- Worker: ejecuta tareas concretas asignadas por el Agent.
- Backup: reserva que puede asumir si falla el principal.
- Guardian: revisa o apoya a un Worker.
- Validator: valida salidas parciales o finales.
- Memory: mantiene contexto, checkpoints y estado.
- Monitor: vigila salud, timeouts y disponibilidad.

# Instrucciones
1. Propón una jerarquía mínima y clara.
2. Asigna niveles N1-N5 sin repetir propiedad entre agentes ejecutores.
3. Indica conexiones padre/hijo y cuándo usar Backup.
4. Devuelve JSON con: entities[], edges[], level_ownership{}, rationale.

# Restricciones
- No inventes proveedores que no estén en el catálogo.
- Si faltan credenciales, marca el nodo como pendiente.
- Prioriza modelos gratis para N1-N3 si no aumenta el riesgo.`,
    },
    {
      id: "base",
      scope: "02 · Base",
      title: "Configurar parámetros base",
      description: "Ajusta perfil, backend, paralelismo, timeouts, reintentos, pesos y umbrales.",
      body: `# Objetivo
Revisa y propone una configuración base para el harness KARAJAN.

# Configuración actual
- perfil: ${c.profile}
- backend: ${c.backend}
- preferir gratis: ${c.prefer_free}
- paralelo: ${c.orchestration.parallel}
- máximo paralelo: ${c.orchestration.max_parallel}
- timeout subtarea: ${c.orchestration.subtask_timeout_s}s
- reintentos: ${c.orchestration.max_retries}
- puerta revisión humana: ${c.orchestration.require_human_review_gate}

# Pesos actuales
${weights}

# Nivel → modelo
${levelModels}

# Instrucciones
1. Mantén pesos con suma 1.00.
2. Explica cada cambio con impacto operativo.
3. Devuelve JSON patch con: profile, backend, prefer_free, orchestration, criteria_weights, level_thresholds, level_to_model.
4. No cambies costes ni proveedores en este prompt.`,
    },
    {
      id: "policy",
      scope: "03 · Restricciones",
      title: "Definir política de revisión humana",
      description: "Separa dominios sensibles, intenciones críticas y condiciones que bloquean ejecución real.",
      body: `# Objetivo
Configura la política de seguridad y revisión humana de KARAJAN.

# Política actual
- dominios sensibles: ${(policy.sensitive_domains || []).join(", ")}
- intenciones críticas: ${(policy.critical_intents || []).join(", ")}
- nivel mínimo revisión: N${policy.human_review_min_level}
- umbral riesgo operacional: ${policy.operational_risk_review_threshold}
- revisar proveedores de pago: ${policy.require_review_for_paid_providers}
- revisar credenciales pendientes: ${policy.require_review_for_missing_credentials}

# Instrucciones
1. Propón dominios sensibles y critical_intents realistas.
2. Define cuándo bloquear, cuándo pedir aprobación y cuándo permitir ejecución.
3. Diferencia riesgo técnico, coste, credenciales y seguridad operativa.
4. Devuelve JSON con: policy, examples[], human_approval_reasons[].

# Criterio
La revisión humana debe explicar claramente qué se aprueba y por qué.`,
    },
    {
      id: "providers",
      scope: "04 · Proveedores",
      title: "Conectar agentes y controlar costes",
      description: "Organiza proveedores locales/API, credenciales, modelos por tier, costes y latencias.",
      body: `# Objetivo
Revisa proveedores KARAJAN y su uso por coste, disponibilidad y riesgo.

# Catálogo actual
${providers}

# Coste / latencia actual por tier
${modelCosts}

# Instrucciones
1. Recomienda qué proveedores usar para barato, medio, fuerte y revisión humana.
2. Separa locales, API, gratis y pago.
3. Indica qué credenciales o login faltan.
4. Sugiere límites de coste por tarea y coste diario.
5. Devuelve JSON con: provider_plan[], tier_mapping{}, cost_guardrails{}, setup_actions[].

# Restricciones
- No habilites proveedores de pago sin aprobación.
- Marca como pendiente cualquier proveedor sin API key/login.`,
    },
    {
      id: "default-config",
      scope: "05 · Producción",
      title: "Default config",
      description: "Deja la jerarquía de producción lista: Claude (N5) → ChatGPT backup/N4 → Qwen+DeepSeek local (N1-N3).",
      executable: true,
      body: `# Objetivo
Aplicar de un clic la jerarquía de referencia para producción, sin redactar nada manualmente.

# Jerarquía que se restaura
- Claude (Anthropic) -> Agent/padre, N5 crítica.
- ChatGPT (OpenAI) -> Backup y delegado directo de N4 (tareas medias/complejas).
- Qwen (local, Ollama) -> Worker, N1 simple + N2 moderada.
- DeepSeek (local, Ollama) -> Worker, N3 intermedia.

# Qué hace "Aplicar con agente" en esta plantilla
1. Restaura data/active_config.json y data/routing_layout.json desde data/production_baseline/ (con copia de seguridad automática de lo que hubiera).
2. Comprueba si los modelos locales qwen2.5:7b y deepseek-r1:8b ya están descargados en Ollama.
3. Comprueba si ANTHROPIC_API_KEY y OPENAI_API_KEY están configuradas.
4. Devuelve la lista exacta de pasos pendientes (ej. "ollama pull ...") si algo falta.

# Notas
- No descarga modelos por sí sola: la descarga de varios GB se hace desde terminal con los comandos que esta plantilla te devuelva.
- Equivalente a ejecutar: python scripts/setup_production.py --reset-config${formatDefaultConfigResult(state.defaultConfigResult)}`,
    },
    {
      id: "queue-hierarchy",
      scope: "06 · Cola de tareas",
      title: "Jerarquía piramidal + cola de disponibilidad",
      description: "Activa el despacho asíncrono (raíz → L1 → L2, escalado automático) y el validador con feedback.",
      executable: true,
      body: `# Objetivo
Aplicar de un clic la jerarquía piramidal completa con despacho por disponibilidad, sin editar el JSON a mano.

# Qué configura
1. Añade al grafo cualquier agente que falte de la jerarquía de referencia (no toca ni sobreescribe los que ya tengas):
   - Raíz (tier 0): Claude (padre), Codex/ChatGPT (backup).
   - L1 (tier 1, mejores open-source, vía Ollama cloud): GLM-5.2, Kimi K2.7 Code.
   - L2 (tier 2, siempre disponible en local): Qwen 2.5 7B, DeepSeek R1 8B, Mistral Nemo, Ornith, Qwen Coder, Gemma 2.
   - Validador dedicado y barato (etiqueta "validator"): Qwen 2.5 7B.
2. Activa \`orchestration.dispatch_mode = "queue"\`: cola de prioridad real + disponibilidad por agente — si el nivel L1 está ocupado, escala a L2 automáticamente en vez de bloquear la cola.
3. Activa \`orchestration.enable_validator_loop = true\`: el validador barato revisa cada salida y devuelve feedback; si rechaza, se reintenta al mismo agente (tope: max_validation_iterations) antes de escalar una sola vez a la raíz.

# Estado actual
- dispatch_mode: ${c.orchestration.dispatch_mode || "sync"}
- enable_validator_loop: ${c.orchestration.enable_validator_loop ?? false}
- agentes en el grafo: ${entities.length}

# Notas
- Es aditivo e idempotente: puedes aplicarlo varias veces sin perder personalizaciones (tags de rol, posiciones, target_ids).
- GLM-5.2 y Kimi K2.7 Code corren en la nube de Ollama: requieren \`ollama signin\` — no se auto-instalan.
- Equivalente a: POST /setup/apply-queue-config${formatDefaultConfigResult(state.queueConfigResult)}`,
    },
  ]);
}

function formatDefaultConfigResult(result) {
  if (!result) return "";
  const credLines = Object.entries(result.credentials || {})
    .map(([name, status]) => `  - ${name}: ${status.ready ? "OK" : "FALTA"} (${status.detail})`)
    .join("\n");
  const steps = (result.next_steps || []).length
    ? result.next_steps.map((step) => `  - ${step}`).join("\n")
    : "  - Ninguno: todo listo para delegar tareas reales.";
  return `

# Resultado de la última aplicación
- Restaurado: ${(result.restored || []).join(", ") || "—"}
- Copias de seguridad: ${(result.backups || []).length || 0}
- Modelos locales instalados: ${(result.ollama_installed || []).join(", ") || "ninguno"}
- Modelos locales que faltan: ${(result.ollama_missing || []).join(", ") || "ninguno"}
- Credenciales:
${credLines || "  - —"}
- Pasos pendientes:
${steps}`;
}

function defaultPolicyConfig() {
  return {
    sensitive_domains: ["security", "operations", "devops"],
    critical_intents: ["security_architecture_review", "security_review"],
    human_review_min_level: 5,
    operational_risk_review_threshold: 4,
    require_review_for_paid_providers: false,
    require_review_for_missing_credentials: true,
  };
}

const POLICY_SUGGESTIONS = {
  sensitive_domains: ["security", "operations", "devops", "legal", "credentials", "billing", "production", "compliance", "privacy", "infrastructure"],
  critical_intents: [
    "deploy_production",
    "rotate_credentials",
    "modify_permissions",
    "delete_data",
    "change_billing",
    "incident_response",
    "run_external_command",
    "access_sensitive_data",
    "security_architecture_review",
    "security_review",
  ],
};

async function renderConfigAgentsPanel() {
  const target = $("#agentsMainPanel") || $("#configAgentsPanel");
  if (!target) return;
  let catalog = state.catalog || [];
  let providers = state.providers || [];
  if (!catalog.length || !providers.length) {
    try {
      [catalog, providers] = await Promise.all([api("/catalog"), api("/providers")]);
      state.catalog = catalog;
      state.providers = providers;
    } catch (error) {
      target.innerHTML = `<div class="fcard"><h3>Agentes</h3><div class="config-empty">${escapeHtml(error.message)}</div></div>`;
      return;
    }
  }
  const manual = getManualAgents();
  const status = new Map(providers.map((p) => [p.provider, p]));
  const activeProviders = activeArchitectureProviderNames();
  const decisionFirst = (a, b) => {
    const activeDelta = Number(activeProviders.has(b.name)) - Number(activeProviders.has(a.name));
    if (activeDelta) return activeDelta;
    return (a.label || a.name).localeCompare(b.label || b.name, "es", { sensitivity: "base" });
  };
  const groups = {
    cli: catalog.filter((p) => p.backend === "cli").sort(decisionFirst),
    api: catalog.filter((p) => p.backend === "api").sort(decisionFirst),
    simulated: catalog.filter((p) => p.backend === "simulated").sort(decisionFirst),
  };
  const groupLabel = { cli: "Locales / CLI", api: "Nube / API", simulated: "Simulados" };
  target.innerHTML = `<div class="config-agent-layout">
    <section class="fcard config-agent-add">
      <h3>Agregar agente manual</h3>
      <div class="agent-console-line">
        <span class="agent-console-prompt">&gt;</span>
        <input id="manual-agent-command" type="text" spellcheck="false" placeholder='add "Nombre" backend=cli auth="comando o ENV"' />
        <button type="button" class="primary" id="runManualAgentCommand">Ejecutar</button>
      </div>
      <p class="config-note">Sintaxis: <code>add "Nombre" backend=cli|api|simulated auth="comando o ENV"</code> · <code>remove &lt;id&gt;</code>. Quedan guardados localmente para documentar la topología.</p>
    </section>
    ${Object.entries(groups)
      .filter(([, list]) => list.length)
      .map(([backend, list]) => `<section class="fcard config-agent-section">
        <h3>${groupLabel[backend] || backend}</h3>
        <div class="config-agent-grid">${list.map((provider) => configAgentCard(provider, status.get(provider.name))).join("")}</div>
      </section>`)
      .join("")}
    <section class="fcard config-agent-section">
      <h3>Manuales</h3>
      <div class="config-agent-grid">${
        manual.length ? manual.map(manualAgentCard).join("") : `<div class="config-empty">Aún no hay agentes manuales.</div>`
      }</div>
    </section>
  </div>`;
  if (!state.selectedConfigAgent) {
    state.selectedConfigAgent = catalog[0]?.name || manual[0]?.id || "";
  }
  renderAgentsSidePanel();
}

// The single provider-status-card renderer (readiness dot + backend/auth line +
// free/paid cost tag). Consolidates the three former copies of this fragment:
// renderHumanProviderGrid (deleted — wrote to a non-existent DOM node) and the
// Agentes catalog list below. Monitor's agentChartCard renders observability
// performance nodes (rings/sparklines), a different data shape, so it keeps its
// own layout but shares the /agents/performance cost/latency source.
function renderProviderStatusCard(provider, status = {}, { selected = false } = {}) {
  const ready = status.ready;
  const available = status.available;
  const dot = ready ? "ok" : available ? "warn" : "bad";
  const stateClass = ready ? "ready" : available ? "available" : "missing";
  const auth = provider.auth_method === "api_key" ? provider.env_var || "API key" : provider.login_command || provider.auth_method;
  const active = activeArchitectureProviderNames().has(provider.name);
  const decisionAction = provider.name === "openclaw" ? "" : active
    ? `<button type="button" class="decision-agent-action remove" data-decision-agent-remove="${escapeHtml(provider.name)}" title="Quitar de Decisión" aria-label="Quitar ${escapeHtml(provider.label)} de Decisión">−</button>`
    : `<button type="button" class="decision-agent-action add" data-decision-agent-add="${escapeHtml(provider.name)}" title="Añadir a Decisión" aria-label="Añadir ${escapeHtml(provider.label)} a Decisión">+</button>`;
  return `<article class="config-agent-card compact ${stateClass} ${active ? "active" : ""} ${selected ? "selected" : ""}" data-agent-card="${escapeHtml(provider.name)}">
    <span class="status-dot ${dot}"></span>
    <div class="config-agent-card-body">
      <b>${escapeHtml(provider.label)} <span class="cost-tag ${provider.is_free ? "free" : "paid"}">${provider.is_free ? "Gratis" : "Pago"}</span></b>
      <small>${escapeHtml(provider.backend)} · ${escapeHtml(auth)}</small>
    </div>
    <span class="model-card-actions">
      ${decisionAction}
    </span>
  </article>`;
}

function configAgentCard(provider, status = {}) {
  return renderProviderStatusCard(provider, status, { selected: state.selectedConfigAgent === provider.name });
}

function manualAgentCard(agent) {
  const selected = state.selectedConfigAgent === agent.id ? "selected" : "";
  return `<article class="config-agent-card compact manual ${selected}" data-agent-card="${escapeHtml(agent.id)}">
    <span class="status-dot warn"></span>
    <div class="config-agent-card-body">
      <b>${escapeHtml(agent.name)}</b>
      <small>${escapeHtml(agent.backend)} · manual</small>
    </div>
    <button type="button" class="icon-btn" data-remove-manual-agent="${escapeHtml(agent.id)}" title="Quitar">×</button>
  </article>`;
}

function getManualAgents() {
  try {
    return JSON.parse(localStorage.getItem("karajan-manual-agents") || "[]");
  } catch {
    return [];
  }
}

function saveManualAgents(agents) {
  localStorage.setItem("karajan-manual-agents", JSON.stringify(agents));
}

function parseManualAgentCommand(raw) {
  const text = (raw || "").trim();
  if (!text) return null;
  const [cmd] = text.split(/\s+/, 1);
  const remainder = text.slice(cmd.length).trim();
  if (cmd === "remove") {
    return { type: "remove", id: remainder.split(/\s+/)[0] || "" };
  }
  if (cmd !== "add") return null;
  const nameMatch = remainder.match(/^"([^"]+)"|^'([^']+)'/);
  const name = (nameMatch ? nameMatch[1] ?? nameMatch[2] : remainder.split(/\s+(?:backend|auth)=/)[0]).trim();
  const backendMatch = remainder.match(/backend=(\S+)/);
  const authMatch = remainder.match(/auth="([^"]*)"|auth='([^']*)'|auth=(\S+)/);
  return {
    type: "add",
    name,
    backend: backendMatch ? backendMatch[1] : "cli",
    auth: authMatch ? authMatch[1] ?? authMatch[2] ?? authMatch[3] ?? "" : "",
  };
}

function runManualAgentCommand() {
  const input = $("#manual-agent-command");
  const parsed = parseManualAgentCommand(input?.value);
  if (!parsed) return toast('Sintaxis: add "Nombre" backend=cli auth="comando" · remove <id>');
  if (parsed.type === "remove") {
    if (!parsed.id) return toast("Indica el id del agente a quitar.");
    removeManualAgent(parsed.id);
  } else {
    if (!parsed.name) return toast("Indica un nombre para el agente.");
    const agents = getManualAgents();
    agents.push({ id: `manual_${Date.now().toString(36)}`, name: parsed.name, backend: parsed.backend, auth: parsed.auth });
    saveManualAgents(agents);
    renderConfigAgentsPanel();
    toast("Agente manual agregado.");
  }
  if (input) input.value = "";
}

function removeManualAgent(id) {
  saveManualAgents(getManualAgents().filter((agent) => agent.id !== id));
  if (state.selectedConfigAgent === id) state.selectedConfigAgent = "";
  renderConfigAgentsPanel();
  toast("Agente manual eliminado.");
}

async function renderAgentsView() {
  await renderConfigAgentsPanel();
  initAgentsSplitter();
  setAgentsSide(state.agentsSideOpen);
}

function findConfigAgent(id = state.selectedConfigAgent) {
  const catalogAgent = (state.catalog || []).find((provider) => provider.name === id);
  if (catalogAgent) return { type: "catalog", agent: catalogAgent };
  const manualAgent = getManualAgents().find((agent) => agent.id === id);
  if (manualAgent) return { type: "manual", agent: manualAgent };
  const fallback = (state.catalog || [])[0];
  return fallback ? { type: "catalog", agent: fallback } : null;
}

function agentSkillFamily(agent) {
  if (agent.name.startsWith("ollama")) return "ollama";
  if (agent.name === "anthropic" || agent.name === "claude-cli") return "claude";
  if (agent.name === "codex") return "codex";
  return null;
}

function compatibleSkills(agent) {
  const family = agentSkillFamily(agent);
  const all = state.skills || [];
  if (!family) return all;
  const matching = all.filter((skill) => (skill.applies_to || []).includes(family));
  const rest = all.filter((skill) => !(skill.applies_to || []).includes(family));
  return matching.length ? [...matching, ...rest] : all;
}

function ensureEntityForProvider(providerName) {
  let entity = (state.entities || []).find((item) => item.provider === providerName);
  if (entity) return entity;
  entity = addEntityFromProvider(providerName, "child");
  return entity || (state.entities || []).find((item) => item.provider === providerName);
}

async function setCatalogProviderInDecision(providerName, enabled) {
  const layout = await api(`/routing-layout/catalog/${encodeURIComponent(providerName)}`, {
    method: enabled ? "POST" : "DELETE",
  });
  state.entities = layout.entities || [];
  state.diagramZoom = layout.zoom || state.diagramZoom;
  state.drawerWidth = layout.drawer_width || state.drawerWidth;
  localStorage.setItem("karajan-decision-entities", JSON.stringify(state.entities));
  normalizeEntityPositions();
  renderAgentsSidePanel();
  await renderConfigAgentsPanel();
  if ($("#providerGroups")) await renderModels();
  else if ($("#view-decision")?.classList.contains("active")) renderDiagram();
  toast(enabled ? "Agente añadido a Decisión." : "Agente quitado de Decisión.");
}

function agentSkillSection(agent) {
  if (!(state.skills || []).length) return "";
  const entity = (state.entities || []).find((item) => item.provider === agent.name);
  const skills = compatibleSkills(agent);
  const selected = new Set(entity?.skills || []);
  const inputClass = entity ? "entity-skill-side" : "agent-skill-provider";
  const inputScope = entity ? `data-entity="${escapeHtml(entity.id)}"` : `data-provider="${escapeHtml(agent.name)}"`;
  return `<section class="agent-skill-card">
    <h3>Skills <span class="cost-tag">${selected.size}</span></h3>
    <p>${entity ? "Sincronizadas con la entidad de Decisión." : "Marca una opción para añadir este proveedor a Decisión."}</p>
    <div class="agent-skill-options">
      ${skills
        .map(
          (skill) => `<label class="agent-skill-option ${selected.has(skill.name) ? "on" : ""}">
        <input class="${inputClass}" type="checkbox" ${inputScope} value="${escapeHtml(skill.name)}" ${selected.has(skill.name) ? "checked" : ""} />
        <span class="agent-skill-option-body">
          <b title="${escapeHtml(skill.description)}">${escapeHtml(skill.name)}</b>
        </span>
        ${skill.repo_url ? `<a href="${escapeHtml(skill.repo_url)}" target="_blank" rel="noreferrer" title="Ver repositorio en GitHub">⎘</a>` : ""}
      </label>`
        )
        .join("")}
    </div>
  </section>`;
}

function renderAgentsSidePanel() {
  const target = $("#agentsSidePanel");
  if (!target) return;
  const found = findConfigAgent();
  if (!found) {
    target.innerHTML = `<div class="config-empty">Selecciona o agrega un agente para ver sus restricciones.</div>`;
    return;
  }
  const { type, agent } = found;
  const status = new Map((state.providers || []).map((p) => [p.provider, p])).get(type === "catalog" ? agent.name : agent.id) || {};
  const label = type === "catalog" ? agent.label : agent.name;
  const backend = type === "catalog" ? agent.backend : agent.backend;
  const auth = type === "catalog"
    ? agent.auth_method === "api_key" ? agent.env_var || "API key" : agent.login_command || agent.auth_method
    : agent.auth || "manual";
  const policy = state.config?.policy || defaultPolicyConfig();
  const tiers = type === "catalog"
    ? Object.entries(agent.tiers || {}).map(([tier, model]) => `<span><small>${escapeHtml(TIER_LABEL[tier] || tier)}</small><b>${escapeHtml(model)}</b></span>`).join("")
    : `<span><small>origen</small><b>manual</b></span>`;
  const runSlot = type === "catalog" ? (agent.login_command ? "login_command" : agent.probe_command ? "probe_command" : null) : null;
  const running = state.agentConsoleRunning === (type === "catalog" ? agent.name : agent.id);
  const result = state.agentConsoleResults?.[type === "catalog" ? agent.name : agent.id];
  const decisionEntity = type === "catalog" ? (state.entities || []).find((item) => item.provider === agent.name) : null;
  target.innerHTML = `
    <article class="agent-detail-card">
      <header>
        <div>
          <span class="eyebrow">${escapeHtml(backend)} · ${type === "catalog" ? "catálogo" : "manual"}</span>
          <h3>${escapeHtml(label)}</h3>
        </div>
        ${type === "catalog" ? `<span class="cost-tag ${agent.is_free ? "free" : "paid"}">${agent.is_free ? "Gratis" : "Pago"}</span>` : ""}
      </header>
      <div class="agent-detail-meta">
        <span><small>Tipo</small><b>${escapeHtml(backend)}</b></span>
        <span><small>Auth</small><b>${escapeHtml(auth)}</b></span>
        <span><small>Estado</small><b>${status.ready ? "listo" : status.available ? "detectado" : "pendiente"}</b></span>
      </div>
      ${type === "catalog" ? `<div class="config-tier-grid">${tiers}</div>` : ""}
      ${type === "catalog" ? `<div class="agent-decision-actions">
        <div>
          <small>Decisión</small>
          <b>${decisionEntity ? "visible en el mapa" : "fuera del mapa"}</b>
        </div>
        ${decisionEntity
          ? `<button type="button" class="agent-console-action" data-decision-agent-remove="${escapeHtml(agent.name)}" aria-label="Quitar agente del mapa de decisión">
              <span class="action-mark">−</span><span><b>Quitar</b><small>Ocultar de Decisión</small></span>
            </button>`
          : `<button type="button" class="agent-console-action primary" data-decision-agent-add="${escapeHtml(agent.name)}" aria-label="Agregar agente al mapa de decisión">
              <span class="action-mark">+</span><span><b>Usar</b><small>Añadir a Decisión</small></span>
            </button>`}
      </div>` : ""}
    </article>
    ${type === "catalog" ? `<section class="agent-console">
      <header>
        <h4>Consola</h4>
        <div class="agent-console-actions">
          ${runSlot ? `<button type="button" class="agent-console-action primary" data-run-provider="${escapeHtml(agent.name)}" data-run-slot="${runSlot}" ${running ? "disabled" : ""} aria-label="${running ? "Conectando proveedor" : "Conectar proveedor"}">
            <span class="action-mark">▶</span><span><b>${running ? "Conectando" : "Conectar"}</b><small>Ejecutar comando</small></span>
          </button>` : ""}
          <button type="button" class="agent-console-action" data-refresh-providers aria-label="Comprobar estado del proveedor">
            <span class="action-mark">✓</span><span><b>Comprobar</b><small>Actualizar estado</small></span>
          </button>
          <button type="button" class="agent-console-action" data-provider-setup="${escapeHtml(agent.name)}" aria-label="Configurar credenciales del proveedor">
            <span class="action-mark">⚙</span><span><b>Configurar</b><small>Credenciales</small></span>
          </button>
          ${agent.signup_url ? `<a class="agent-console-action provider-link" href="${escapeHtml(agent.signup_url)}" target="_blank" rel="noreferrer" aria-label="Abrir sitio del proveedor">
            <span class="action-mark">↗</span><span><b>Proveedor</b><small>Abrir sitio</small></span>
          </a>` : ""}
        </div>
      </header>
      ${result ? `<pre class="agent-console-output ${result.ok ? "ok" : "bad"}">$ ${escapeHtml(result.command || "")}\n${escapeHtml(result.stdout || "")}${result.stderr ? `\n${escapeHtml(result.stderr)}` : ""}\n[${escapeHtml(String(result.returncode ?? "—"))}] ${escapeHtml(result.detail || "")}</pre>` : `<p class="config-note">${runSlot ? "Pulsa Conectar para ejecutar el comando real del catálogo." : "Este proveedor no tiene un comando de conexión definido."}</p>`}
      <div class="provider-setup" data-provider-setup-target="${escapeHtml(agent.name)}" hidden></div>
    </section>` : ""}
    ${type === "catalog" ? agentSkillSection(agent) : ""}
    <section class="agent-policy-card">
      <h3>Restricciones del agente</h3>
      <p>Estas reglas gobiernan cuándo el router bloquea, pide revisión humana o evita ejecución real con este tipo de proveedor.</p>
      <div class="agent-policy-section">
        <h4>Revisión y umbrales</h4>
        <div class="agent-policy-grid-2">
          ${field("Nivel mínimo que exige revisión", selectInput("cfg-policy-human_review_min_level", String(policy.human_review_min_level), ["1", "2", "3", "4", "5"], { 1: "N1", 2: "N2", 3: "N3", 4: "N4", 5: "N5" }))}
          ${field("Umbral de riesgo operacional", numberInput("cfg-policy-operational_risk_review_threshold", policy.operational_risk_review_threshold, "0.1", "0"))}
        </div>
      </div>
      <div class="agent-policy-section">
        <h4>Reglas automáticas</h4>
        <div class="agent-policy-toggle-row">
          <div class="policy-toggle-item"><span>Revisar proveedores de pago</span>${checkbox("cfg-policy-require_review_for_paid_providers", policy.require_review_for_paid_providers)}</div>
          <div class="policy-toggle-item"><span>Revisar credenciales pendientes</span>${checkbox("cfg-policy-require_review_for_missing_credentials", policy.require_review_for_missing_credentials)}</div>
        </div>
      </div>
      <div class="agent-policy-section">
        <h4>Dominios sensibles</h4>
        ${policyChipEditor("sensitive_domains", policy.sensitive_domains, "security, operations, legal...")}
      </div>
      <div class="agent-policy-section">
        <h4>Intenciones críticas</h4>
        ${policyChipEditor("critical_intents", policy.critical_intents, "security_review, deploy_production...")}
      </div>
    </section>
  `;
  bindPolicyAutosave();
}

function renderConfigPolicyPanel() {
  const target = $("#configPolicyPanel");
  if (!target || !state.config) return;
  const policy = state.config.policy || defaultPolicyConfig();
  target.innerHTML = `<div class="policy-layout">
    <section class="fcard">
      <h3>Puerta de revisión humana</h3>
      ${field("Nivel mínimo que exige revisión", selectInput("cfg-policy-human_review_min_level", String(policy.human_review_min_level), ["1", "2", "3", "4", "5"], { 1: "N1", 2: "N2", 3: "N3", 4: "N4", 5: "N5" }))}
      ${field("Umbral de riesgo operacional", numberInput("cfg-policy-operational_risk_review_threshold", policy.operational_risk_review_threshold, "0.1", "0"))}
      ${field("Revisar proveedores de pago", checkbox("cfg-policy-require_review_for_paid_providers", policy.require_review_for_paid_providers))}
      ${field("Revisar credenciales pendientes", checkbox("cfg-policy-require_review_for_missing_credentials", policy.require_review_for_missing_credentials))}
    </section>
    <section class="fcard policy-card">
      <h3>Dominios sensibles</h3>
      ${policyChipEditor("sensitive_domains", policy.sensitive_domains, "security, operations, legal...")}
    </section>
    <section class="fcard policy-card">
      <h3>Intenciones críticas</h3>
      ${policyChipEditor("critical_intents", policy.critical_intents, "security_review, deploy_production...")}
    </section>
    <section class="fcard policy-summary">
      <h3>Resumen operativo</h3>
      <div class="policy-summary-grid">
        <span><b>N${policy.human_review_min_level}</b><small>nivel mínimo</small></span>
        <span><b>${Number(policy.operational_risk_review_threshold).toFixed(1)}</b><small>riesgo</small></span>
        <span><b>${policy.sensitive_domains.length}</b><small>dominios</small></span>
        <span><b>${policy.critical_intents.length}</b><small>intenciones</small></span>
      </div>
      <p>La clasificación queda bloqueada si supera el nivel/riesgo o si coincide con un dominio sensible o intención crítica.</p>
    </section>
  </div>`;
  bindPolicyAutosave();
}

function policyChipEditor(key, values) {
  const selected = new Set(values || []);
  const suggestions = (POLICY_SUGGESTIONS[key] || []).filter((value) => !selected.has(value));
  return `<div class="policy-chip-editor" data-policy-key="${key}">
    <div class="policy-chips">${selected.size
      ? [...selected].map((value) => `<button type="button" class="policy-chip" data-remove-policy-chip="${key}:${escapeHtml(value)}">${escapeHtml(value)} <span>×</span></button>`).join("")
      : `<span class="policy-empty">Sin etiquetas activas.</span>`}</div>
    ${suggestions.length ? `<div class="policy-suggestions">
      ${suggestions.map((value) => `<button type="button" data-suggest-policy-chip="${key}:${escapeHtml(value)}">+ ${escapeHtml(value)}</button>`).join("")}
    </div>` : ""}
  </div>`;
}

function bindPolicyAutosave() {
  $$("#configPolicyPanel input[id^='cfg-policy-'], #configPolicyPanel select[id^='cfg-policy-'], #agentsSidePanel input[id^='cfg-policy-'], #agentsSidePanel select[id^='cfg-policy-']").forEach((control) => {
    const eventName = control.type === "number" ? "input" : "change";
    control.addEventListener(eventName, () => {
      collectPolicyFromPanel();
      renderConfigPolicyPanel();
      renderAgentsSidePanel();
      scheduleFlowSave();
    });
  });
}

function collectPolicyFromPanel() {
  const policy = (state.config.policy ||= defaultPolicyConfig());
  const minLevel = $("#cfg-policy-human_review_min_level");
  const risk = $("#cfg-policy-operational_risk_review_threshold");
  const paid = $("#cfg-policy-require_review_for_paid_providers");
  const missing = $("#cfg-policy-require_review_for_missing_credentials");
  if (minLevel) policy.human_review_min_level = parseInt(minLevel.value, 10) || 5;
  if (risk) policy.operational_risk_review_threshold = parseFloat(risk.value) || 0;
  if (paid) policy.require_review_for_paid_providers = paid.checked;
  if (missing) policy.require_review_for_missing_credentials = missing.checked;
}

function addPolicyChip(key) {
  const input = $(`[data-policy-input="${key}"]`);
  const value = input?.value?.trim();
  if (!value) return;
  addPolicyChipValue(key, value);
}

function addPolicyChipValue(key, value) {
  const clean = String(value || "").trim();
  if (!clean) return;
  const policy = (state.config.policy ||= defaultPolicyConfig());
  const list = new Set(policy[key] || []);
  list.add(clean);
  policy[key] = [...list];
  renderConfigPolicyPanel();
  renderAgentsSidePanel();
  scheduleFlowSave();
}

function removePolicyChip(key, value) {
  const policy = (state.config.policy ||= defaultPolicyConfig());
  policy[key] = (policy[key] || []).filter((item) => item !== value);
  renderConfigPolicyPanel();
  renderAgentsSidePanel();
  scheduleFlowSave();
}

function updateWeightsSum() {
  const sum = CRITERIA.reduce((acc, name) => acc + (parseFloat($(`#cfg-w-${name}`).value) || 0), 0);
  const node = $("#weightsSum");
  node.textContent = `Suma de pesos: ${sum.toFixed(2)} (ideal 1.00)`;
  node.classList.toggle("bad", Math.abs(sum - 1) > 0.001);
}

function collectConfig() {
  collectPolicyFromPanel();
  const c = structuredClone(state.config);
  if (!$("#cfg-profile")) return c;
  c.profile = $("#cfg-profile").value;
  c.backend = $("#cfg-backend").value;
  c.prefer_free = $("#cfg-prefer_free").checked;
  c.orchestration.parallel = $("#cfg-parallel").checked;
  c.orchestration.max_parallel = parseInt($("#cfg-max_parallel").value, 10);
  c.orchestration.subtask_timeout_s = parseInt($("#cfg-subtask_timeout_s").value, 10);
  c.orchestration.max_retries = parseInt($("#cfg-max_retries").value, 10);
  c.orchestration.require_human_review_gate = $("#cfg-review_gate").checked;
  c.orchestration.max_cost_per_task_usd = parseFloat($("#cfg-max_cost_per_task_usd").value) || 0;
  c.orchestration.max_daily_cost_usd = parseFloat($("#cfg-max_daily_cost_usd").value) || 0;
  CRITERIA.forEach((name) => (c.criteria_weights[name] = parseFloat($(`#cfg-w-${name}`).value) || 0));
  c.level_thresholds = c.level_thresholds.map((_, index) => parseFloat($(`#cfg-th-${index}`).value) || 0);
  LEVELS.forEach(([level]) => (c.level_to_model[level] = $(`#cfg-l2m-${level}`).value));
  TIERS.forEach((tier) => {
    c.cost_table[tier] = parseFloat($(`#cfg-cost-${tier}`).value) || 0;
    c.latency_table[tier] = parseInt($(`#cfg-lat-${tier}`).value, 10) || 0;
  });
  return c;
}

async function saveFlow(auto = false) {
  state.config = collectConfig();
  await putConfig(auto ? "Configuración autoguardada." : "Configuración guardada.");
}

function bindFlowAutosave() {
  $$("#flowGrid input, #flowGrid select").forEach((control) => {
    const eventName = control.type === "number" ? "input" : "change";
    control.addEventListener(eventName, () => {
      if (control.id?.startsWith("cfg-w-")) updateWeightsSum();
      scheduleFlowSave();
    });
  });
}

// ---- config plumbing -------------------------------------------------------
async function loadConfig() {
  state.config = await api("/config");
}

async function putConfig(message) {
  try {
    state.config = await api("/config", { method: "PUT", body: JSON.stringify(state.config) });
    toast(message);
  } catch (error) {
    toast(error.message);
  }
}

// ---- boot ------------------------------------------------------------------
function init() {
  initTheme();
  initViews();
  $("#notificationBell")?.addEventListener("click", (event) => {
    event.stopPropagation();
    setNotificationsOpen(!state.notificationsOpen);
  });
  $("#agentNotificationBot")?.addEventListener("click", (event) => {
    event.stopPropagation();
    setAgentNotificationsOpen(!state.agentNotificationsOpen);
  });
  $("#view-flow")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-config-mode]");
    if (button) {
      setConfigMode(button.dataset.configMode);
      return;
    }
    const tab = event.target.closest("[data-config-tab]");
    if (tab) setConfigTab(tab.dataset.configTab);
  });
  $("#toggleMonitorSide")?.addEventListener("click", () => setMonitorSide(!state.monitorSideOpen));
  $("#toggleHumanSide")?.addEventListener("click", () => setHumanSide(!state.humanSideOpen));
  $("#toggleAgentsSide")?.addEventListener("click", () => setAgentsSide(!state.agentsSideOpen));
  initMonitorSplitter();
  initMonitorSubnav();
  initDataviz();
  initHumanSplitter();
  initAgentsSplitter();
  initMonitorBlocks();
  initTaskSearch();
  $("#modelsAdvanced").addEventListener("change", renderModels);
  $("#addHierarchyGroup")?.addEventListener("click", () => createGroup());
  initAutoRefresh();
  initLiveEvents();
  initOnboardingControls();
  initOnboarding();
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target?.id === "manual-agent-command") {
      event.preventDefault();
      runManualAgentCommand();
    }
  });
  document.addEventListener("click", (event) => {
    if (state.notificationsOpen && !event.target.closest("#notificationWrap")) setNotificationsOpen(false);
    if (state.agentNotificationsOpen && !event.target.closest("#agentNotificationWrap")) setAgentNotificationsOpen(false);
    const approve = event.target.closest("[data-approve]");
    if (approve) {
      api(`/tasks/${approve.dataset.approve}/approve-review`, { method: "POST" })
        .then((task) => {
          state.selected = task.task_id;
          toast("Revisión humana aprobada.");
          setNotificationsOpen(false);
          return refreshMonitor();
        })
        .catch((error) => toast(error.message));
      return;
    }
    const notificationTask = event.target.closest("[data-notification-task]");
    if (notificationTask) {
      state.selected = notificationTask.dataset.notificationTask;
      setNotificationsOpen(false);
      $('[data-view="monitor"]')?.click();
      refreshMonitor().catch((error) => toast(error.message));
      return;
    }
    const notificationProvider = event.target.closest("[data-notification-provider]");
    if (notificationProvider) {
      setNotificationsOpen(false);
      setAgentNotificationsOpen(false);
      // Provider configuration lives in the dedicated top-nav "Agentes" tab.
      state.selectedConfigAgent = notificationProvider.dataset.notificationProvider;
      $('[data-view="agents"]')?.click();
      return;
    }
    if (event.target.closest("[data-notification-monitor]")) {
      setNotificationsOpen(false);
      $('[data-view="monitor"]')?.click();
      return;
    }
    const taskLink = event.target.closest("[data-select-task]");
    if (taskLink) {
      state.selected = taskLink.dataset.selectTask;
      const monitorTab = $('[data-view="monitor"]');
      monitorTab?.click();
      refreshMonitor().catch((error) => toast(error.message));
      return;
    }
    const refreshProviders = event.target.closest("[data-refresh-providers]");
    if (refreshProviders) {
      refreshMonitor()
        .then(() => renderAgentsView())
        .then(() => toast("Estado de agentes comprobado."))
        .catch((error) => toast(error.message));
      return;
    }
    const providerSetup = event.target.closest("[data-provider-setup]");
    if (providerSetup) {
      showProviderSetup(providerSetup.dataset.providerSetup);
      return;
    }
    if (event.target.closest("#runManualAgentCommand")) {
      runManualAgentCommand();
      return;
    }
    const runProviderCommand = event.target.closest("[data-run-provider]");
    if (runProviderCommand) {
      executeProviderCommand(runProviderCommand.dataset.runProvider, runProviderCommand.dataset.runSlot);
      return;
    }
    const addDecisionAgent = event.target.closest("[data-decision-agent-add]");
    if (addDecisionAgent) {
      setCatalogProviderInDecision(addDecisionAgent.dataset.decisionAgentAdd, true).catch((error) => toast(error.message));
      return;
    }
    const removeDecisionAgent = event.target.closest("[data-decision-agent-remove]");
    if (removeDecisionAgent) {
      setCatalogProviderInDecision(removeDecisionAgent.dataset.decisionAgentRemove, false).catch((error) => toast(error.message));
      return;
    }
    const agentCard = event.target.closest("[data-agent-card]");
    if (agentCard && !event.target.closest("button, a, input, select, textarea, code")) {
      state.selectedConfigAgent = agentCard.dataset.agentCard;
      setAgentsSide(true);
      renderConfigAgentsPanel();
      return;
    }
    const removeManual = event.target.closest("[data-remove-manual-agent]");
    if (removeManual) {
      removeManualAgent(removeManual.dataset.removeManualAgent);
      return;
    }
    const addPolicy = event.target.closest("[data-add-policy-chip]");
    if (addPolicy) {
      addPolicyChip(addPolicy.dataset.addPolicyChip);
      return;
    }
    const suggestPolicy = event.target.closest("[data-suggest-policy-chip]");
    if (suggestPolicy) {
      const [key, ...rest] = suggestPolicy.dataset.suggestPolicyChip.split(":");
      addPolicyChipValue(key, rest.join(":"));
      return;
    }
    const removePolicy = event.target.closest("[data-remove-policy-chip]");
    if (removePolicy) {
      const [key, ...rest] = removePolicy.dataset.removePolicyChip.split(":");
      removePolicyChip(key, rest.join(":"));
      return;
    }
    const copyPrompt = event.target.closest("[data-copy-prompt]");
    if (copyPrompt) {
      copyConfigPrompt(copyPrompt.dataset.copyPrompt);
      return;
    }
    const selectPrompt = event.target.closest("[data-select-prompt]");
    if (selectPrompt) {
      state.selectedPromptTemplate = selectPrompt.dataset.selectPrompt;
      state.promptTemplateFormOpen = false;
      renderPromptConfiguration();
      return;
    }
    const promptSideMode = event.target.closest("[data-prompt-side-mode]");
    if (promptSideMode) {
      state.promptSideMode = promptSideMode.dataset.promptSideMode;
      renderPromptConfiguration();
      return;
    }
    const selectPromptResource = event.target.closest("[data-select-prompt-resource]");
    if (selectPromptResource) {
      state.selectedPromptResourceId = selectPromptResource.dataset.selectPromptResource;
      renderPromptResourceGrid();
      // The detail card lives in its own always-visible scroll region now, but
      // nudge it into view so a click anywhere in a long list immediately shows
      // the updated detail (traditional mode) or the side detail panel (prompting).
      const detail = $("#traditionalLibraryPanel .traditional-resource-detail") || $(".prompt-resource-detail-panel");
      detail?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    if (event.target.closest("[data-new-prompt-template]")) {
      state.promptSideMode = "templates";
      state.promptTemplateFormOpen = true;
      renderPromptConfiguration();
      $("#newPromptTitle")?.focus();
      return;
    }
    if (event.target.closest("[data-cancel-new-prompt-template]")) {
      state.promptTemplateFormOpen = false;
      renderPromptConfiguration();
      return;
    }
    if (event.target.closest("[data-save-new-prompt-template]")) {
      createPromptTemplateFromForm();
      return;
    }
    const deletePrompt = event.target.closest("[data-delete-prompt-template]");
    if (deletePrompt) {
      deletePromptTemplate(deletePrompt.dataset.deletePromptTemplate);
      return;
    }
    const savePrompt = event.target.closest("[data-save-prompt]");
    if (savePrompt) {
      saveCurrentPromptTemplate(savePrompt.dataset.savePrompt);
      return;
    }
    const insertResource = event.target.closest("[data-insert-prompt-resource]");
    if (insertResource) {
      insertPromptResource(insertResource.dataset.insertPromptResource);
      return;
    }
    if (event.target.closest("[data-toggle-prompt-library]")) {
      state.promptLibraryOpen = !state.promptLibraryOpen;
      renderPromptResourceGrid();
      return;
    }
    const applyPrompt = event.target.closest("[data-apply-prompt]");
    if (applyPrompt) {
      if (applyPrompt.dataset.applyPrompt === "default-config") {
        applyDefaultConfig();
      } else if (applyPrompt.dataset.applyPrompt === "queue-hierarchy") {
        applyQueueConfig();
      } else {
        toast("Primer flujo preparado: copia el prompt o pásalo al agente elegido en la siguiente iteración.");
      }
      return;
    }
    const wizardApplyDefaultBtn = event.target.closest("[data-wizard-apply-default]");
    if (wizardApplyDefaultBtn) {
      wizardApplyDefaultConfig();
      return;
    }
    const wizardRunProviderBtn = event.target.closest("[data-wizard-run-provider]");
    if (wizardRunProviderBtn) {
      wizardRunProvider(wizardRunProviderBtn.dataset.wizardRunProvider, wizardRunProviderBtn.dataset.wizardRunSlot);
      return;
    }
    const wizardInstallSkillBtn = event.target.closest("[data-wizard-install-skill]");
    if (wizardInstallSkillBtn && !wizardInstallSkillBtn.disabled) {
      wizardInstallSkill(wizardInstallSkillBtn.dataset.wizardInstallSkill);
      return;
    }
    const wizardInstallPluginBtn = event.target.closest("[data-wizard-install-plugin]");
    if (wizardInstallPluginBtn && !wizardInstallPluginBtn.disabled) {
      wizardInstallPlugin(wizardInstallPluginBtn.dataset.wizardInstallPlugin);
      return;
    }
    const wizardCopyBtn = event.target.closest("[data-wizard-copy]");
    if (wizardCopyBtn) {
      wizardCopyCommand(wizardCopyBtn.dataset.wizardCopy);
      return;
    }
    if (!event.target.closest(".model-chip-picker")) {
      $$(".model-chip-picker.open").forEach((item) => item.classList.remove("open"));
    }
    if (!event.target.closest(".role-tag-picker")) {
      $$(".role-tag-picker.open").forEach((item) => item.classList.remove("open"));
    }
  });
  document.addEventListener("input", (event) => {
    if (event.target?.id === "promptResourceSearch") {
      state.promptLibraryQuery = event.target.value;
      renderPromptResourceGrid();
      return;
    }
    if (event.target?.id === "configFieldSearch") {
      filterConfigFields(event.target.value);
    }
  });
  document.addEventListener("change", (event) => {
    const riskAck = event.target.closest("[data-wizard-risk-ack]");
    if (riskAck) {
      $$("[data-wizard-install-plugin]").forEach((button) => (button.disabled = !riskAck.checked));
      return;
    }
    const skillBox = event.target.closest(".entity-skill-side");
    const providerSkillBox = event.target.closest(".agent-skill-provider");
    if (!skillBox && !providerSkillBox) return;
    const entity = skillBox
      ? (state.entities || []).find((item) => item.id === skillBox.dataset.entity)
      : ensureEntityForProvider(providerSkillBox.dataset.provider);
    const activeBox = skillBox || providerSkillBox;
    if (!entity) return;
    entity.skills ||= [];
    if (activeBox.checked && !entity.skills.includes(activeBox.value)) entity.skills.push(activeBox.value);
    if (!activeBox.checked) entity.skills = entity.skills.filter((item) => item !== activeBox.value);
    renderAgentsSidePanel();
    if ($("#view-decision")?.classList.contains("active")) renderDiagram();
    scheduleRoutingSave("Skills del agente actualizadas. Guardando…");
  });
  window.addEventListener("resize", () => {
    if ($("#view-decision").classList.contains("active")) scheduleDrawWires();
    if ($("#view-human").classList.contains("active")) {
      syncHumanSideOffset();
      syncHumanSideHeight();
    }
  });
  initDrawerControls();
  initDiagramViewport();

  loadConfig()
    .then(() => Promise.all([
      api("/catalog").then((c) => (state.catalog = c)),
      api("/skills").then((skills) => (state.skills = skills)).catch(() => []),
      loadRoutingLayout(),
      refreshMonitor(),
    ]))
    .then(() => {
      applyDrawerState();
      applyDiagramZoom();
    })
    .catch((error) => toast(error.message));
}

async function copyConfigPrompt(id) {
  const text = $(`[data-prompt-template="${CSS.escape(id)}"]`)?.value;
  if (!text) return toast("No se ha encontrado la plantilla.");
  try {
    await navigator.clipboard.writeText(text);
    toast("Prompt copiado.");
  } catch {
    const textarea = $(`[data-prompt-template="${CSS.escape(id)}"]`);
    textarea?.select();
    document.execCommand("copy");
    toast("Prompt copiado.");
  }
}

async function applyDefaultConfig() {
  const button = $('[data-apply-prompt="default-config"]');
  if (button) {
    button.disabled = true;
    button.textContent = "Aplicando…";
  }
  try {
    const result = await api("/setup/apply-default", { method: "POST" });
    state.defaultConfigResult = result;
    await loadConfig();
    const layout = await api("/routing-layout");
    state.entities = layout.entities || [];
    renderPromptConfiguration();
    toast(
      result.next_steps.length
        ? `Jerarquía restaurada. ${result.next_steps.length} paso(s) pendiente(s) — revisa el editor.`
        : "Jerarquía de producción aplicada: todo listo para delegar tareas reales."
    );
  } catch (error) {
    toast(error.message);
  } finally {
    const refreshedButton = $('[data-apply-prompt="default-config"]');
    if (refreshedButton) {
      refreshedButton.disabled = false;
      refreshedButton.textContent = "Aplicar con agente";
    }
  }
}

async function applyQueueConfig() {
  const button = $('[data-apply-prompt="queue-hierarchy"]');
  if (button) {
    button.disabled = true;
    button.textContent = "Aplicando…";
  }
  try {
    const result = await api("/setup/apply-queue-config", { method: "POST" });
    state.queueConfigResult = result;
    await loadConfig();
    const layout = await api("/routing-layout");
    state.entities = layout.entities || [];
    renderPromptConfiguration();
    toast(
      result.next_steps.length
        ? `Cola y jerarquía activadas. ${result.next_steps.length} paso(s) pendiente(s) — revisa el editor.`
        : "Cola de disponibilidad y validador activados: jerarquía completa lista."
    );
  } catch (error) {
    toast(error.message);
  } finally {
    const refreshedButton = $('[data-apply-prompt="queue-hierarchy"]');
    if (refreshedButton) {
      refreshedButton.disabled = false;
      refreshedButton.textContent = "Aplicar con agente";
    }
  }
}

init();

// ---- Generic modal shell (OpenClaw activation panel, navigation tutorial) --

function openModal(title) {
  $("#appModalTitle").textContent = title;
  $("#appModal").hidden = false;
}

const TUTORIAL_SEEN_KEY = "karajan-tutorial-seen";

function closeModal() {
  $("#appModal").hidden = true;
  // The "?" help icon is a one-time discovery hint, not a permanent nav item —
  // once the user has opened and closed the tutorial once, it's dismissed for
  // good (persisted, not just for this session).
  if (state.tutorialModalOpen) {
    state.tutorialModalOpen = false;
    localStorage.setItem(TUTORIAL_SEEN_KEY, "1");
    const helpBtn = $("#helpTutorialBtn");
    if (helpBtn) helpBtn.hidden = true;
  }
}

function initModalControls() {
  $("#appModalClose")?.addEventListener("click", closeModal);
  $("#appModal")?.addEventListener("click", (event) => {
    if (event.target.id === "appModal") closeModal();
  });
}
initModalControls();

function initHelpButton() {
  const btn = $("#helpTutorialBtn");
  if (btn && localStorage.getItem(TUTORIAL_SEEN_KEY)) btn.hidden = true;
}
initHelpButton();

// ---- First-run onboarding overlay (web equivalent of scripts/setup_production.py) ----

const ONBOARDING_STEPS = 3;

async function initOnboarding() {
  let status;
  try {
    status = await api("/setup/status");
  } catch {
    return; // don't block the app on a status-check failure
  }
  if (status.completed) return;
  $("#onboardingOverlay").hidden = false;
  onboardingGoToStep(1);
  await Promise.all([
    renderOnboardingAgents().catch((error) => toast(error.message)),
    renderOnboardingSkills().catch((error) => toast(error.message)),
    renderOpenClawPanel("#onboardingOpenclaw").catch((error) => toast(error.message)),
  ]);
}

function onboardingGoToStep(step) {
  state.onboardingStep = step;
  $$("#onboardingSteps .onboarding-step-dot").forEach((dot) =>
    dot.classList.toggle("active", Number(dot.dataset.onboardingStep) === step)
  );
  $$(".onboarding-step-panel").forEach((panel) =>
    panel.classList.toggle("active", Number(panel.dataset.onboardingPanel) === step)
  );
  $("#onboardingBack").hidden = step === 1;
  $("#onboardingNext").hidden = step === ONBOARDING_STEPS;
  $("#onboardingFinish").hidden = step !== ONBOARDING_STEPS;
}

async function finishOnboarding() {
  try {
    await api("/setup/complete", { method: "POST" });
  } catch (error) {
    toast(error.message);
  }
  $("#onboardingOverlay").hidden = true;
}

function initOnboardingControls() {
  $("#onboardingNext")?.addEventListener("click", () => onboardingGoToStep(Math.min(ONBOARDING_STEPS, (state.onboardingStep || 1) + 1)));
  $("#onboardingBack")?.addEventListener("click", () => onboardingGoToStep(Math.max(1, (state.onboardingStep || 1) - 1)));
  $("#onboardingFinish")?.addEventListener("click", () => finishOnboarding());
  $("#onboardingSkip")?.addEventListener("click", () => finishOnboarding());
  $("#helpTutorialBtn")?.addEventListener("click", openTutorialModal);
}

async function openTutorialModal() {
  state.tutorialModalOpen = true;
  openModal("Tutorial de navegación");
  const body = $("#appModalBody");
  body.innerHTML = `<div class="config-empty">Cargando…</div>`;
  try {
    const { markdown } = await api("/setup/tutorial");
    body.innerHTML = renderMarkdownBasic(markdown);
  } catch (error) {
    body.innerHTML = `<div class="config-empty">${escapeHtml(error.message)}</div>`;
  }
}

// Tiny "just enough" markdown renderer for the tutorial's fixed, trusted
// content (# / ## headings + plain paragraphs) — not a general-purpose parser.
function renderMarkdownBasic(markdown) {
  return markdown
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (trimmed.startsWith("## ")) return `<h4>${escapeHtml(trimmed.slice(3))}</h4>`;
      if (trimmed.startsWith("# ")) return `<h3>${escapeHtml(trimmed.slice(2))}</h3>`;
      return trimmed ? `<p>${escapeHtml(trimmed)}</p>` : "";
    })
    .join("");
}

async function wizardApplyDefaultConfig() {
  const button = $("[data-wizard-apply-default]");
  if (button) {
    button.disabled = true;
    button.textContent = "Aplicando…";
  }
  try {
    await api("/setup/apply-default", { method: "POST" });
    await loadConfig();
    toast("Jerarquía de referencia aplicada.");
  } catch (error) {
    toast(error.message);
  } finally {
    await renderOnboardingAgents();
  }
}

function wizardRunProvider(name, slot) {
  executeProviderCommand(name, slot).then(() => renderOnboardingAgents());
}

async function renderOnboardingAgents() {
  const target = $("#onboardingAgents");
  if (!target) return;
  let catalogList = state.catalog || [];
  let providers = state.providers || [];
  if (!catalogList.length || !providers.length) {
    try {
      [catalogList, providers] = await Promise.all([api("/catalog"), api("/providers")]);
      state.catalog = catalogList;
      state.providers = providers;
    } catch (error) {
      target.innerHTML = `<div class="fcard"><h3>Agentes y jerarquía</h3><div class="config-empty">${escapeHtml(error.message)}</div></div>`;
      return;
    }
  }
  const status = new Map(providers.map((p) => [p.provider, p]));
  const readyCount = catalogList.filter((p) => status.get(p.name)?.ready).length;
  const firstPending = catalogList.find((p) => !status.get(p.name)?.ready);
  target.innerHTML = `
    <div class="wizard-progress">
      <span>Agente <b>${readyCount}</b> de <b>${catalogList.length}</b> listo${readyCount === 1 ? "" : "s"} — la jerarquía actual (<code>/config</code>, <code>/routing-layout</code>) es el punto de partida.</span>
      <div class="wizard-agent-actions">
        ${firstPending ? `<button type="button" data-scroll-agent="${escapeHtml(firstPending.name)}">Ir al siguiente pendiente</button>` : ""}
        <button type="button" data-wizard-apply-default>Restaurar jerarquía de referencia</button>
      </div>
    </div>
    <div class="config-agent-grid">
      ${catalogList
        .map((provider) => {
          const providerStatus = status.get(provider.name) || {};
          const runSlot = provider.login_command ? "login_command" : provider.probe_command ? "probe_command" : null;
          return `<div class="wizard-agent-row" data-wizard-agent-row="${escapeHtml(provider.name)}">
            ${configAgentCard(provider, providerStatus)}
            <div class="wizard-agent-actions">
              <button type="button" data-provider-setup="${escapeHtml(provider.name)}">Configurar</button>
              ${runSlot ? `<button type="button" data-wizard-run-provider="${escapeHtml(provider.name)}" data-wizard-run-slot="${runSlot}" ${state.agentConsoleRunning === provider.name ? "disabled" : ""}>${state.agentConsoleRunning === provider.name ? "Conectando…" : "Conectar"}</button>` : ""}
              ${provider.signup_url ? `<a href="${escapeHtml(provider.signup_url)}" target="_blank" rel="noreferrer">Abrir consola</a>` : ""}
            </div>
            <div class="provider-setup" data-provider-setup-target="${escapeHtml(provider.name)}" hidden></div>
            ${state.agentConsoleResults?.[provider.name] ? `<pre class="agent-console-output ${state.agentConsoleResults[provider.name].ok ? "ok" : "bad"}">${escapeHtml(state.agentConsoleResults[provider.name].detail || "")}</pre>` : ""}
          </div>`;
        })
        .join("")}
    </div>`;
  target.querySelector("[data-scroll-agent]")?.addEventListener("click", (event) => {
    const name = event.currentTarget.dataset.scrollAgent;
    target.querySelector(`[data-wizard-agent-row="${CSS.escape(name)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

// ---- step 2: skills catalog -------------------------------------------------

function renderSkillsCatalog(skills, { installing } = {}) {
  if (!skills.length) return `<div class="config-empty">No hay skills en el catálogo.</div>`;
  return `<div class="skill-catalog-grid">
    ${skills
      .map((skill) => {
        const busy = installing === skill.name;
        return `<article class="skill-catalog-card" data-installed="${skill.installed}">
          <header>
            <h4>${escapeHtml(skill.name)}</h4>
            <span class="status-dot ${skill.installed ? "ok" : skill.recommended ? "warn" : "bad"}"></span>
          </header>
          <p class="skill-desc">${escapeHtml(skill.description || "Sin descripción.")}</p>
          <div class="skill-meta">
            ${(skill.applies_to || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
            ${skill.recommended ? `<span class="tag">recomendada</span>` : ""}
          </div>
          ${skill.install_command ? `<code class="skill-install-cmd">${escapeHtml(skill.install_command)}</code>` : ""}
          <div class="skill-catalog-actions">
            ${!skill.installed ? `<button type="button" data-wizard-install-skill="${escapeHtml(skill.name)}" ${busy ? "disabled" : ""}>${busy ? "Instalando…" : "Instalar"}</button>` : `<button type="button" disabled>Instalada</button>`}
            ${skill.repo_url ? `<a href="${escapeHtml(skill.repo_url)}" target="_blank" rel="noreferrer">Repositorio</a>` : ""}
          </div>
        </article>`;
      })
      .join("")}
  </div>`;
}

async function renderOnboardingSkills() {
  const target = $("#onboardingSkills");
  if (!target) return;
  let skills = state.skills || [];
  if (!skills.length) {
    try {
      skills = await api("/skills");
      state.skills = skills;
    } catch (error) {
      target.innerHTML = `<div class="fcard"><h3>Skills</h3><div class="config-empty">${escapeHtml(error.message)}</div></div>`;
      return;
    }
  }
  const installedCount = skills.filter((s) => s.installed).length;
  target.innerHTML = `
    <div class="wizard-progress"><span><b>${installedCount}</b> de <b>${skills.length}</b> skills instaladas.</span></div>
    ${renderSkillsCatalog(skills, { installing: state.wizardInstallingSkill })}`;
}

async function wizardInstallSkill(name) {
  state.wizardInstallingSkill = name;
  await renderOnboardingSkills();
  try {
    const result = await api(`/skills/${encodeURIComponent(name)}/install`, { method: "POST" });
    toast(result.ok ? `'${name}' instalada.` : result.detail);
  } catch (error) {
    toast(error.message);
  }
  state.wizardInstallingSkill = null;
  try {
    state.skills = await api("/skills");
  } catch {
    /* keep previous list if the refresh fails */
  }
  await renderOnboardingSkills();
}

// ---- OpenClaw activation panel (opened from the "Arquitectura activa" drawer) ----

function wizardCopyCommand(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast("Comando copiado."),
    () => toast("No se pudo copiar el comando.")
  );
}

function openOpenClawPanel() {
  openModal("Activación OpenClaw");
  renderOpenClawPanel("#appModalBody");
}

// Reused both by the modal opened from the "Arquitectura activa" drawer and
// by onboarding step 3 (#onboardingOpenclaw) — same activation content,
// different host container.
async function renderOpenClawPanel(targetSelector = "#appModalBody") {
  state.openClawPanelTarget = targetSelector;
  const target = $(targetSelector);
  if (!target) return;
  target.innerHTML = `<div class="config-empty">Cargando estado de OpenClaw…</div>`;
  let status, daemonStatus, setupCommands, channels, channelCatalog, plugins;
  try {
    [status, daemonStatus, setupCommands, channels, channelCatalog, plugins] = await Promise.all([
      api("/integrations/openclaw/status"),
      api("/integrations/openclaw/daemon-status"),
      api("/integrations/openclaw/setup-commands"),
      api("/integrations/openclaw/channels").catch(() => []),
      api("/integrations/openclaw/channels/catalog").catch(() => []),
      api("/integrations/openclaw/plugins").catch(() => []),
    ]);
  } catch (error) {
    target.innerHTML = `<div class="fcard"><h3>Activación OpenClaw</h3><div class="config-empty">${escapeHtml(error.message)}</div></div>`;
    return;
  }
  const configuredIds = new Set(channels.map((c) => c.id));
  const catalogOnly = channelCatalog.filter((c) => !configuredIds.has(c.id));
  target.innerHTML = `
    <div class="fcard">
      <h3>Estado</h3>
      <div class="openclaw-status-grid" style="padding:12px">
        <div class="openclaw-status-card"><small>CLI</small><b>${status.cli_available ? "Encontrado" : "No encontrado"}</b></div>
        <div class="openclaw-status-card"><small>Servicio</small><b>${daemonStatus.installed ? "Instalado" : "No instalado"}</b></div>
        <div class="openclaw-status-card"><small>Gateway</small><b>${daemonStatus.running ? "En ejecución" : "Detenido"}</b></div>
        <div class="openclaw-status-card"><small>Alcanzable</small><b>${status.ready ? "Sí" : "No"}</b></div>
      </div>
      <p class="config-note" style="padding:0 12px 12px">${escapeHtml(status.detail || "")}</p>
    </div>

    <div class="fcard">
      <h3>Asistente de configuración (openclaw configure)</h3>
      <div class="openclaw-command-list" style="padding:12px">
        ${setupCommands
          .map(
            (cmd) => `<div class="openclaw-command-row">
          <header><b>${escapeHtml(cmd.section)}</b></header>
          <p>${escapeHtml(cmd.description)}</p>
          <code>${escapeHtml(cmd.command)}</code>
          <button type="button" data-wizard-copy="${escapeHtml(cmd.command)}">Copiar comando</button>
        </div>`
          )
          .join("")}
      </div>
    </div>

    <div class="fcard">
      <h3>Canales (WhatsApp y otros)</h3>
      <div class="openclaw-command-list" style="padding:12px">
        ${channels
          .map(
            (ch) => `<div class="openclaw-command-row">
          <header><b>${escapeHtml(ch.label)}</b><span class="status-dot ${ch.ready ? "ok" : "warn"}"></span></header>
          <p>${escapeHtml(ch.detail || ch.status)}</p>
        </div>`
          )
          .join("")}
        ${catalogOnly
          .map((ch) => {
            const isWhatsapp = ch.id.toLowerCase().includes("whatsapp");
            const command = isWhatsapp ? `openclaw channels login --channel ${ch.id}` : `openclaw channels add --channel ${ch.id} --token-file <ruta-al-token>`;
            return `<div class="openclaw-command-row">
          <header><b>${escapeHtml(ch.label)}</b><span class="status-dot bad"></span></header>
          <p>${isWhatsapp ? "Emparejamiento por código QR — ejecuta este comando en tu terminal, nunca desde el navegador." : "Añade el canal indicando el archivo con el token (no pegues secretos aquí)."}</p>
          <code>${escapeHtml(command)}</code>
          <button type="button" data-wizard-copy="${escapeHtml(command)}">Copiar comando</button>
        </div>`;
          })
          .join("")}
        ${!channels.length && !catalogOnly.length ? `<div class="config-empty">Sin datos de canales (¿está instalado el CLI de OpenClaw?).</div>` : ""}
      </div>
    </div>

    <div class="fcard">
      <h3>Plugins</h3>
      <div class="openclaw-command-list" style="padding:12px">
        <div class="openclaw-risk-gate">
          <input type="checkbox" id="wizardPluginRiskAck" data-wizard-risk-ack />
          <label for="wizardPluginRiskAck">Entiendo que instalar un plugin ejecuta código de terceros (ClawHub) en esta máquina.</label>
        </div>
        ${plugins
          .map(
            (plugin) => `<div class="openclaw-command-row">
          <header><b>${escapeHtml(plugin.name)}</b><span class="status-dot ${plugin.installed ? "ok" : "warn"}"></span></header>
          <p>${escapeHtml(plugin.description || "")}</p>
          ${!plugin.installed && plugin.spec ? `<button type="button" data-wizard-install-plugin="${escapeHtml(plugin.spec)}" disabled>Instalar</button>` : ""}
        </div>`
          )
          .join("")}
        ${!plugins.length ? `<div class="config-empty">Sin plugins detectados (¿está instalado el CLI de OpenClaw?).</div>` : ""}
      </div>
    </div>

    <div class="fcard">
      <h3>Servicio en segundo plano (daemon)</h3>
      <div class="openclaw-command-list" style="padding:12px">
        ${["install", "start", "stop", "restart"]
          .map(
            (action) => `<div class="openclaw-command-row">
          <code>openclaw daemon ${action}</code>
          <button type="button" data-wizard-copy="openclaw daemon ${action}">Copiar comando</button>
        </div>`
          )
          .join("")}
        <p class="config-note">Estas acciones modifican un servicio del sistema — se muestran para ejecutar manualmente en tu terminal, nunca desde este panel.</p>
      </div>
    </div>`;
}

async function wizardInstallPlugin(spec) {
  try {
    const result = await api("/integrations/openclaw/plugins/install", {
      method: "POST",
      body: JSON.stringify({ spec, acknowledge_clawhub_risk: true }),
    });
    toast(result.detail || (result.ok ? "Plugin instalado." : "No se pudo instalar el plugin."));
  } catch (error) {
    toast(error.message);
  }
  await renderOpenClawPanel(state.openClawPanelTarget || "#appModalBody");
}

async function refreshProvidersAndAgents() {
  try {
    const [catalog, providers] = await Promise.all([api("/catalog"), api("/providers")]);
    state.catalog = catalog;
    state.providers = providers;
    await renderAgentsView();
    toast("Conexiones comprobadas.");
  } catch (error) {
    toast(error.message);
  }
}

async function executeProviderCommand(name, slot) {
  state.agentConsoleRunning = name;
  renderAgentsSidePanel();
  state.agentConsoleResults ||= {};
  try {
    state.agentConsoleResults[name] = await api(`/providers/${encodeURIComponent(name)}/run`, {
      method: "POST",
      body: JSON.stringify({ slot }),
    });
  } catch (error) {
    state.agentConsoleResults[name] = { ok: false, command: "", stdout: "", stderr: error.message, detail: error.message };
  }
  state.agentConsoleRunning = null;
  renderAgentsSidePanel();
  refreshProvidersAndAgents().catch(() => null);
}

// ── ISO VIEW MODULE ───────────────────────────────────────────────────────────
/* ═══════════════════════════════════════════════════════════════════════════
   KARAJAN · GAME CONTROL v7 — NPC wandering, wide left panel, bigger grid,
   persistent decisions synced with bell, dynamic structures.
   ═══════════════════════════════════════════════════════════════════════════ */
(function isoViewModule(){
'use strict';

// ── AGENTS (spread across larger 15×15 grid) ─────────────────────────────────
var AGENTS=[
  {id:'claude',   hx:7, hy:4, col:'#D4A828',acc:'#F0C840',name:'Claude',      role:'Orquestador',level:'N5',skills:['Análisis','Código','Planif.'],dataId:'entity-agent-claude',   maxCap:50,ph:0   },
  {id:'codex',    hx:11,hy:4, col:'#9060D8',acc:'#A870F0',name:'Codex CLI',   role:'Elite',      level:'N4',skills:['CLI','Git','Scripts'],       dataId:'entity-backup-codex',   maxCap:30,ph:1.3 },
  {id:'qwen',     hx:3, hy:9, col:'#48C878',acc:'#60E090',name:'Qwen 2.5',    role:'Worker',     level:'N1',skills:['Chat','Texto','Local'],       dataId:'entity-worker-qwen',    maxCap:40,ph:2.6 },
  {id:'deepseek', hx:7, hy:10,col:'#D07828',acc:'#E89040',name:'DeepSeek R1', role:'Razón',      level:'N3',skills:['Lógica','Math','CoT'],        dataId:'entity-worker-deepseek',maxCap:40,ph:0.8 },
  {id:'mistral',  hx:11,hy:8, col:'#4898D0',acc:'#60B0E8',name:'Mistral',     role:'Multilingue',level:'N3',skills:['Idiomas','Resumen','RAG'],    dataId:'entity-worker-mistral', maxCap:40,ph:2.1 },
];

// ── DEMO SCRIPT ──────────────────────────────────────────────────────────────
var DEMO=[
  {ms:0,    fn:'userTask', a:['Optimiza la API REST, analiza logs y documenta en 3 idiomas']},
  {ms:900,  fn:'mode',     a:['claude','thinking']},
  {ms:1100, fn:'card',     a:['claude','Analizando misión…','Evaluando componentes: endpoints, logs, cobertura y rendimiento.','analyzing']},
  {ms:2500, fn:'delegate', a:['claude','codex','Optimiza endpoints REST','Meta: latencia p95 < 100ms en /classify-task y /tasks.','working']},
  {ms:3300, fn:'delegate', a:['claude','deepseek','Analiza logs de errores','Revisa 24h. Identifica fallos de rate-limit y memory leaks.','working']},
  {ms:4100, fn:'delegate', a:['claude','mistral','Documenta API ES/EN/PT','Genera OpenAPI spec con 47 endpoints y ejemplos curl.','working']},
  {ms:4900, fn:'delegate', a:['claude','qwen','Responde queries frecuentes','Standby activo. Resuelve consultas durante las mejoras.','working']},
  {ms:5100, fn:'mode',     a:['claude','idle']},
  {ms:6200, fn:'decision', a:['¿Desplegar cambios a producción?','Codex propone actualizar dependencias en prod. Requiere aprobación humana para continuar.','codex']},
  {ms:9800, fn:'done',     a:['deepseek','Análisis completado ✓','3 bugs críticos: rate-limit 429 en /classify, 2 memory leaks en workers activos.','done']},
  {ms:11500,fn:'done',     a:['mistral','Docs generadas ✓','OpenAPI spec ES/EN/PT lista. 47 endpoints con ejemplos. Lista para deploy.','done']},
  {ms:13500,fn:'done',     a:['qwen','Standby completado','12 queries resueltas. 0 errores. En espera de nuevas instrucciones.','waiting']},
  {ms:15800,fn:'decision', a:['Memory leak activo en worker-qwen','DeepSeek detectó leak creciente. ¿Reiniciar proceso ahora o en ventana de mantenimiento?','deepseek']},
  {ms:18200,fn:'done',     a:['codex','Optimización lista ✓','Endpoints 43% más rápidos. p95=67ms. 12 tests verdes. Listo para deploy.','done']},
  {ms:19500,fn:'card',     a:['claude','Misión completada ✓','Todos los workers terminaron. Pendiente: aprobar deploy y decidir restart de worker.','done']},
  {ms:19800,fn:'mode',     a:['claude','celebrate']},
];

// ── STATE ────────────────────────────────────────────────────────────────────
var cvs=null,ctx2=null;
var W=800,H=600,TW=45,TH=22,OX=400,OY=60;
var tick=0,running=false,lastFlow=0;
var nodeData=[],sparkles=[],links=[];
var selectedId=null,agentTasks={};
var BTNS=[],lastErr='';
var taskCards=[];
var decisions=[];     // persistent until resolved
var dataStacks={};
var agentModes={};
var agentPos={};      // {id:{x,y,tx,ty,timer,phase}}
var effTarget=0,effCur=0,effHistory=[];
var demoRunning=false,demoTimers=[];
var LW=262;           // left panel width
var panelStates={metrics:'open',spec:'open'}; // 'open'|'mini'|'closed'
// Manual pan offset (drag-to-scroll), added on top of the auto-centered
// origin — clamped so the tower cluster can't be dragged fully off-screen.
// Named mapPan* (not pan*) since drawLeftPanel() already has a local panY
// for its own panel y-position bookkeeping.
var mapPanX=0,mapPanY=0,isDraggingMap=false,dragMoved=false;
var dragStartClientX=0,dragStartClientY=0,dragStartPanX=0,dragStartPanY=0;
var PAN_RANGE_X=220,PAN_RANGE_Y=160;
// fixed workstation offsets per agent (relative to home tile)
var WORKSPOTS={
  claude:   {dx:-0.5,dy:-0.8},
  codex:    {dx:-0.9,dy: 0.6},
  qwen:     {dx: 0.8,dy:-0.5},
  deepseek: {dx:-0.6,dy: 0.8},
  mistral:  {dx: 0.7,dy: 0.7},
};
// Tower-only anchor overrides (drawWorkstations), separate from WORKSPOTS which
// still drives the NPC figure's walk target. Claude's tower is pushed back/up so
// the (larger) building no longer sits on top of the (smaller) NPC figure when
// Claude is working/thinking. Other agents fall back to WORKSPOTS unchanged.
var TOWER_OFFSETS={
  claude: {dx:-1.3, dy:-1.5},
  mistral: {dx:-0.2, dy:-0.3},
};

var DECISION_PROVIDER_ALIASES={
  claude: ['claude','anthropic','claude-cli'],
  codex: ['codex','openai'],
  qwen: ['ollama-qwen','qwen'],
  deepseek: ['ollama-deepseek','deepseek'],
  mistral: ['ollama-mistral-nemo','mistral'],
};

function agentUsesDecisionProvider(ag){
  if(typeof state==='undefined'||!state.entities)return false;
  var providers=activeArchitectureProviderNames();
  var aliases=DECISION_PROVIDER_ALIASES[ag.id]||[ag.id];
  return aliases.some(function(alias){
    alias=String(alias||'').toLowerCase();
    return Array.from(providers).some(function(provider){
      provider=String(provider||'').toLowerCase();
      return provider===alias||provider.indexOf(alias)>=0||alias.indexOf(provider)>=0;
    });
  });
}

function decisionTint(ag){
  return agentUsesDecisionProvider(ag)?'#F6C84F':ag.col;
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function iso(gx,gy){return {x:OX+(gx-gy)*TW+mapPanX, y:OY+(gx+gy)*TH+mapPanY};}
function c(h,a){
  if(!h||h.length<7)return 'rgba(128,128,128,'+a+')';
  return 'rgba('+parseInt(h.slice(1,3),16)+','+parseInt(h.slice(3,5),16)+','+parseInt(h.slice(5,7),16)+','+a+')';
}
function rr(x,y,w,h,r){
  if(w<=0||h<=0)return;
  r=Math.min(Math.abs(r||0),Math.abs(w/2),Math.abs(h/2));
  ctx2.moveTo(x+r,y);ctx2.arcTo(x+w,y,x+w,y+h,r);ctx2.arcTo(x+w,y+h,x,y+h,r);
  ctx2.arcTo(x,y+h,x,y,r);ctx2.arcTo(x,y,x+w,y,r);ctx2.closePath();
}
function wrap(txt,maxW,maxL){
  var words=txt.split(' '),lines=[],cur='';
  words.forEach(function(w){var t=cur?cur+' '+w:w;if(ctx2.measureText(t).width>maxW&&cur){lines.push(cur);cur=w;}else cur=t;});
  if(cur)lines.push(cur);return maxL?lines.slice(0,maxL):lines;
}

// ── RESIZE ───────────────────────────────────────────────────────────────────
function resize(){
  if(!cvs)return;
  var rect=cvs.parentElement.getBoundingClientRect();
  W=Math.max(400,rect.width||800);H=Math.max(300,rect.height||600);
  TW=Math.min(42,Math.max(22,W*0.030));TH=TW*0.5;
  // Center the actual bounding box of the agent towers (not a fixed formula)
  // within the viewport band that's free of the header/footer HUD chrome —
  // the towers aren't symmetric around (0,0) in iso-space, so a fixed
  // formula left them visibly off-center.
  var minGX=Infinity,maxGX=-Infinity,minGY=Infinity,maxGY=-Infinity;
  AGENTS.forEach(function(ag){
    minGX=Math.min(minGX,ag.hx);maxGX=Math.max(maxGX,ag.hx);
    minGY=Math.min(minGY,ag.hy);maxGY=Math.max(maxGY,ag.hy);
  });
  var isoMinX=(minGX-maxGY)*TW,isoMaxX=(maxGX-minGY)*TW;
  var isoMinY=(minGX+minGY)*TH,isoMaxY=(maxGX+maxGY)*TH;
  var boxCx=(isoMinX+isoMaxX)/2,boxCy=(isoMinY+isoMaxY)/2;
  var topMargin=40,bottomMargin=52;
  var viewportCx=LW+(W-LW)*0.5,viewportCy=topMargin+(H-topMargin-bottomMargin)*0.5;
  OX=viewportCx-boxCx;
  OY=viewportCy-boxCy;
  var dpr=window.devicePixelRatio||1;
  cvs.width=Math.round(W*dpr);cvs.height=Math.round(H*dpr);
  ctx2.setTransform(dpr,0,0,dpr,0,0);
}

// ── NPC WANDER SYSTEM ────────────────────────────────────────────────────────
function initWander(){
  AGENTS.forEach(function(ag){
    if(!agentPos[ag.id])agentPos[ag.id]={x:ag.hx,y:ag.hy,tx:ag.hx,ty:ag.hy,timer:Math.round(ag.ph*80+60),phase:ag.ph};
  });
}
function setAgentTarget(id,tx,ty){
  var pos=agentPos[id];if(!pos)return;
  pos.tx=Math.max(0.5,Math.min(13.5,tx));
  pos.ty=Math.max(0.5,Math.min(13.5,ty));
}
function updateWander(){
  AGENTS.forEach(function(ag){
    var pos=agentPos[ag.id];if(!pos)return;
    var mode=(agentModes[ag.id]||{mode:'idle'}).mode;
    var dx=pos.tx-pos.x,dy=pos.ty-pos.y;
    var dist=Math.sqrt(dx*dx+dy*dy);
    if(dist>0.04){
      // walk toward target at mode-dependent speed
      var spd=mode==='working'?0.025:mode==='celebrate'?0.025:mode==='thinking'?0.009:0.012;
      var step=Math.min(dist,spd);
      pos.x+=dx/dist*step;pos.y+=dy/dist*step;
    } else {
      // arrived: snap and STAY — no jitter, no new targets
      pos.x=pos.tx;pos.y=pos.ty;
      // idle: micro breathing drift (very small, stays near home)
      if(mode==='idle'){
        if(--pos.timer<=0){
          pos.tx=ag.hx+(Math.random()-0.5)*0.15;
          pos.ty=ag.hy+(Math.random()-0.5)*0.15;
          pos.timer=180+Math.round(Math.random()*120);
        }
      }
      // working / celebrate: completely frozen at workspot, no new targets
    }
  });
}

// ── WORKSTATION BUILDINGS ─────────────────────────────────────────────────────
function drawWorkstations(){
  AGENTS.forEach(function(ag){
    var ws=TOWER_OFFSETS[ag.id]||WORKSPOTS[ag.id];if(!ws)return;
    var wx=ag.hx+ws.dx,wy=ag.hy+ws.dy;
    var p=iso(wx,wy);
    if(p.x+TW<LW||p.x-TW>W||p.y+TH>H+TH)return;
    var mode=(agentModes[ag.id]||{mode:'idle'}).mode;
    var active=mode==='working'||mode==='celebrate';
    var pulse=active?0.5+0.5*Math.abs(Math.sin(tick*0.07+ag.ph)):0;
    var bF=0.48,bTW=TW*bF,bTH=TH*bF,bH=TH*3.2;

    // platform (floor tile for this workstation)
    ctx2.beginPath();
    ctx2.moveTo(p.x,p.y);ctx2.lineTo(p.x+bTW,p.y+bTH);
    ctx2.lineTo(p.x,p.y+2*bTH);ctx2.lineTo(p.x-bTW,p.y+bTH);ctx2.closePath();
    ctx2.fillStyle=c(ag.col,active?0.18+0.12*pulse:0.07);ctx2.fill();
    ctx2.strokeStyle=c(ag.col,active?0.5+0.25*pulse:0.18);ctx2.lineWidth=active?1.1:0.5;ctx2.stroke();

    // building left face
    ctx2.beginPath();
    ctx2.moveTo(p.x-bTW,p.y+bTH);ctx2.lineTo(p.x,p.y+2*bTH);
    ctx2.lineTo(p.x,p.y+2*bTH-bH);ctx2.lineTo(p.x-bTW,p.y+bTH-bH);ctx2.closePath();
    ctx2.fillStyle=c(ag.col,active?0.3+0.1*pulse:0.14);ctx2.fill();
    ctx2.strokeStyle=c(ag.col,active?0.5:0.22);ctx2.lineWidth=0.7;ctx2.stroke();

    // building right face
    ctx2.beginPath();
    ctx2.moveTo(p.x,p.y+2*bTH);ctx2.lineTo(p.x+bTW,p.y+bTH);
    ctx2.lineTo(p.x+bTW,p.y+bTH-bH);ctx2.lineTo(p.x,p.y+2*bTH-bH);ctx2.closePath();
    ctx2.fillStyle=c(ag.col,active?0.2+0.08*pulse:0.08);ctx2.fill();
    ctx2.strokeStyle=c(ag.col,active?0.4:0.18);ctx2.lineWidth=0.7;ctx2.stroke();

    // roof
    ctx2.beginPath();
    ctx2.moveTo(p.x,p.y-bH);ctx2.lineTo(p.x+bTW,p.y+bTH-bH);
    ctx2.lineTo(p.x,p.y+2*bTH-bH);ctx2.lineTo(p.x-bTW,p.y+bTH-bH);ctx2.closePath();
    ctx2.fillStyle=c(ag.col,active?0.45+0.2*pulse:0.22);ctx2.fill();
    ctx2.strokeStyle=c(ag.col,active?0.62:0.28);ctx2.lineWidth=0.7;ctx2.stroke();

    // windows (right face) — glow when active
    var wY=p.y+bTH-bH*0.52;
    var w1X=p.x+bTW*0.1,w2X=p.x+bTW*0.55;
    ctx2.fillStyle=c(ag.acc,active?0.7+0.25*pulse:0.22);
    ctx2.fillRect(w1X,wY,bTW*0.32,bH*0.21);
    ctx2.fillRect(w2X,wY,bTW*0.28,bH*0.21);
    if(active){
      var gl=ctx2.createRadialGradient(w1X+bTW*0.16,wY+bH*0.1,0,w1X+bTW*0.16,wY+bH*0.1,bTW*0.5);
      gl.addColorStop(0,c(ag.acc,0.25*pulse));gl.addColorStop(1,c(ag.acc,0));
      ctx2.fillStyle=gl;ctx2.fillRect(w1X-8,wY-8,bTW*0.7,bH*0.4);
    }

    // door (left face, bottom-center)
    var dX=p.x-bTW*0.35,dY=p.y+2*bTH-bH*0.35;
    ctx2.fillStyle=c(ag.col,active?0.55:0.3);ctx2.fillRect(dX,dY,bTW*0.32,bH*0.32);
    ctx2.strokeStyle=c(ag.col,0.4);ctx2.lineWidth=0.5;ctx2.strokeRect(dX,dY,bTW*0.32,bH*0.32);

    // antenna
    ctx2.strokeStyle=c(ag.col,0.6);ctx2.lineWidth=1;
    ctx2.beginPath();ctx2.moveTo(p.x,p.y-bH);ctx2.lineTo(p.x,p.y-bH-7);ctx2.stroke();
    ctx2.fillStyle=c(ag.acc,active?0.9+0.1*pulse:0.35);
    ctx2.beginPath();ctx2.arc(p.x,p.y-bH-7,active?2.2:1.5,0,Math.PI*2);ctx2.fill();

    // agent name tag above building
    ctx2.fillStyle=c(ag.col,active?0.88:0.38);
    ctx2.font=(active?'bold ':'')+(TH*0.65)+'px system-ui';
    ctx2.textAlign='center';ctx2.textBaseline='bottom';
    ctx2.fillText(ag.name.split(' ')[0].substring(0,5),p.x,p.y-bH-10);
  });
}

// ── FLOOR (15×15) ────────────────────────────────────────────────────────────
function drawFloor(){
  var agHome={};AGENTS.forEach(function(a){agHome[a.hx+','+a.hy]=a;});
  var cells=[];
  for(var gx=0;gx<=14;gx++)for(var gy=0;gy<=14;gy++)cells.push({gx:gx,gy:gy,s:gx+gy});
  cells.sort(function(a,b){return a.s-b.s||a.gx-b.gx;});
  cells.forEach(function(cl){
    var p=iso(cl.gx,cl.gy);
    if(p.x+TW<LW||p.x-TW>W||p.y>H+TH)return; // cull
    var ag=agHome[cl.gx+','+cl.gy];
    // highlight tiles near active NPCs
    var nearCard=false;
    AGENTS.forEach(function(a){
      var pos=agentPos[a.id];
      if(!pos)return;
      var cards=taskCards.filter(function(cr){return cr.agentId===a.id&&cr.status!=='done'&&cr.status!=='waiting';});
      if(cards.length>0){
        var dx=pos.x-cl.gx,dy=pos.y-cl.gy;
        if(dx*dx+dy*dy<2.5)nearCard=true;
      }
    });
    ctx2.beginPath();
    ctx2.moveTo(p.x,p.y);ctx2.lineTo(p.x+TW,p.y+TH);
    ctx2.lineTo(p.x,p.y+2*TH);ctx2.lineTo(p.x-TW,p.y+TH);ctx2.closePath();
    var inDecision=ag&&agentUsesDecisionProvider(ag);
    var tileCol=inDecision?decisionTint(ag):(ag&&ag.col);
    ctx2.fillStyle=ag?c(tileCol,inDecision?0.24:0.14):nearCard?'rgba(100,160,255,0.04)':'rgba(255,255,255,0.018)';
    ctx2.strokeStyle=ag?c(tileCol,inDecision?0.72:0.4):nearCard?'rgba(100,160,255,0.06)':'rgba(255,255,255,0.045)';
    ctx2.lineWidth=0.6;ctx2.fill();ctx2.stroke();
  });
}

// ── DATA STACKS ──────────────────────────────────────────────────────────────
function tickDataStacks(){
  var now=Date.now();
  taskCards.forEach(function(card){
    if(card.status==='done'||card.status==='waiting')return;
    if(!dataStacks[card.agentId])dataStacks[card.agentId]={level:1,born:now};
    else dataStacks[card.agentId].level=Math.min(10,1+Math.floor((now-dataStacks[card.agentId].born)/1500));
  });
}
function drawDataStacks(){
  var now=Date.now();
  AGENTS.forEach(function(ag){
    var ds=dataStacks[ag.id];if(!ds)return;
    var card=taskCards.find(function(cr){return cr.agentId===ag.id;});
    var isDone=!card||(card.status==='done'||card.status==='waiting');
    if(isDone&&!ds.celebrating){ds.celebrating=true;ds.celebAt=now;}
    var pos=agentPos[ag.id]||{x:ag.hx,y:ag.hy};
    var p=iso(pos.x,pos.y);
    var stX=p.x+TW*1.1,stY=p.y+TH*2.1;
    var tw2=TW*0.28,th2=TH*0.28;
    var levels=ds.level;
    if(ds.celebrating){
      var age=(now-ds.celebAt)/1000;
      if(age>1.8){delete dataStacks[ag.id];return;}
      levels=Math.max(0,Math.round(ds.level*(1-age/1.4)));
      stY-=age*25;
    }
    for(var lv=0;lv<levels;lv++){
      var ty=stY-lv*th2*2;
      var fc=ds.celebrating?'#60EE80':ag.col;
      var al=Math.min(0.9,0.45+lv*0.08);
      ctx2.beginPath();ctx2.moveTo(stX,ty);ctx2.lineTo(stX+tw2,ty+th2);
      ctx2.lineTo(stX,ty+2*th2);ctx2.lineTo(stX-tw2,ty+th2);ctx2.closePath();
      ctx2.fillStyle=c(fc,al*0.88);ctx2.fill();
      ctx2.strokeStyle=c(fc,al*0.45);ctx2.lineWidth=0.5;ctx2.stroke();
      if(lv===0){
        ctx2.beginPath();ctx2.moveTo(stX+tw2,ty+th2);ctx2.lineTo(stX+tw2,ty+th2*2);
        ctx2.lineTo(stX,ty+th2*3);ctx2.lineTo(stX,ty+th2*2);ctx2.closePath();
        ctx2.fillStyle=c(fc,al*0.45);ctx2.fill();
      }
    }
    if(!ds.celebrating&&levels>0){
      var ga=0.28+0.2*Math.sin(tick*0.12+ag.ph);
      ctx2.fillStyle=c(ag.acc,ga);ctx2.beginPath();ctx2.arc(stX,stY-levels*th2*2,3,0,Math.PI*2);ctx2.fill();
    }
  });
}

// ── AGENT CHARACTER ──────────────────────────────────────────────────────────
function drawAgent(ag){
  var pos=agentPos[ag.id]||{x:ag.hx,y:ag.hy};
  var mode=(agentModes[ag.id]||{mode:'idle'}).mode;
  var sc=TW/50;
  var p=iso(pos.x,pos.y),cx=p.x,base=p.y+TH;
  var nd=nodeData.find(function(n){return n.id===ag.dataId;});
  var tc=(nd&&nd.task_count)||0;
  var cards=taskCards.filter(function(cr){return cr.agentId===ag.id&&cr.status!=='done';});
  if(cards.length>tc)tc=cards.length;
  var hp=Math.max(0.05,Math.min(1,1-tc/Math.max(1,ag.maxCap)));
  var inDecision=agentUsesDecisionProvider(ag);
  var mapAccent=decisionTint(ag);

  // movement direction tilt
  var pos2=agentPos[ag.id]||{};
  var tiltX=((pos2.tx||ag.hx)-(pos2.x||ag.hx))*3;
  tiltX=Math.max(-0.25,Math.min(0.25,tiltX));

  var breathSpd=mode==='working'?0.07:mode==='thinking'?0.04:0.022;
  var breathAmp=(mode==='working'?2.2:(tc>0?1.6:0.6))*sc;
  var breathe=Math.sin(tick*breathSpd+ag.ph)*breathAmp;
  if(mode==='celebrate')breathe+=Math.abs(Math.sin(tick*0.28+ag.ph))*7*sc;

  var bw=12*sc,bh=18*sc;
  var bodyBot=base-2*sc+breathe,bodyTop=bodyBot-bh,headCY=bodyTop-8*sc;
  // horizontal tilt for walking
  var cx2=cx+tiltX*TW*0.25;

  // working glow
  if(mode==='working'||mode==='thinking'){
    var ga=0.07+0.06*Math.sin(tick*0.09+ag.ph);
    ctx2.fillStyle=c(ag.col,ga);ctx2.beginPath();ctx2.arc(cx2,headCY,22*sc,0,Math.PI*2);ctx2.fill();
  }
  // shadow
  ctx2.globalAlpha=0.2;ctx2.fillStyle='#000';
  ctx2.beginPath();ctx2.ellipse(cx,base,TW*0.58,TH*0.35,0,0,Math.PI*2);ctx2.fill();
  ctx2.globalAlpha=1;
  if(inDecision){
    ctx2.strokeStyle=c(mapAccent,0.86);ctx2.lineWidth=Math.max(1,1.5*sc);
    ctx2.beginPath();ctx2.ellipse(cx,base,TW*0.72,TH*0.48,0,0,Math.PI*2);ctx2.stroke();
  }

  // body
  if(ag.id==='claude'){
    ctx2.fillStyle=ag.col;
    ctx2.beginPath();ctx2.moveTo(cx2-bw*0.4,bodyTop);ctx2.lineTo(cx2+bw*0.4,bodyTop);ctx2.lineTo(cx2+bw*0.7,bodyBot);ctx2.lineTo(cx2-bw*0.7,bodyBot);ctx2.closePath();ctx2.fill();
    ctx2.fillStyle=ag.acc;ctx2.beginPath();ctx2.moveTo(cx2-bw*0.16,bodyTop);ctx2.lineTo(cx2+bw*0.16,bodyTop);ctx2.lineTo(cx2,bodyTop+bh*0.42);ctx2.closePath();ctx2.fill();
    ctx2.strokeStyle='#C8A050';ctx2.lineWidth=2*sc;
    ctx2.beginPath();ctx2.moveTo(cx2+bw*0.82,bodyBot);ctx2.lineTo(cx2+bw*0.82,headCY-12*sc);ctx2.stroke();
    ctx2.fillStyle=ag.acc;ctx2.beginPath();ctx2.arc(cx2+bw*0.82,headCY-13*sc,3*sc,0,Math.PI*2);ctx2.fill();
  } else if(ag.id==='codex'){
    ctx2.fillStyle='#7040A8';ctx2.beginPath();ctx2.rect(cx2-bw*0.42,bodyTop,bw*0.84,bh);ctx2.fill();
    ctx2.fillStyle='#9060D8';ctx2.beginPath();ctx2.rect(cx2-bw*0.35,bodyTop+bh*0.15,bw*0.7,bh*0.25);ctx2.fill();
    ctx2.strokeStyle='#C090FF';ctx2.lineWidth=1.4*sc;
    ctx2.beginPath();ctx2.moveTo(cx2,bodyTop);ctx2.lineTo(cx2,bodyTop-10*sc);ctx2.stroke();
    ctx2.fillStyle='#FF60FF';ctx2.beginPath();ctx2.arc(cx2,bodyTop-11*sc,2.4*sc,0,Math.PI*2);ctx2.fill();
    // typing arm animation when working
    if(mode==='working'){
      var armA=Math.sin(tick*0.25)*0.5;
      ctx2.strokeStyle=c(ag.col,0.7);ctx2.lineWidth=1.5*sc;
      ctx2.beginPath();ctx2.moveTo(cx2+bw*0.4,bodyTop+bh*0.5);ctx2.lineTo(cx2+bw*0.8+armA*bw,bodyTop+bh*0.7);ctx2.stroke();
    }
  } else if(ag.id==='qwen'){
    ctx2.fillStyle='#2A7848';ctx2.beginPath();ctx2.ellipse(cx2,bodyTop+bh*0.5,bw*0.5,bh*0.5,0,0,Math.PI*2);ctx2.fill();
    ctx2.fillStyle='#48C878';ctx2.beginPath();ctx2.ellipse(cx2,bodyTop+bh*0.4,bw*0.42,bh*0.42,0,0,Math.PI*2);ctx2.fill();
    ctx2.fillStyle='#48C878';
    ctx2.beginPath();ctx2.ellipse(cx2-bw*0.62,headCY-2*sc,3*sc,5.5*sc,-0.4,0,Math.PI*2);ctx2.fill();
    ctx2.beginPath();ctx2.ellipse(cx2+bw*0.62,headCY-2*sc,3*sc,5.5*sc,0.4,0,Math.PI*2);ctx2.fill();
  } else if(ag.id==='deepseek'){
    ctx2.fillStyle='#A05020';ctx2.beginPath();ctx2.moveTo(cx2-bw*0.4,bodyTop);ctx2.lineTo(cx2+bw*0.4,bodyTop);ctx2.lineTo(cx2+bw*0.65,bodyBot);ctx2.lineTo(cx2-bw*0.65,bodyBot);ctx2.closePath();ctx2.fill();
    ctx2.fillStyle='rgba(255,200,140,0.38)';
    ctx2.beginPath();ctx2.moveTo(cx2,bodyTop);ctx2.lineTo(cx2-bw*0.15,bodyTop+bh*0.32);ctx2.lineTo(cx2,bodyTop+bh*0.37);ctx2.closePath();ctx2.fill();
    ctx2.beginPath();ctx2.moveTo(cx2,bodyTop);ctx2.lineTo(cx2+bw*0.15,bodyTop+bh*0.32);ctx2.lineTo(cx2,bodyTop+bh*0.37);ctx2.closePath();ctx2.fill();
    // magnifier swings when working
    var mAng=mode==='working'?Math.sin(tick*0.12+ag.ph)*0.4:0;
    ctx2.strokeStyle='#E89040';ctx2.lineWidth=2*sc;
    ctx2.beginPath();ctx2.arc(cx2+bw*0.92+mAng*bw,bodyBot-4*sc,4.5*sc,0,Math.PI*2);ctx2.stroke();
    ctx2.beginPath();ctx2.moveTo(cx2+bw*0.92+bw*0.06+mAng*bw,bodyBot-0.5*sc);ctx2.lineTo(cx2+bw*1.12+mAng*bw,bodyBot+4*sc);ctx2.stroke();
  } else {
    ctx2.fillStyle='#2060A0';ctx2.beginPath();ctx2.moveTo(cx2-bw*0.38,bodyTop);ctx2.lineTo(cx2+bw*0.38,bodyTop);ctx2.lineTo(cx2+bw*0.8,bodyBot+4*sc);ctx2.lineTo(cx2-bw*0.8,bodyBot+4*sc);ctx2.closePath();ctx2.fill();
    ctx2.fillStyle='#4898D0';ctx2.beginPath();ctx2.moveTo(cx2-bw*0.28,bodyTop);ctx2.lineTo(cx2+bw*0.28,bodyTop);ctx2.lineTo(cx2+bw*0.55,bodyBot);ctx2.lineTo(cx2-bw*0.55,bodyBot);ctx2.closePath();ctx2.fill();
    ctx2.fillStyle='#3070B8';ctx2.beginPath();ctx2.arc(cx2,headCY,8.5*sc,Math.PI,0);ctx2.closePath();ctx2.fill();
    // book/scroll when working
    if(mode==='working'){
      var bkA=Math.sin(tick*0.05+ag.ph)*0.2;
      ctx2.fillStyle=c(ag.col,0.6);ctx2.fillRect(cx2-bw*0.8-bkA*bw,bodyBot-bh*0.4,bw*0.5,bh*0.35);
    }
  }

  // head
  ctx2.fillStyle=ag.id==='codex'?'#8050C0':'#C89858';
  ctx2.beginPath();ctx2.arc(cx2,headCY,7*sc,0,Math.PI*2);ctx2.fill();
  if(ag.id==='claude'){
    ctx2.fillStyle=ag.col;ctx2.beginPath();ctx2.moveTo(cx2-9*sc,headCY-2*sc);ctx2.lineTo(cx2+9*sc,headCY-2*sc);ctx2.lineTo(cx2,headCY-19*sc);ctx2.closePath();ctx2.fill();
  } else if(ag.id==='codex'){
    ctx2.fillStyle='rgba(64,255,255,0.52)';ctx2.beginPath();ctx2.rect(cx2-5.5*sc,headCY-2.2*sc,11*sc,4*sc);ctx2.fill();
  }

  // eyes — sleeping/awake/working logic
  var eyeOff=tiltX*6*sc;
  var sleeping=mode==='idle';
  // sleeping: eyes almost always shut, rare drowsy half-open
  var eyeH=sleeping
    ?(((tick+Math.round(ag.ph*90))%260<10)?0.55:0.08)
    :(((tick+Math.round(ag.ph*90))%220>216)?0.1:1);
  ctx2.fillStyle='#1A2030';
  ctx2.beginPath();ctx2.ellipse(cx2-4*sc+eyeOff,headCY-1*sc,1.8*sc,2.2*sc*eyeH,0,0,Math.PI*2);ctx2.fill();
  ctx2.beginPath();ctx2.ellipse(cx2+4*sc+eyeOff,headCY-1*sc,1.8*sc,2.2*sc*eyeH,0,0,Math.PI*2);ctx2.fill();
  if(!sleeping&&(tc>0||mode==='working')){
    ctx2.fillStyle=c(ag.col,0.9);
    ctx2.beginPath();ctx2.arc(cx2-4*sc+eyeOff,headCY-1*sc,1.1*sc,0,Math.PI*2);ctx2.fill();
    ctx2.beginPath();ctx2.arc(cx2+4*sc+eyeOff,headCY-1*sc,1.1*sc,0,Math.PI*2);ctx2.fill();
  }
  // closed-eye line overlay when sleeping
  if(sleeping&&eyeH<0.2){
    ctx2.strokeStyle='rgba(160,120,80,0.7)';ctx2.lineWidth=1.4*sc;
    ctx2.beginPath();ctx2.moveTo(cx2-6.5*sc+eyeOff,headCY-1*sc);ctx2.lineTo(cx2-1.5*sc+eyeOff,headCY-1*sc);ctx2.stroke();
    ctx2.beginPath();ctx2.moveTo(cx2+1.5*sc+eyeOff,headCY-1*sc);ctx2.lineTo(cx2+6.5*sc+eyeOff,headCY-1*sc);ctx2.stroke();
  }
  // mouth
  ctx2.strokeStyle=sleeping?'rgba(100,80,60,0.5)':(tc>0||mode==='working'||mode==='celebrate')?ag.col:'#4A5A6A';
  ctx2.lineWidth=sc*0.85;ctx2.beginPath();
  if(sleeping){ctx2.arc(cx2,headCY+5*sc,2.2*sc,Math.PI+0.3,Math.PI*2-0.3);}  // tiny sleep frown
  else if(tc>0||mode==='celebrate'){ctx2.arc(cx2,headCY+3*sc,3.2*sc,0.2,Math.PI-0.2);}
  else{ctx2.moveTo(cx2-3*sc,headCY+3*sc);ctx2.lineTo(cx2+3*sc,headCY+3*sc);}
  ctx2.stroke();

  // thinking dots
  if(mode==='thinking'){
    var dp=Math.floor(tick/18)%3;
    for(var di=0;di<3;di++){ctx2.fillStyle=c(ag.col,di<=dp?0.9:0.18);ctx2.beginPath();ctx2.arc(cx2+(di-1)*6*sc,headCY-22*sc,2*sc,0,Math.PI*2);ctx2.fill();}
  }
  // sleeping Zzz
  if(sleeping){
    var zt=(tick+Math.round(ag.ph*120))%180;
    var zSizes=[9,11,13];
    var zOffs=[{x:6,y:20},{x:9,y:28},{x:13,y:37}];
    for(var zi=0;zi<3;zi++){
      var zStart=zi*45,zLen=55;
      if(zt>=zStart&&zt<zStart+zLen){
        var zAge=(zt-zStart)/zLen;
        ctx2.globalAlpha=(zAge<0.25?zAge*4:(zAge>0.75?(1-zAge)*4:1))*0.7;
        ctx2.fillStyle='rgba(160,200,255,0.9)';
        ctx2.font='bold '+zSizes[zi]+'px system-ui';ctx2.textAlign='center';ctx2.textBaseline='bottom';
        ctx2.fillText('z',cx2+zOffs[zi].x*sc,headCY-zOffs[zi].y*sc);
        ctx2.globalAlpha=1;
      }
    }
  }
  // working particles
  if(mode==='working'&&tick%20===Math.round(ag.ph*10)%20){
    sparkles.push({x:cx2+(Math.random()-0.5)*10*sc,y:headCY-8*sc,vx:(Math.random()-0.5)*1.2,vy:-0.9-Math.random(),life:1,col:ag.acc,sz:1+Math.random()*1.5});
  }
  // celebrate burst
  if(mode==='celebrate'&&tick%7===0){
    for(var si=0;si<3;si++)sparkles.push({x:cx2+(Math.random()-0.5)*18*sc,y:headCY+(Math.random()-0.5)*18*sc,vx:(Math.random()-0.5)*3,vy:-2-Math.random()*2,life:1,col:ag.acc,sz:2+Math.random()*2});
  }

  // HP bar
  var barW=bw*2.4,barH=3*sc,barX=cx-barW/2,barY=headCY-14*sc;
  ctx2.fillStyle='rgba(6,10,16,0.85)';ctx2.beginPath();rr(barX-1,barY-1,barW+2,barH+2,2);ctx2.fill();
  var hpCol=hp>0.6?'#48C878':hp>0.3?'#D4A828':'#E05050';
  ctx2.fillStyle=hpCol;ctx2.beginPath();rr(barX,barY,Math.max(2,barW*hp),barH,2);ctx2.fill();
  ctx2.fillStyle=c(hpCol,0.75);ctx2.font=Math.round(TW*0.13)+'px monospace';ctx2.textAlign='right';ctx2.textBaseline='middle';
  ctx2.fillText(Math.round(hp*100)+'%',barX+barW,barY-2.5*sc);

  // name
  var nameY=barY-6.5*sc;
  ctx2.font='bold '+Math.round(TW*0.2)+'px system-ui,sans-serif';
  if(inDecision){
    ctx2.fillStyle=c(mapAccent,0.95);
    ctx2.font='800 '+Math.round(TW*0.12)+'px system-ui,sans-serif';
    ctx2.textAlign='center';ctx2.textBaseline='bottom';ctx2.fillText('EN DECISIÓN',cx,nameY-12*sc);
    ctx2.font='bold '+Math.round(TW*0.2)+'px system-ui,sans-serif';
  }
  ctx2.fillStyle=selectedId===ag.id?'#FFF':mapAccent;ctx2.textAlign='center';ctx2.textBaseline='bottom';ctx2.fillText(ag.name,cx,nameY);
  ctx2.font='600 '+Math.round(TW*0.135)+'px system-ui';
  var lw=ctx2.measureText(ag.level).width,lx=cx+ctx2.measureText(ag.name).width/2+3.5*sc;
  ctx2.fillStyle=c(mapAccent,inDecision?0.28:0.2);ctx2.beginPath();rr(lx,nameY-9*sc,lw+5*sc,8*sc,2);ctx2.fill();
  ctx2.strokeStyle=c(mapAccent,inDecision?0.58:0.4);ctx2.lineWidth=0.5;ctx2.beginPath();rr(lx,nameY-9*sc,lw+5*sc,8*sc,2);ctx2.stroke();
  ctx2.fillStyle=mapAccent;ctx2.textAlign='center';ctx2.fillText(ag.level,lx+lw/2+2.5*sc,nameY-1*sc);

  // skill chips
  ctx2.font=Math.round(TW*0.12)+'px system-ui';
  var chipH=7.5*sc,chipGap=2*sc;
  var cws=ag.skills.map(function(s){return ctx2.measureText(s).width+8*sc;});
  var totalCW=cws.reduce(function(a,b){return a+b;},0)+(ag.skills.length-1)*chipGap;
  var chipX=cx-totalCW/2,skillY=nameY-13*sc;
  ag.skills.forEach(function(skill,i){
    var cw=cws[i];
    ctx2.fillStyle=c(ag.col,0.14);ctx2.beginPath();rr(chipX,skillY-chipH,cw,chipH,3);ctx2.fill();
    ctx2.strokeStyle=c(ag.col,0.36);ctx2.lineWidth=0.5;ctx2.beginPath();rr(chipX,skillY-chipH,cw,chipH,3);ctx2.stroke();
    ctx2.fillStyle=c(ag.col,0.88);ctx2.textAlign='center';ctx2.textBaseline='middle';ctx2.fillText(skill,chipX+cw/2,skillY-chipH/2);chipX+=cw+chipGap;
  });

  // task bubble
  if(tc>0){
    var pls=1+Math.sin(tick*0.09+ag.ph)*0.18;
    ctx2.fillStyle=ag.col;ctx2.beginPath();ctx2.arc(cx+bw*0.8,headCY-7*sc,6.5*sc*pls,0,Math.PI*2);ctx2.fill();
    ctx2.fillStyle='rgba(0,0,0,0.8)';ctx2.font='bold '+Math.round(TW*0.16)+'px system-ui';ctx2.textAlign='center';ctx2.textBaseline='middle';ctx2.fillText(tc,cx+bw*0.8,headCY-7*sc);
  }
  // orbit
  var orR=9*sc+Math.sin(tick*0.03)*1.3;
  ctx2.strokeStyle=c(ag.col,0.12);ctx2.lineWidth=sc;ctx2.beginPath();ctx2.arc(cx,headCY,orR,0,Math.PI*2);ctx2.stroke();
  var ang=tick*0.04+ag.ph;
  ctx2.fillStyle=ag.acc;ctx2.beginPath();ctx2.arc(cx+Math.cos(ang)*orR,headCY+Math.sin(ang)*orR,1.6*sc,0,Math.PI*2);ctx2.fill();
  // selection
  if(selectedId===ag.id){
    ctx2.strokeStyle=c(ag.col,0.7);ctx2.lineWidth=2*sc;ctx2.setLineDash([4*sc,3*sc]);ctx2.lineDashOffset=-(tick*1.4)%18;
    ctx2.beginPath();ctx2.ellipse(cx,base,TW*0.8,TH*0.55,0,0,Math.PI*2);ctx2.stroke();ctx2.setLineDash([]);
  }
  ctx2.font=Math.round(TW*0.11)+'px system-ui';ctx2.fillStyle=c(ag.col,0.38);ctx2.textAlign='center';ctx2.textBaseline='top';ctx2.fillText(ag.role,cx,base+1.5*sc);
}

// ── TASK CARDS ───────────────────────────────────────────────────────────────
function drawTaskCards(){
  var now=Date.now();
  taskCards.forEach(function(card){
    var ag=AGENTS.find(function(a){return a.id===card.agentId;});if(!ag)return;
    var pos=agentPos[ag.id]||{x:ag.hx,y:ag.hy};
    var p=iso(pos.x,pos.y);
    var cW=155,cH=72;
    var offX=ag.hx>=7?-(cW+TW*0.5):TW*0.5;
    var cx2=p.x+offX,cy2=p.y-TH*1.2-cH;
    var rightBound=selectedId?(W-cW-212):(W-cW-4);
    cy2=Math.max(8,Math.min(H-cH-8,cy2));cx2=Math.max(LW+4,Math.min(rightBound,cx2));
    var age=(now-card.born)/1000;
    var alpha=Math.min(1,age*3);
    if(card.lifeMs&&(now-card.born)>card.lifeMs-500)alpha=Math.max(0,(card.lifeMs-(now-card.born))/500);
    ctx2.globalAlpha=alpha;
    var sc2=card.status==='done'?'#48C878':card.status==='waiting'?'#D4A828':card.status==='analyzing'?'#9060D8':ag.col;
    ctx2.fillStyle='rgba(8,12,20,0.93)';ctx2.beginPath();rr(cx2,cy2,cW,cH,6);ctx2.fill();
    ctx2.strokeStyle=c(sc2,0.58);ctx2.lineWidth=1;ctx2.beginPath();rr(cx2,cy2,cW,cH,6);ctx2.stroke();
    ctx2.fillStyle=sc2;ctx2.beginPath();ctx2.arc(cx2+9,cy2+9,3,0,Math.PI*2);ctx2.fill();
    ctx2.fillStyle=ag.col;ctx2.font='bold 9px system-ui';ctx2.textAlign='left';ctx2.textBaseline='top';ctx2.fillText(ag.name,cx2+16,cy2+5);
    var sl=card.status==='done'?'HECHO':card.status==='waiting'?'ESPERA':card.status==='analyzing'?'ANÁLISIS':'ACTIVO';
    ctx2.fillStyle=sc2;ctx2.font='bold 7.5px system-ui';ctx2.textAlign='right';ctx2.fillText(sl,cx2+cW-5,cy2+5);
    ctx2.fillStyle='#DDE8F0';ctx2.font='bold 10px system-ui';ctx2.textAlign='left';
    ctx2.fillText((card.title||'').substring(0,23)+(card.title.length>23?'…':''),cx2+5,cy2+20);
    ctx2.fillStyle='rgba(165,192,212,0.72)';ctx2.font='8.5px system-ui';
    var ls=wrap(card.desc,cW-10,2);ls.forEach(function(l,i){ctx2.fillText(l,cx2+5,cy2+33+i*10);});
    if(card.status==='working'||card.status==='analyzing'){
      var pr=((now-card.born)/5500)%1;
      ctx2.fillStyle='rgba(255,255,255,0.07)';ctx2.beginPath();rr(cx2+5,cy2+cH-9,cW-10,4,2);ctx2.fill();
      ctx2.fillStyle=sc2;ctx2.beginPath();rr(cx2+5,cy2+cH-9,Math.max(3,(cW-10)*pr),4,2);ctx2.fill();
    }
    ctx2.strokeStyle=c(sc2,0.25);ctx2.lineWidth=0.7;ctx2.setLineDash([3,4]);
    ctx2.beginPath();ctx2.moveTo(cx2+cW/2,cy2+cH);ctx2.lineTo(p.x,p.y+TH);ctx2.stroke();ctx2.setLineDash([]);
    ctx2.globalAlpha=1;
  });
  var now2=Date.now();
  taskCards=taskCards.filter(function(cr){return !cr.lifeMs||(now2-cr.born)<cr.lifeMs;});
}

// ── DECISION NOTIFICATIONS (persistent, non-blocking) ────────────────────────
// The canvas no longer writes the notification bell (#notificationBadge/
// #notificationSummary). The real renderNotifications() (driven by state.tasks)
// is the single writer; canvas-scripted decisions live on the canvas only.
function escHtml(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function drawDecisions(){
  var now=Date.now();
  var active=decisions.filter(function(d){return !d.resolved;});
  var specH=selectedId?Math.min(195,H-100):0;
  var ny=70+specH+(specH>0?10:0); // below agent spec panel when open
  active.slice(0,3).forEach(function(d){
    var nW=255,nH=110,nX=W-nW-8;
    var age=(now-d.born)/1000,slide=Math.max(0,1-age*5);
    var drawX=nX+slide*(nW+20);
    ctx2.globalAlpha=Math.min(1,age*5);
    var gp=0.65+0.35*Math.abs(Math.sin(tick*0.06));
    // shadow
    ctx2.fillStyle='rgba(0,0,0,0.38)';ctx2.beginPath();rr(drawX+3,ny+4,nW,nH-2,9);ctx2.fill();
    // body
    ctx2.fillStyle='rgba(16,20,30,0.96)';ctx2.beginPath();rr(drawX,ny,nW,nH,8);ctx2.fill();
    // titlebar
    ctx2.fillStyle='rgba(120,70,10,0.85)';ctx2.beginPath();rr(drawX,ny,nW,24,6);ctx2.fill();
    ctx2.strokeStyle='rgba(255,155,30,'+gp+')';ctx2.lineWidth=1.5;ctx2.beginPath();rr(drawX,ny,nW,nH,8);ctx2.stroke();
    // dismiss X in titlebar
    ctx2.globalAlpha=ctx2.globalAlpha; // keep current
    winBtn(drawX+nW-20,ny+4,16,16,'255,80,80','×','dismiss_decision');
    BTNS[BTNS.length-1].d=d; // attach decision ref
    ctx2.globalAlpha=Math.min(1,age*5); // restore
    ctx2.fillStyle='#FFB020';ctx2.font='14px system-ui';ctx2.textAlign='left';ctx2.textBaseline='middle';ctx2.fillText('⚠ DECISIÓN REQUERIDA',drawX+8,ny+12);
    if(d.agentId){ctx2.fillStyle='rgba(255,200,100,0.6)';ctx2.font='8.5px system-ui';ctx2.textAlign='left';ctx2.textBaseline='top';ctx2.fillText('['+d.agentId.toUpperCase()+']',drawX+8,ny+25);}
    ctx2.fillStyle='#E8EEF6';ctx2.font='bold 11px system-ui';
    ctx2.fillText((d.title||'').substring(0,34),drawX+7,ny+37);
    ctx2.fillStyle='rgba(165,192,212,0.8)';ctx2.font='9.5px system-ui';
    var dl=wrap(d.desc,nW-14,2);dl.forEach(function(l,i){ctx2.fillText(l,drawX+7,ny+50+i*11);});
    var bY=ny+nH-23,bH2=18,aW=Math.round((nW-18)/2),aX=drawX+6,rX=aX+aW+6;
    ctx2.fillStyle='rgba(72,200,120,0.2)';ctx2.beginPath();rr(aX,bY,aW,bH2,4);ctx2.fill();
    ctx2.strokeStyle='rgba(72,200,120,0.65)';ctx2.lineWidth=0.8;ctx2.beginPath();rr(aX,bY,aW,bH2,4);ctx2.stroke();
    ctx2.fillStyle='#48C878';ctx2.font='bold 10px system-ui';ctx2.textAlign='center';ctx2.textBaseline='middle';ctx2.fillText('Aprobar',aX+aW/2,bY+bH2/2);
    ctx2.fillStyle='rgba(220,80,80,0.2)';ctx2.beginPath();rr(rX,bY,aW,bH2,4);ctx2.fill();
    ctx2.strokeStyle='rgba(220,80,80,0.65)';ctx2.lineWidth=0.8;ctx2.beginPath();rr(rX,bY,aW,bH2,4);ctx2.stroke();
    ctx2.fillStyle='#E05858';ctx2.font='bold 10px system-ui';ctx2.textAlign='center';ctx2.textBaseline='middle';ctx2.fillText('Rechazar',rX+aW/2,bY+bH2/2);
    BTNS.push({x:aX,y:bY,w:aW,h:bH2,action:'approve',d:d});
    BTNS.push({x:rX,y:bY,w:aW,h:bH2,action:'reject', d:d});
    ctx2.globalAlpha=1;ny+=nH+4;
  });
  // remove old resolved ones after 4s
  decisions=decisions.filter(function(d){return !d.resolved||(Date.now()-d.resolvedAt)<4000;});
}

// ── LEFT PANEL ───────────────────────────────────────────────────────────────
function winBtn(x,y,w,h,col,label,action){
  ctx2.fillStyle='rgba('+col+',0.18)';ctx2.beginPath();rr(x,y,w,h,3);ctx2.fill();
  ctx2.strokeStyle='rgba('+col+',0.55)';ctx2.lineWidth=0.8;ctx2.beginPath();rr(x,y,w,h,3);ctx2.stroke();
  ctx2.fillStyle='rgba('+col+',0.9)';ctx2.font='bold 11px system-ui';ctx2.textAlign='center';ctx2.textBaseline='middle';ctx2.fillText(label,x+w/2,y+h/2);
  BTNS.push({x:x,y:y,w:w,h:h,action:action});
}
function drawLeftPanel(){
  effCur+=(effTarget-effCur)*0.025;
  var st=panelStates.metrics;
  var panH=st==='mini'?26:(H-62);
  var panY=50;
  // closed: show tiny floating tab to reopen
  if(st==='closed'){
    ctx2.fillStyle='rgba(50,90,170,0.85)';ctx2.beginPath();rr(0,panY,24,46,4);ctx2.fill();
    ctx2.fillStyle='rgba(160,200,255,0.9)';ctx2.font='bold 9px system-ui';ctx2.textAlign='center';ctx2.textBaseline='middle';ctx2.fillText('M',12,panY+23);
    BTNS.push({x:0,y:panY,w:24,h:46,action:'open_metrics'});
    return;
  }
  // shadow
  ctx2.fillStyle='rgba(0,0,0,0.4)';ctx2.beginPath();rr(11,panY+4,LW-16,panH-2,12);ctx2.fill();
  // window body
  ctx2.fillStyle='rgba(8,12,22,0.95)';ctx2.beginPath();rr(8,panY,LW-16,panH,10);ctx2.fill();
  // titlebar stripe (26px)
  ctx2.fillStyle='rgba(35,70,150,0.88)';ctx2.beginPath();rr(8,panY,LW-16,26,6);ctx2.fill();
  // border
  ctx2.strokeStyle='rgba(55,95,165,0.4)';ctx2.lineWidth=1;ctx2.beginPath();rr(8,panY,LW-16,panH,10);ctx2.stroke();
  // title
  ctx2.fillStyle='rgba(190,215,255,0.95)';ctx2.font='bold 10px system-ui';ctx2.textAlign='left';ctx2.textBaseline='middle';ctx2.fillText('MÉTRICAS DEL SISTEMA',16,panY+13);
  // window buttons — only minimize (no close). Inset from LW-25 to LW-30 so
  // the button doesn't sit flush against the panel's own right border.
  winBtn(LW-30,panY+5,17,17,'255,190,30',st==='mini'?'▪':'─',st==='mini'?'open_metrics':'mini_metrics');

  if(st==='mini')return;
  var px=16,py=panY+32;
  ctx2.fillStyle='rgba(60,90,150,0.3)';ctx2.beginPath();ctx2.rect(px,py,LW-30,0.5);ctx2.fill();py+=8;

  // efficiency gauge — number drawn inside the arc
  ctx2.fillStyle='rgba(130,170,230,0.6)';ctx2.font='9px system-ui';ctx2.textAlign='left';ctx2.textBaseline='top';
  ctx2.fillText('Ahorro de Claude',px,py);py+=14;
  var effPct=Math.round(effCur);
  var eCol=effPct>70?'#48C878':effPct>35?'#D4A828':'#E05050';
  var gR=46,gCx=px+(LW-30)/2,gCy=py+gR+6;
  // track
  ctx2.strokeStyle='rgba(255,255,255,0.07)';ctx2.lineWidth=9;
  ctx2.beginPath();ctx2.arc(gCx,gCy,gR,Math.PI*0.75,Math.PI*2.25);ctx2.stroke();
  // fill arc
  if(effCur>0){
    ctx2.strokeStyle=eCol;ctx2.lineWidth=9;
    ctx2.beginPath();ctx2.arc(gCx,gCy,gR,Math.PI*0.75,Math.PI*0.75+Math.PI*1.5*(Math.min(effCur,100)/100));ctx2.stroke();
  }
  // soft inner glow
  ctx2.fillStyle=c(eCol,0.07);ctx2.beginPath();ctx2.arc(gCx,gCy,gR-5,0,Math.PI*2);ctx2.fill();
  // large % number
  ctx2.fillStyle=eCol;ctx2.font='bold 34px system-ui';ctx2.textAlign='center';ctx2.textBaseline='middle';
  ctx2.fillText(effPct+'%',gCx,gCy-5);
  ctx2.fillStyle='rgba(140,175,215,0.65)';ctx2.font='8.5px system-ui';
  ctx2.fillText('delegado a workers',gCx,gCy+16);
  py=gCy+gR+14;

  // sparkline
  if(effHistory.length>1){
    ctx2.fillStyle='rgba(130,170,230,0.55)';ctx2.font='9px system-ui';ctx2.textAlign='left';ctx2.textBaseline='top';ctx2.fillText('Progreso',px,py);py+=11;
    var slW=LW-26,slH=28;
    ctx2.fillStyle='rgba(0,0,0,0.32)';ctx2.beginPath();rr(px,py,slW,slH,3);ctx2.fill();
    var hist=effHistory.slice(-22);
    var step2=slW/Math.max(hist.length-1,1);
    // fill
    ctx2.fillStyle='rgba(72,152,208,0.09)';ctx2.beginPath();
    hist.forEach(function(v,i){var hx=px+i*step2,hy=py+slH-(v/100)*slH;if(i===0)ctx2.moveTo(hx,hy);else ctx2.lineTo(hx,hy);});
    ctx2.lineTo(px+(hist.length-1)*step2,py+slH);ctx2.lineTo(px,py+slH);ctx2.closePath();ctx2.fill();
    ctx2.strokeStyle='#4898D0';ctx2.lineWidth=1.2;ctx2.beginPath();
    hist.forEach(function(v,i){var hx=px+i*step2,hy=py+slH-(v/100)*slH;if(i===0)ctx2.moveTo(hx,hy);else ctx2.lineTo(hx,hy);});ctx2.stroke();
    // dot at end
    var lastH=hist[hist.length-1];
    ctx2.fillStyle='#60B0FF';ctx2.beginPath();ctx2.arc(px+(hist.length-1)*step2,py+slH-(lastH/100)*slH,2.5,0,Math.PI*2);ctx2.fill();
    py+=slH+10;
  } else py+=8;

  ctx2.fillStyle='rgba(60,90,150,0.25)';ctx2.beginPath();ctx2.rect(px,py,LW-24,0.5);ctx2.fill();py+=8;
  ctx2.fillStyle='rgba(130,170,230,0.6)';ctx2.font='9px system-ui';ctx2.textAlign='left';ctx2.textBaseline='top';ctx2.fillText('Carga por agente',px,py);py+=12;

  AGENTS.forEach(function(ag){
    var nd=nodeData.find(function(n){return n.id===ag.dataId;});
    var tc=(nd&&nd.task_count)||0;
    var cards=taskCards.filter(function(cr){return cr.agentId===ag.id&&cr.status!=='done';});
    if(cards.length>tc)tc=cards.length;
    var load=Math.min(1,tc/Math.max(1,ag.maxCap));
    var alive=tc>0;
    // status indicator
    if(alive){var mp=0.6+0.4*Math.abs(Math.sin(tick*0.08+ag.ph));ctx2.fillStyle=c(ag.col,mp);ctx2.beginPath();ctx2.arc(px+3,py+6,3,0,Math.PI*2);ctx2.fill();}
    else{ctx2.fillStyle='rgba(80,100,130,0.4)';ctx2.beginPath();ctx2.arc(px+3,py+6,2.5,0,Math.PI*2);ctx2.fill();}
    ctx2.fillStyle=alive?ag.col:'rgba(90,110,140,0.5)';
    ctx2.font=(alive?'bold ':'')+'8.5px system-ui';ctx2.textAlign='left';ctx2.textBaseline='middle';
    ctx2.fillText(ag.name.substring(0,10),px+9,py+6);
    // thicker bar with breathing room from the panel's right edge and a
    // reserved slot for the percentage label so it never touches the bar.
    var numX=LW-16,bW=LW-24-68-34,bX2=px+68;
    ctx2.fillStyle='rgba(255,255,255,0.06)';ctx2.beginPath();rr(bX2,py+1,bW,10,3);ctx2.fill();
    if(load>0){ctx2.fillStyle=ag.col;ctx2.beginPath();rr(bX2,py+1,Math.max(4,bW*load),10,3);ctx2.fill();}
    ctx2.fillStyle=alive?ag.col:'rgba(90,110,140,0.5)';ctx2.font='7.5px monospace';ctx2.textAlign='right';
    ctx2.fillText(Math.round(load*100)+'%',numX,py+6);py+=18;
  });

  py+=5;ctx2.fillStyle='rgba(60,90,150,0.25)';ctx2.beginPath();ctx2.rect(px,py,LW-24,0.5);ctx2.fill();py+=8;

  // decisions count
  var pend=decisions.filter(function(d){return !d.resolved;}).length;
  if(pend>0){
    var dp2=0.7+0.3*Math.abs(Math.sin(tick*0.07));
    ctx2.fillStyle='rgba(255,155,30,'+dp2+')';ctx2.font='bold 9.5px system-ui';ctx2.textAlign='left';ctx2.textBaseline='top';
    ctx2.fillText('⚠ '+pend+' decisión'+(pend>1?'es':'')+' pendiente'+(pend>1?'s':''),px,py);py+=14;
  }
  var wAct=AGENTS.filter(function(ag){return taskCards.some(function(cr){return cr.agentId===ag.id&&cr.status!=='done';});}).length;
  ctx2.fillStyle='rgba(110,150,190,0.65)';ctx2.font='8.5px system-ui';ctx2.textAlign='left';ctx2.textBaseline='top';
  ctx2.fillText('Workers activos: '+wAct+'/'+AGENTS.length,px,py);py+=12;
  if(demoRunning){
    var dmp=0.55+0.45*Math.abs(Math.sin(tick*0.09));ctx2.fillStyle='rgba(80,220,120,'+dmp+')';ctx2.font='bold 8.5px system-ui';
    ctx2.fillText('◉ DEMO EN CURSO',px,py);
  }
}

// ── CONNECTIONS ───────────────────────────────────────────────────────────────
function drawConnections(){
  var claude=AGENTS[0];
  var cp=iso(claude.hx,claude.hy);
  for(var i=1;i<AGENTS.length;i++){
    var ag=AGENTS[i];var nd=nodeData.find(function(n){return n.id===ag.dataId;});
    var active=(nd&&(nd.task_count||0)>0)||taskCards.some(function(cr){return cr.agentId===ag.id&&cr.status!=='done';});
    var dp=iso(ag.hx,ag.hy);
    ctx2.strokeStyle=active?c(ag.col,0.22):c(ag.col,0.07);ctx2.lineWidth=active?1.2:0.5;ctx2.setLineDash(active?[]:[4,8]);
    ctx2.beginPath();ctx2.moveTo(cp.x,cp.y+TH);ctx2.lineTo(dp.x,dp.y+TH);ctx2.stroke();ctx2.setLineDash([]);
  }
}
function spawnSpark(ag){
  var pos=agentPos[ag.id]||{x:ag.hx,y:ag.hy};var p=iso(pos.x,pos.y);
  for(var i=0;i<6;i++)sparkles.push({x:p.x+(Math.random()-0.5)*TW,y:p.y+TH*0.8,vx:(Math.random()-0.5)*2,vy:-1.5-Math.random()*2.5,life:1,col:ag.col,sz:1.5+Math.random()*2.5});
}
function drawSparkles(){
  ctx2.save();
  for(var i=0;i<sparkles.length;i++){var s=sparkles[i];s.x+=s.vx;s.y+=s.vy;s.vy*=0.96;s.life-=0.022;ctx2.globalAlpha=Math.max(0,s.life)*0.85;ctx2.fillStyle=s.col;ctx2.beginPath();ctx2.arc(s.x,s.y,Math.max(0.1,s.sz*s.life),0,Math.PI*2);ctx2.fill();}
  ctx2.restore();
  for(var j=sparkles.length-1;j>=0;j--)if(sparkles[j].life<=0)sparkles.splice(j,1);
}
function drawLinks(){
  for(var k=0;k<links.length;k++){
    var lk=links[k];var src=AGENTS.find(function(a){return a.id===lk.from;}),dst=AGENTS.find(function(a){return a.id===lk.to;});
    if(!src||!dst){lk.prog=2;continue;}
    var sp=iso(src.hx,src.hy),dp2=iso(dst.hx,dst.hy);
    var sx=sp.x,sy=sp.y+TH,dx=dp2.x,dy=dp2.y+TH,cpY=Math.min(sy,dy)-55;
    ctx2.save();ctx2.strokeStyle=c(src.col,0.35);ctx2.lineWidth=1.8;ctx2.setLineDash([5,4]);ctx2.lineDashOffset=-(tick*1.6)%18;
    ctx2.beginPath();ctx2.moveTo(sx,sy);ctx2.quadraticCurveTo((sx+dx)/2,cpY,dx,dy);ctx2.stroke();ctx2.restore();
    var t=Math.min(lk.prog,1),mt=1-t;
    var ox=mt*mt*sx+2*mt*t*(sx+dx)/2+t*t*dx,oy=mt*mt*sy+2*mt*t*cpY+t*t*dy;
    ctx2.fillStyle=src.col;ctx2.beginPath();ctx2.arc(ox,oy,4.5,0,Math.PI*2);ctx2.fill();
    ctx2.fillStyle=c(src.col,0.28);ctx2.beginPath();ctx2.arc(ox,oy,8,0,Math.PI*2);ctx2.fill();
    lk.prog+=0.009;
  }
  links=links.filter(function(l){return l.prog<=1.05;});
}

// ── HUD ──────────────────────────────────────────────────────────────────────
function drawInfoPanel(){
  var ag=AGENTS.find(function(a){return a.id===selectedId;});if(!ag)return;
  var PW=255,PH=Math.min(195,H-100),PX=W-PW-8;
  var PY=70; // always anchored at top-right
  var panH=PH;
  // shadow
  ctx2.fillStyle='rgba(0,0,0,0.4)';ctx2.beginPath();rr(PX+3,PY+4,PW,panH-2,12);ctx2.fill();
  // body
  ctx2.fillStyle='rgba(10,14,22,0.95)';ctx2.beginPath();rr(PX,PY,PW,panH,9);ctx2.fill();
  // titlebar
  ctx2.fillStyle=c(ag.col,0.55);ctx2.beginPath();rr(PX,PY,PW,26,6);ctx2.fill();
  ctx2.strokeStyle=c(ag.col,0.45);ctx2.lineWidth=1.2;ctx2.beginPath();rr(PX,PY,PW,panH,9);ctx2.stroke();
  // title text
  ctx2.font='bold 11px system-ui';ctx2.textAlign='left';ctx2.textBaseline='middle';
  var titleText=ag.name+' '+ag.level;
  var titleWidth=ctx2.measureText(titleText).width; // measure BEFORE switching font below, or this reads the wrong metrics
  ctx2.fillStyle='rgba(255,255,255,0.92)';ctx2.fillText(titleText,PX+10,PY+13);
  ctx2.fillStyle='rgba(255,255,255,0.55)';ctx2.font='9px system-ui';ctx2.fillText(ag.role,PX+10+titleWidth+8,PY+13);
  // only close button (no minimize)
  winBtn(PX+PW-22,PY+5,17,17,'255,70,70','×','close_panel');
  var y2=PY+30,pad=PX+9;
  var nd=nodeData.find(function(n){return n.id===ag.dataId;});
  var tc=(nd&&nd.task_count)||0;
  var cards=taskCards.filter(function(cr){return cr.agentId===ag.id;});if(cards.length>tc)tc=cards.length;
  var hp=Math.max(0.05,Math.min(1,1-tc/Math.max(1,ag.maxCap)));
  ctx2.fillStyle=ag.col;ctx2.font='bold 14px system-ui';ctx2.textAlign='left';ctx2.fillText(ag.name+' '+ag.level,pad,y2);y2+=17;
  ctx2.fillStyle='#7A9AAA';ctx2.font='10px system-ui';ctx2.fillText(ag.role,pad,y2);y2+=14;
  ctx2.fillStyle='rgba(0,0,0,0.5)';ctx2.beginPath();ctx2.rect(pad,y2,PW-18,4);ctx2.fill();
  ctx2.fillStyle=hp>0.6?'#48C878':hp>0.3?'#D4A828':'#E05050';ctx2.beginPath();ctx2.rect(pad,y2,(PW-18)*hp,4);ctx2.fill();
  ctx2.fillStyle='#7A9AAA';ctx2.font='8.5px monospace';ctx2.textAlign='right';ctx2.fillText('HP '+Math.round(hp*100)+'%',PX+PW-9,y2+1);y2+=13;
  ag.skills.forEach(function(s){ctx2.fillStyle=c(ag.col,0.14);ctx2.beginPath();ctx2.rect(pad,y2,PW-18,10);ctx2.fill();ctx2.fillStyle=c(ag.col,0.78);ctx2.font='9px system-ui';ctx2.textAlign='left';ctx2.fillText('▸ '+s,pad+3,y2);y2+=12;});
  y2+=3;
  cards.forEach(function(cr){ctx2.fillStyle='rgba(195,218,238,0.65)';ctx2.font='8.5px system-ui';ctx2.fillText('• '+(cr.title||'').substring(0,26),pad,y2);y2+=11;});
}

function drawHUD(){
  // beacon (BTNS[] already cleared at frame start)
  var bp=0.55+0.45*Math.abs(Math.sin(tick*0.05));
  ctx2.fillStyle='rgba(80,140,220,'+bp+')';ctx2.beginPath();ctx2.arc(W/2,17,7,0,Math.PI*2);ctx2.fill();
  ctx2.fillStyle='#CDE';ctx2.font='bold 10.5px system-ui';ctx2.textAlign='center';ctx2.textBaseline='middle';ctx2.fillText('KARAJAN · Sistema de IA',W/2+14,17);
  // bottom strip
  var sx=LW+6,sy=H-11;
  ctx2.fillStyle='rgba(8,12,20,0.7)';ctx2.beginPath();rr(sx-4,sy-11,AGENTS.length*78+10,16,3);ctx2.fill();
  AGENTS.forEach(function(ag){
    var nd=nodeData.find(function(n){return n.id===ag.dataId;});
    var tc=(nd&&nd.task_count)||0;
    var cards=taskCards.filter(function(cr){return cr.agentId===ag.id&&cr.status!=='done';});
    if(cards.length>tc)tc=cards.length;
    var alive=tc>0;
    ctx2.fillStyle=alive?ag.col:'#2A3A4A';ctx2.beginPath();ctx2.arc(sx,sy,4,0,Math.PI*2);ctx2.fill();
    ctx2.fillStyle=alive?'#EEE':'#4A5A6A';ctx2.font=(alive?'bold ':'')+'9px system-ui';ctx2.textAlign='left';ctx2.textBaseline='middle';
    ctx2.fillText(ag.name,sx+7,sy);sx+=78;
  });
  // buttons
  var BW2=128,BH2=27,BX=W-BW2-8,BY=H-BH2-8;
  ctx2.fillStyle='rgba(80,140,220,0.22)';ctx2.beginPath();rr(BX,BY,BW2,BH2,5);ctx2.fill();
  ctx2.strokeStyle='rgba(80,140,220,0.65)';ctx2.lineWidth=1;ctx2.beginPath();rr(BX,BY,BW2,BH2,5);ctx2.stroke();
  ctx2.fillStyle='#8BC8FF';ctx2.font='bold 11.5px system-ui';ctx2.textAlign='center';ctx2.textBaseline='middle';ctx2.fillText('+ Nueva misión',BX+BW2/2,BY+BH2/2);
  BTNS.push({x:BX,y:BY,w:BW2,h:BH2,action:'new_task'});
  var DW=98,DH=27,DX=BX-DW-6,DY=BY;
  ctx2.fillStyle=demoRunning?'rgba(80,220,120,0.25)':'rgba(220,180,40,0.18)';ctx2.beginPath();rr(DX,DY,DW,DH,5);ctx2.fill();
  ctx2.strokeStyle=demoRunning?'rgba(80,220,120,0.7)':'rgba(220,180,40,0.55)';ctx2.lineWidth=1;ctx2.beginPath();rr(DX,DY,DW,DH,5);ctx2.stroke();
  ctx2.fillStyle=demoRunning?'#80EE80':'#F0D860';ctx2.font='bold 11.5px system-ui';ctx2.textAlign='center';ctx2.textBaseline='middle';
  ctx2.fillText(demoRunning?'Detener':'Demostrar',DX+DW/2,DY+DH/2);
  BTNS.push({x:DX,y:DY,w:DW,h:DH,action:'demo'});
  if(lastErr){ctx2.fillStyle='rgba(180,20,20,0.8)';ctx2.font='10px monospace';ctx2.textAlign='left';ctx2.textBaseline='top';ctx2.fillText('ERR:'+lastErr.substring(0,80),LW+6,6);}
  if(selectedId)drawInfoPanel();
  drawDecisions();
}

// ── DEMO RUNNER ───────────────────────────────────────────────────────────────
var DACT={
  userTask:function(t){spawnSpark(AGENTS[0]);spawnSpark(AGENTS[0]);taskCards.push({agentId:'claude',title:'Misión recibida',desc:t,status:'analyzing',born:Date.now(),lifeMs:28000});},
  mode:function(id,m){
    agentModes[id]={mode:m,since:Date.now()};
    var ag=AGENTS.find(function(a){return a.id===id;});
    var pos=agentPos[id];
    if(!ag||!pos)return;
    if(m==='working'||m==='thinking'){
      var ws=WORKSPOTS[id]||{dx:-0.5,dy:0.5};
      setAgentTarget(id,ag.hx+ws.dx,ag.hy+ws.dy);
    } else if(m==='idle'){
      setAgentTarget(id,ag.hx,ag.hy); // return home to sleep
    } else if(m==='celebrate'){
      pos.timer=12;
      if(ag)spawnSpark(ag);
    }
  },
  card:function(id,title,desc,status){
    taskCards=taskCards.filter(function(cr){return cr.agentId!==id||cr.status==='working';});
    taskCards.push({agentId:id,title:title,desc:desc,status:status,born:Date.now(),lifeMs:26000});
    if(status==='done'){DACT.mode(id,'celebrate');}
  },
  delegate:function(from,to,title,desc,status){
    var dst=AGENTS.find(function(a){return a.id===to;});if(dst){links.push({from:from,to:to,prog:0});spawnSpark(dst);}
    DACT.mode(to,'working');
    taskCards.push({agentId:to,title:title,desc:desc,status:status,born:Date.now(),lifeMs:24000});
    effTarget=Math.min(98,effTarget+17);effHistory.push(effTarget);if(effHistory.length>30)effHistory.shift();
  },
  done:function(id,title,desc,status){
    taskCards=taskCards.filter(function(cr){return cr.agentId!==id;});
    taskCards.push({agentId:id,title:title,desc:desc,status:status,born:Date.now(),lifeMs:8000});
    DACT.mode(id,'celebrate');
    var ds=dataStacks[id];if(ds){ds.celebrating=true;ds.celebAt=Date.now();}
    setTimeout(function(){DACT.mode(id,'idle');},3800); // return home → sleep
  },
  decision:function(title,desc,agentId){
    decisions.push({title:title,desc:desc,agentId:agentId,born:Date.now(),resolved:false});
  }
};
function startDemo(){
  if(demoRunning)return;stopDemo();stopReal();demoRunning=true;
  taskCards=[];links=[];sparkles=[];dataStacks={};
  // keep existing unresolved decisions, only clear resolved ones
  decisions=decisions.filter(function(d){return !d.resolved;});
  effTarget=0;effCur=0;effHistory=[];
  AGENTS.forEach(function(ag){agentModes[ag.id]={mode:'idle',since:Date.now()};});
  DEMO.forEach(function(step){demoTimers.push(setTimeout(function(){if(DACT[step.fn])DACT[step.fn].apply(null,step.a);},step.ms));});
  demoTimers.push(setTimeout(function(){demoRunning=false;},23000));
}
function stopDemo(){demoTimers.forEach(clearTimeout);demoTimers=[];demoRunning=false;}

// ── REAL TASK ANIMATION ───────────────────────────────────────────────────────
// Drives the same canvas primitives (DACT) from real backend task records
// (GET /tasks, GET /tasks/{id}) instead of the scripted DEMO. The demo stays as
// the empty-state showcase (no task history). Live task_changed SSE events call
// karajanCanvas.onTaskChanged(id) to re-animate a task as it advances.
var realRunning=false,realTimers=[],pendingTaskId=null,bootstrapped=false,lastPlayedSig='';
function stopReal(){realTimers.forEach(clearTimeout);realTimers=[];realRunning=false;}
function realSched(ms,fn){realTimers.push(setTimeout(fn,ms));}
// provider / model_used → animation agent-node id (best-effort)
function mapAgentNode(s){
  s=(s||'').toLowerCase();
  if(s.indexOf('claude')>=0)return 'claude';
  if(s.indexOf('codex')>=0)return 'codex';
  if(s.indexOf('deepseek')>=0)return 'deepseek';
  if(s.indexOf('mistral')>=0)return 'mistral';
  if(s.indexOf('qwen')>=0)return 'qwen';
  return null;
}
function tierLabelES(t){
  t=(t||'').toLowerCase();
  if(t.indexOf('cheap')>=0)return 'económico';
  if(t.indexOf('medium')>=0)return 'intermedio';
  if(t.indexOf('strong')>=0)return 'potente';
  return t;
}
function snip(s,n){s=(s||'').replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n)+'…':s;}
function fetchTaskRecord(id){
  return fetch('/tasks/'+encodeURIComponent(id)).then(function(r){return r.ok?r.json():null;}).catch(function(){return null;});
}
// Signature so we don't replay the identical state twice in a row (e.g. an
// enterView bootstrap right after a live event for the same task).
function taskSig(task){
  var d=task.delegation;
  return (task.task_id||'')+'|'+(task.status||'')+'|'+((d&&d.executions&&d.executions.length)||0)
    +'|'+((d&&d.executions&&d.executions.filter(function(e){return e.status;}).map(function(e){return e.status;}).join(','))||'');
}
function playTaskRecord(task){
  if(!task||!task.classification)return;
  var sig=taskSig(task);
  if(sig===lastPlayedSig&&realRunning)return;
  lastPlayedSig=sig;
  stopDemo();stopReal();
  realRunning=true;
  // reset transient canvas state (mirrors startDemo; leaves nodeData/poll data)
  taskCards=[];links=[];sparkles=[];dataStacks={};
  decisions=decisions.filter(function(d){return !d.resolved;});
  effTarget=0;effCur=0;effHistory=[];
  AGENTS.forEach(function(ag){agentModes[ag.id]={mode:'idle',since:Date.now()};});

  var cls=task.classification;
  var prompt=task.prompt||cls.original_prompt||cls.prompt||'Tarea';
  var domain=(cls.domain||[]).slice(0,2).join(', ')||'general';
  var summary='Dominio: '+domain+(cls.intent?(' · Intención: '+cls.intent):'')+(cls.complexity_level?(' · Nivel: '+cls.complexity_level):'');
  realSched(0,function(){DACT.userTask(prompt);});
  realSched(700,function(){DACT.mode('claude','thinking');});
  realSched(1000,function(){DACT.card('claude','Clasificando…',summary,'analyzing');});

  var del=task.delegation;
  var execs=(del&&del.executions)||[];
  if(execs.length){
    var subMap={};(cls.subtasks||[]).forEach(function(s){subMap[s.id]=s;});
    var usedFallback={};
    var resolveNode=function(ex){
      var node=mapAgentNode(ex.model_used)||mapAgentNode(ex.backend);
      if(node)return node;
      // fall back to a distinct worker node, else the elite codex node
      var order=['codex','qwen','deepseek','mistral'];
      for(var i=0;i<order.length;i++){if(!usedFallback[order[i]]){usedFallback[order[i]]=1;return order[i];}}
      return 'codex';
    };
    var delBase=2400;
    execs.forEach(function(ex,i){
      var node=resolveNode(ex);ex._node=node;
      var sub=subMap[ex.subtask_id]||{};
      var subName=sub.name||ex.subtask_id||'Subtarea';
      var tgt=ex.model_used||sub.recommended_model||cls.recommended_model||'';
      var tier=tierLabelES(sub.recommended_model||cls.recommended_model);
      var meta='Modelo: '+(tgt||'—')+(tier?(' ('+tier+')'):'');
      realSched(delBase+i*750,function(){DACT.delegate('claude',node,snip(subName,40),meta,'working');});
    });
    realSched(delBase+200,function(){DACT.mode('claude','idle');});
    var doneBase=delBase+execs.length*750+1600;
    execs.forEach(function(ex,i){
      var node=ex._node;
      var ok=!ex.error&&['success','completed','ok','done'].indexOf((ex.status||'').toLowerCase())>=0;
      var cost=ex.estimated_cost_usd!=null?('$'+Number(ex.estimated_cost_usd).toFixed(4)):'';
      var lat=ex.latency_ms!=null?(Math.round(ex.latency_ms)+'ms'):'';
      var costLat=[cost,lat].filter(Boolean).join(' · ');
      realSched(doneBase+i*900,function(){
        if(ok){
          var meta=[snip(ex.output,80),costLat].filter(Boolean).join(' — ')||'Ejecutado';
          DACT.done(node,'✓ Completado',meta,'done');
        } else {
          var err=snip(ex.error||ex.output,90)||'Fallo en ejecución';
          DACT.done(node,'✗ Error',[err,costLat].filter(Boolean).join(' — '),'waiting');
        }
      });
    });
    var endT=doneBase+execs.length*900+1600;
    var totCost=del.total_estimated_cost_usd!=null?('$'+Number(del.total_estimated_cost_usd).toFixed(4)):'';
    var totLat=del.total_latency_ms!=null?(Math.round(del.total_latency_ms)+'ms'):'';
    realSched(endT,function(){DACT.card('claude','Misión completada ✓','Agentes: '+execs.length+([totCost,totLat].filter(Boolean).length?(' · '+[totCost,totLat].filter(Boolean).join(' · ')):''),'done');DACT.mode('claude','celebrate');});
    realSched(endT+500,realDone);
  } else {
    // classification only, delegation pending
    if(cls.requires_human_review){
      realSched(1900,function(){DACT.decision('Revisión humana requerida',snip(cls.reason,120)||'Esta tarea requiere aprobación antes de delegar.','claude');});
    }
    realSched(4200,function(){DACT.mode('claude','idle');realDone();});
  }
}
function realDone(){
  realRunning=false;
  var p=pendingTaskId;pendingTaskId=null;
  if(p)onTaskChangedReal(p);
}
// Called from the outer SSE dispatcher on a task_changed event (human view only).
function onTaskChangedReal(taskId){
  if(!taskId)return;
  if(realRunning){pendingTaskId=taskId;return;} // queue latest; play after current
  fetchTaskRecord(taskId).then(function(task){
    if(task&&task.classification)playTaskRecord(task);
  });
}
// Called on entering / activating the human view: real history → animate the
// newest task; empty → play the scripted demo so the view is never dead.
function bootstrapCanvas(){
  if(bootstrapped||demoRunning||realRunning)return;
  bootstrapped=true;
  fetch('/tasks?limit=1').then(function(r){return r.ok?r.json():null;}).then(function(list){
    if(list&&list.length&&list[0]&&list[0].classification){playTaskRecord(list[0]);}
    else{startDemo();}
  }).catch(function(){if(!demoRunning&&!realRunning)startDemo();});
}
// Expose the hooks the outer app scope needs (SSE + view switching). refreshNodes
// lets the shared initLiveEvents() dispatcher refresh the left-panel per-agent
// metrics (nodeData) on run events, replacing this module's old private 5s poll.
window.karajanCanvas={onTaskChanged:onTaskChangedReal,bootstrap:bootstrapCanvas,playTaskRecord:playTaskRecord,refreshNodes:poll};

// ── MISSION INPUT ─────────────────────────────────────────────────────────────
function showMissionInput(){
  if(document.getElementById('k-ov'))return;
  var ov=document.createElement('div');ov.id='k-ov';
  ov.style.cssText='position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);z-index:9999;font-family:system-ui,sans-serif;';
  ov.innerHTML='<div style="background:#0E1520;border:1.5px solid #4898D0;border-radius:11px;padding:20px;width:360px;max-width:90vw;">'
    +'<div style="color:#4898D0;font-weight:bold;font-size:14px;margin-bottom:5px;">+ Nueva misión para Karajan</div>'
    +'<div style="color:#8AB0C8;font-size:11px;margin-bottom:11px;">Claude analizará y delegará a los agentes adecuados.</div>'
    +'<textarea id="k-tx" placeholder="Ej: Analiza el rendimiento de la API..." style="width:100%;box-sizing:border-box;height:68px;background:#060C14;border:1px solid #2A4060;border-radius:5px;color:#CDE;padding:7px;font-size:12px;resize:none;outline:none;"></textarea>'
    +'<div style="display:flex;gap:7px;margin-top:11px;">'
    +'<button id="k-cn" style="flex:1;padding:7px;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.3);border-radius:5px;color:#FF8080;cursor:pointer;font-size:11px;">Cancelar</button>'
    +'<button id="k-sn" style="flex:2;padding:7px;background:rgba(72,152,208,0.2);border:1px solid rgba(72,152,208,0.5);border-radius:5px;color:#8BC8FF;cursor:pointer;font-weight:bold;font-size:11px;">Enviar misión</button>'
    +'</div></div>';
  document.body.appendChild(ov);
  var txt=document.getElementById('k-tx');txt.focus();
  document.getElementById('k-cn').onclick=function(){ov.remove();};
  document.getElementById('k-sn').onclick=function(){
    var val=txt.value.trim();if(!val)return;ov.remove();
    DACT.userTask(val);DACT.mode('claude','thinking');
    setTimeout(function(){DACT.mode('claude','idle');},5000);
    fetch('/classify-task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:val})}).then(function(){poll();}).catch(function(){});
  };
  ov.addEventListener('keydown',function(e){if(e.key==='Escape')ov.remove();});
}

// ── POLL ─────────────────────────────────────────────────────────────────────
function poll(){
  Promise.all([
    fetch('/observability').then(function(r){return r.ok?r.json():null;}).catch(function(){return null;}),
    fetch('/tasks?limit=30').then(function(r){return r.ok?r.json():null;}).catch(function(){return null;})
  ]).then(function(res){
    var obs=res[0];
    if(obs){
      if(obs.nodes)nodeData=obs.nodes;
      var flow=obs.execution_flow||[];
      flow.slice(lastFlow).forEach(function(ev){
        if((ev.event_type||'')!=='task_delegated')return;
        var tgt=(ev.target_node||'').toLowerCase();
        var toId=tgt.indexOf('qwen')>=0?'qwen':tgt.indexOf('deepseek')>=0?'deepseek':tgt.indexOf('mistral')>=0?'mistral':tgt.indexOf('codex')>=0?'codex':null;
        if(toId){links.push({from:'claude',to:toId,prog:0});var dst=AGENTS.find(function(a){return a.id===toId;});if(dst)spawnSpark(dst);}
      });
      lastFlow=flow.length;
    }
    if(res[1]){agentTasks={};res[1].forEach(function(t){var tgt=((t.delegation&&t.delegation.target_node)||'').toLowerCase();var id=tgt.indexOf('qwen')>=0?'qwen':tgt.indexOf('deepseek')>=0?'deepseek':tgt.indexOf('mistral')>=0?'mistral':tgt.indexOf('codex')>=0?'codex':'claude';if(!agentTasks[id])agentTasks[id]=[];if(agentTasks[id].length<5)agentTasks[id].push({prompt:t.classification&&t.classification.prompt});});}
  }).catch(function(){});
}

// ── FRAME ────────────────────────────────────────────────────────────────────
function frame(){
  if(running&&cvs)requestAnimationFrame(frame);
  tick++;
  try{
    BTNS=[];
    ctx2.globalAlpha=1;ctx2.clearRect(0,0,W,H);
    ctx2.fillStyle='#0C0F14';ctx2.fillRect(0,0,W,H);
    var bg=ctx2.createRadialGradient(OX,OY+80,40,OX,OY+80,Math.max(W,H)*0.85);
    bg.addColorStop(0,'rgba(18,28,48,0.85)');bg.addColorStop(1,'rgba(0,0,0,0)');
    ctx2.fillStyle=bg;ctx2.fillRect(0,0,W,H);
    updateWander();tickDataStacks();
    drawFloor();drawWorkstations();drawConnections();
    var sorted=AGENTS.slice().sort(function(a,b){var pa=agentPos[a.id]||{y:a.hy},pb=agentPos[b.id]||{y:b.hy};return (pa.x+pa.y)-(pb.x+pb.y);});
    for(var i=0;i<sorted.length;i++){try{drawAgent(sorted[i]);}catch(ae){lastErr=sorted[i].id+':'+ae.message;}}
    drawDataStacks();drawLinks();drawSparkles();ctx2.globalAlpha=1;
    drawTaskCards();drawLeftPanel();drawHUD();
    AGENTS.forEach(function(ag){var nd=nodeData.find(function(n){return n.id===ag.dataId;});if(nd&&(nd.task_count||0)>0&&Math.random()<0.014)spawnSpark(ag);});
    lastErr='';
  }catch(e){lastErr='FRAME:'+e.message;ctx2.globalAlpha=1;ctx2.fillStyle='rgba(180,20,20,0.8)';ctx2.font='12px monospace';ctx2.textAlign='left';ctx2.textBaseline='top';ctx2.fillText('Err:'+e.message,LW+6,6);}
}

// ── MAP PAN (drag to scroll within a clamped range) ──────────────────────────
function clampMapPan(){
  mapPanX=Math.max(-PAN_RANGE_X,Math.min(PAN_RANGE_X,mapPanX));
  mapPanY=Math.max(-PAN_RANGE_Y,Math.min(PAN_RANGE_Y,mapPanY));
}
function onMapPointerDown(e){
  if(!cvs)return;
  var rect=cvs.getBoundingClientRect();
  var mx=(e.clientX-rect.left)*(W/rect.width);
  if(mx<LW)return; // don't hijack drags starting over the left metrics panel
  isDraggingMap=true;dragMoved=false;
  dragStartClientX=e.clientX;dragStartClientY=e.clientY;
  dragStartPanX=mapPanX;dragStartPanY=mapPanY;
  cvs.style.cursor='grabbing';
}
function onMapPointerMove(e){
  if(!isDraggingMap)return;
  var ddx=e.clientX-dragStartClientX,ddy=e.clientY-dragStartClientY;
  if(Math.abs(ddx)>3||Math.abs(ddy)>3)dragMoved=true;
  mapPanX=dragStartPanX+ddx;mapPanY=dragStartPanY+ddy;
  clampMapPan();
}
function onMapPointerUp(){
  if(!isDraggingMap)return;
  isDraggingMap=false;
  if(cvs)cvs.style.cursor='';
}

// ── CLICK ─────────────────────────────────────────────────────────────────────
function handleClick(e){
  if(!cvs)return;
  if(dragMoved){dragMoved=false;return;} // a drag just ended — don't also (de)select a tower
  var rect=cvs.getBoundingClientRect();
  var mx=(e.clientX-rect.left)*(W/rect.width),my=(e.clientY-rect.top)*(H/rect.height);
  for(var bi=0;bi<BTNS.length;bi++){
    var btn=BTNS[bi];
    if(mx>=btn.x&&mx<=btn.x+btn.w&&my>=btn.y&&my<=btn.y+btn.h){
      if(btn.action==='close_panel'){selectedId=null;panelStates.spec='open';return;}
      if(btn.action==='mini_spec'){panelStates.spec='mini';return;}
      if(btn.action==='open_spec'){panelStates.spec='open';return;}
      if(btn.action==='close_metrics'){panelStates.metrics='closed';return;}
      if(btn.action==='mini_metrics'){panelStates.metrics='mini';return;}
      if(btn.action==='open_metrics'){panelStates.metrics='open';return;}
      if(btn.action==='dismiss_decision'){if(btn.d){btn.d.resolved=true;btn.d.resolvedAt=Date.now();}return;}
      if(btn.action==='new_task'){showMissionInput();return;}
      if(btn.action==='demo'){if(demoRunning)stopDemo();else startDemo();return;}
      if(btn.action==='approve'){if(btn.d){btn.d.resolved=true;btn.d.resolvedAt=Date.now();var ag2=AGENTS.find(function(a){return a.id===btn.d.agentId;});if(ag2)spawnSpark(ag2);}return;}
      if(btn.action==='reject'){if(btn.d){btn.d.resolved=true;btn.d.resolvedAt=Date.now();}return;}
    }
  }
  for(var ai=0;ai<AGENTS.length;ai++){
    var ag3=AGENTS[ai];var pos=agentPos[ag3.id]||{x:ag3.hx,y:ag3.hy};var p=iso(pos.x,pos.y);
    var dxx=mx-p.x,dyy=my-(p.y+TH);
    if(dxx*dxx+dyy*dyy<(TW*1.4)*(TW*1.4)){selectedId=(selectedId===ag3.id)?null:ag3.id;return;}
  }
  selectedId=null;
}

// ── ACTIVATE ──────────────────────────────────────────────────────────────────
function activate(){
  cvs=document.getElementById('iso-cvs');if(!cvs)return;
  if(!cvs._isoReady){
    ctx2=cvs.getContext('2d');cvs._isoReady=true;
    new ResizeObserver(resize).observe(cvs.parentElement);
    cvs.addEventListener('click',handleClick);
    cvs.addEventListener('pointerdown',onMapPointerDown);
    document.addEventListener('pointermove',onMapPointerMove);
    document.addEventListener('pointerup',onMapPointerUp);
  }
  resize();initWander();
  if(!running){running=true;requestAnimationFrame(frame);}
  // Live task/run animation is driven by the shared SSE dispatcher (initLiveEvents
  // → onTaskChanged/refreshNodes); this poll only seeds nodeData once and acts as
  // a slow 60s resilience fallback for the left-panel metrics (which SSE events
  // don't carry) in case the EventSource drops silently between run events.
  poll();clearInterval(cvs._pollInt);cvs._pollInt=setInterval(poll,60000);
  bootstrapCanvas(); // real task history → animate it; empty → play demo
}

setTimeout(activate,400);
})();
