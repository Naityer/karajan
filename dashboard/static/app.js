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
const CRITERIA = [
  "ambiguity",
  "context_required",
  "reasoning_depth",
  "autonomy_required",
  "operational_risk",
  "validation_difficulty",
];
const DIAGRAM_BASE_WIDTH = 1500;
const DIAGRAM_BASE_HEIGHT = 1050;
const DIAGRAM_PAD_X = 520;
const DIAGRAM_PAD_Y = 300;

const state = {
  config: null,
  catalog: [],
  providers: [],
  skills: [],
  tasks: [],
  selected: null,
  parentProvider: "",
  entities: [],
  modelDrawerOpen: true,
  drawerWidth: 320,
  resizingDrawer: false,
  diagramZoom: 1,
  panningDiagram: false,
  diagramCentered: false,
  openSkillPanels: new Set(),
  monitorTab: "agents",
  selectedNodeId: "",
  lastObservability: null,
  monitorSideOpen: true,
  monitorSideWidth: 380,
  resizingMonitorSide: false,
  monitorBlockOrder: ["summary", "health", "flow"],
  lastMetrics: null,
  humanSideOpen: true,
  humanSideWidth: 430,
  resizingHumanSide: false,
  configTab: "params",
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
const SUPPORT_ROLES = ["guardian", "validator", "memory", "monitor"];
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
let activeModelDrag = null;
let activeEntityMove = null;
let activeDiagramPan = null;
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
  if ($("#view-decision").classList.contains("active")) requestAnimationFrame(drawWires);
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
  if (view === "human" || view === "monitor") refreshMonitor().catch((error) => toast(error.message));
}

function initAutoRefresh() {
  setInterval(() => {
    const view = state.activeView || "human";
    if (view === "human" || view === "monitor") refreshMonitor().catch(() => {});
    if (view === "agents") refreshProvidersAndAgents().catch(() => {});
  }, AUTO_REFRESH_INTERVAL_MS);
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
async function refreshMonitor() {
  if (!$("#monitorMainContent") && !$("#kpis")) return;
  const [metrics, tasks, observability, providers] = await Promise.all([api("/metrics"), api("/tasks"), api("/observability"), api("/providers")]);
  state.tasks = tasks;
  state.lastObservability = observability;
  state.lastMetrics = metrics;
  state.providers = providers;
  renderNotifications();
  renderAgentNotifications();
  if (!state.selectedNodeId && observability.nodes?.length) state.selectedNodeId = observability.nodes[0].id;
  if ($("#monitorMainContent")) {
    renderSummaryMetrics(metrics, tasks, observability);
    renderSystemHealth(observability.health);
    renderExecutionFlow(observability.execution_flow || []);
    renderProcessingNodeTabs(observability.nodes || []);
    renderNodeOverview(observability.nodes || []);
    renderMonitorGraphs(metrics, observability);
    renderHumanReviewQueue(tasks);
    renderHumanHome(metrics, tasks, observability);
    _renderAgentPanels(observability.nodes || [], observability.model_usage || [], observability.execution_flow || [], observability.audit_timeline || []);
    renderAuditTimeline(observability.audit_timeline || []);
    renderModelUsage(observability.model_usage || []);
    renderTaskRows(tasks);
    const selected = tasks.find((t) => t.task_id === state.selected) || tasks[0];
    if (selected) {
      state.selected = selected.task_id;
      await renderDetail(selected);
    }
    return;
  }
  renderKpis(metrics);
  renderCharts(metrics);
  renderObservability(observability);
  renderTaskRows(tasks);
  const selected = tasks.find((t) => t.task_id === state.selected) || tasks[0];
  if (selected) {
    state.selected = selected.task_id;
    await renderDetail(selected);
  }
}

function renderObservability(snapshot) {
  state.lastObservability = snapshot;
  if (!state.selectedNodeId && snapshot.nodes?.length) state.selectedNodeId = snapshot.nodes[0].id;
  renderSystemHealth(snapshot.health);
  renderNodeMetrics(snapshot.nodes || []);
  renderModelBubbles(snapshot.nodes || [], snapshot.model_usage || []);
  renderExecutionFlow(snapshot.execution_flow || []);
  renderAuditTimeline(snapshot.audit_timeline || []);
  renderModelUsage(snapshot.model_usage || []);
  renderNodeOverview(snapshot.nodes || []);
  _renderAgentPanels(snapshot.nodes || [], snapshot.model_usage || [], snapshot.execution_flow || [], snapshot.audit_timeline || []);
}

function _renderAgentPanels(nodes, usage, flow, audit) {
  const node = nodes.find((n) => n.id === state.selectedNodeId) || nodes[0];
  const usageByModel = new Map((usage || []).map((u) => [u.model, u]));
  renderAgentDetailPanel(node, usageByModel);
  renderMonitorSidePanel(node, flow, audit);
}

function renderSystemHealth(health) {
  if (!health) {
    $("#systemHealth").innerHTML = `<div class="chart-empty">sin datos</div>`;
    return;
  }
  const status = health.status === "healthy" ? "ok" : health.status === "error" ? "bad" : "warn";
  const healthPct = health.observed_nodes ? Math.round((health.healthy_nodes / health.observed_nodes) * 100) : 0;
  $("#systemHealth").innerHTML = `<div class="health-compact ${status}">
      <div>
        <span class="pill ${status}">${escapeHtml(health.status)}</span>
        <b>${healthPct}%</b>
        <small>salud operativa</small>
      </div>
      <div class="health-orbit" style="--pct:${healthPct}%"><span>${health.observed_nodes}</span><small>nodos</small></div>
    </div>
    <div class="health-strip">
      <span><b>${health.healthy_nodes}</b><small>healthy</small></span>
      <span><b>${health.warning_nodes}</b><small>warn</small></span>
      <span><b>${health.error_nodes}</b><small>err</small></span>
      <span><b>${health.active_tasks}</b><small>act.</small></span>
      <span><b>${health.blocked_tasks}</b><small>block</small></span>
      <span><b>${health.avg_latency_ms || 0}ms</b><small>lat.</small></span>
    </div>`;
}

function renderNodeMetrics(nodes) {
  $("#nodeMetrics").innerHTML = nodes.length
    ? nodes
        .map((node) => {
          const status = node.status === "completed" || node.status === "idle" ? "ok" : node.status === "error" ? "bad" : "warn";
          const selected = node.id === state.selectedNodeId ? "selected" : "";
          const levels = (node.levels || []).map((level) => LEVEL_FULL[level] || level).join(" · ") || "sin niveles";
          const caps = (node.active_capabilities || []).length
            ? `<div class="node-caps">${node.active_capabilities.map((cap) => `<span>${escapeHtml(cap)}</span>`).join("")}</div>`
            : "";
          const skills = (node.skills || []).slice(0, 4).join(" · ") || "sin skills";
          return `<button class="node-metric ${selected}" data-node="${escapeHtml(node.id)}">
              <div class="node-metric-head"><b>${escapeHtml(node.name)}</b><span class="pill ${status}">${escapeHtml(node.status)}</span></div>
              <div class="node-role">${escapeHtml(node.role)} · ${escapeHtml(node.provider)} · ${escapeHtml(node.active_model)}</div>
              ${caps}
              <div class="node-stats">
                <span><b>${node.task_count}</b><small>tasks</small></span>
                <span><b>${node.error_count}</b><small>errors</small></span>
                <span><b>${node.latency_ms || 0}ms</b><small>lat.</small></span>
                <span><b>$${Number(node.estimated_cost || 0).toFixed(4)}</b><small>coste</small></span>
              </div>
              <div class="node-role">${escapeHtml(levels)}</div>
              <div class="node-role">${escapeHtml(skills)}</div>
            </button>`;
        })
        .join("")
    : `<div class="chart-empty">sin nodos</div>`;
  $$("#nodeMetrics .node-metric").forEach((button) =>
    button.addEventListener("click", () => {
      state.selectedNodeId = button.dataset.node;
      setMonitorSide(true);
      renderNodeMetrics(state.lastObservability?.nodes || []);
      renderModelBubbles(state.lastObservability?.nodes || [], state.lastObservability?.model_usage || []);
      _renderAgentPanels(
        state.lastObservability?.nodes || [],
        state.lastObservability?.model_usage || [],
        state.lastObservability?.execution_flow || [],
        state.lastObservability?.audit_timeline || []
      );
    })
  );
}

function renderModelBubbles(nodes, usage) {
  const usageByModel = new Map((usage || []).map((item) => [item.model, item]));
  $("#modelBubbles").innerHTML = nodes.length
    ? nodes
        .map((node) => {
          const selected = node.id === state.selectedNodeId ? "selected" : "";
          const status = node.status === "error" ? "bad" : node.status === "completed" || node.status === "idle" ? "ok" : "warn";
          const label = node.active_model && node.active_model !== "auto / simulado" ? node.active_model : node.name;
          return `<button class="model-bubble ${selected} ${status}" data-node="${escapeHtml(node.id)}">
              <span class="bubble-dot"></span>
              <b>${escapeHtml(node.name)}</b>
              <small>${escapeHtml(node.role)} · ${escapeHtml(label)}</small>
            </button>`;
        })
        .join("")
    : `<div class="chart-empty">sin modelos implicados</div>`;
  $$("#modelBubbles .model-bubble").forEach((button) =>
    button.addEventListener("click", () => {
      state.selectedNodeId = button.dataset.node;
      setMonitorSide(true);
      renderNodeMetrics(nodes);
      renderModelBubbles(nodes, usage);
      _renderAgentPanels(nodes, usage, state.lastObservability?.execution_flow || [], state.lastObservability?.audit_timeline || []);
    })
  );
  renderBubbleMetricPanel(nodes.find((node) => node.id === state.selectedNodeId) || nodes[0], usageByModel);
}

function renderBubbleMetricPanel(node, usageByModel) {
  if (!node) {
    $("#modelBubblePanel").innerHTML = "";
    return;
  }
  const usage = usageByModel.get(node.active_model);
  const chips = [
    ["Rol", node.role],
    ["Modelo", node.active_model || "auto"],
    ["Provider", node.provider],
    ["Llamadas", usage?.calls ?? node.task_count],
    ["Coste", `$${Number(usage?.estimated_cost ?? node.estimated_cost ?? 0).toFixed(4)}`],
    ["Latencia", `${usage?.latency_ms ?? node.latency_ms ?? 0}ms`],
  ];
  $("#modelBubblePanel").innerHTML = `<div class="bubble-window">
      <header><b>${escapeHtml(node.name)}</b><span>${escapeHtml(node.status)}</span></header>
      <div class="bubble-window-grid">
        ${chips.map(([label, value]) => `<span><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b></span>`).join("")}
      </div>
      <div class="node-caps">${(node.active_capabilities || []).map((cap) => `<span>${escapeHtml(cap)}</span>`).join("") || "<span>sin capacidades</span>"}</div>
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

function setMonitorTab(tab) {
  state.monitorTab = tab;
  $$("#monitorTabs button").forEach((button) => button.classList.toggle("active", button.dataset.monitorTab === tab));
  $$(".monitor-tab").forEach((panel) => panel.classList.toggle("active", panel.id === `monitor-tab-${tab}`));
}

function renderExecutionFlow(events) {
  $("#executionFlow").innerHTML = eventList(events.slice(0, 4), "Sin flujo de ejecución.");
}

const _NODE_CHIP_ICON = {
  agent:     `<svg width="13" height="13" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M7 1a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm-5 11c0-2.2 2.24-4 5-4s5 1.8 5 4H2z"/></svg>`,
  worker:    `<svg width="13" height="13" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M7 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM12.4 6h-1A4.5 4.5 0 0 0 8 3.7V2.6a1 1 0 0 0-2 0v1.1A4.5 4.5 0 0 0 2.6 6h-1a1 1 0 0 0 0 2h1A4.5 4.5 0 0 0 6 10.3v1.1a1 1 0 0 0 2 0v-1.1A4.5 4.5 0 0 0 11.4 8h1a1 1 0 0 0 0-2z"/></svg>`,
  backup:    `<svg width="13" height="13" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M7 1 2 3v4c0 3 2.2 5.5 5 6 2.8-.5 5-3 5-6V3L7 1z"/></svg>`,
  validator: `<svg width="13" height="13" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M7 1 2 3v4c0 3 2.2 5.5 5 6 2.8-.5 5-3 5-6V3L7 1zm3.5 4-4 4-2-2-.7.7L6.5 10.2l4.7-4.7-.7-.7z"/></svg>`,
  memory:    `<svg width="13" height="13" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="2" y="3" width="10" height="8" rx="1.5"/><path d="M5 3V1.5M9 3V1.5M5 11v1.5M9 11v1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,
  monitor:   `<svg width="13" height="13" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M7 3C4 3 1.5 6 1.5 7s2.5 4 5.5 4 5.5-3 5.5-4-2.5-4-5.5-4zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>`,
};
const _LEVEL_SHORT = { level_1_simple:"N1", level_2_moderate:"N2", level_3_intermediate:"N3", level_4_complex:"N4", level_5_critical:"N5" };

function renderProcessingNodeTabs(nodes) {
  const target = $("#processingNodeTabs");
  if (!target) return;
  const fallback = [
    { id: "fallback-agent", name: "Claude", role: "Agent", status: "idle", active_model: "auto / simulado", provider: "simulated", levels: [], skills: [], active_capabilities: [], task_count: 0, error_count: 0, latency_ms: 0, estimated_cost: 0, confidence: null, extra: {} },
    { id: "fallback-worker-1", name: "Gemini", role: "Worker", status: "idle", active_model: "auto / simulado", provider: "simulated", levels: [], skills: [], active_capabilities: [], task_count: 0, error_count: 0, latency_ms: 0, estimated_cost: 0, confidence: null, extra: {} },
    { id: "fallback-worker-2", name: "Groq", role: "Worker", status: "idle", active_model: "auto / simulado", provider: "simulated", levels: [], skills: [], active_capabilities: [], task_count: 0, error_count: 0, latency_ms: 0, estimated_cost: 0, confidence: null, extra: {} },
  ];
  const visibleNodes = nodes.length ? nodes : fallback;
  if (!state.selectedNodeId && visibleNodes.length) state.selectedNodeId = visibleNodes[0].id;

  const allActive = !state.selectedNodeId || state.selectedNodeId === "__all__";
  target.innerHTML = [
    `<button class="node-chip${allActive ? " active" : ""}" type="button" data-tab-node="__all__" title="Ver todos los nodos">
      <span class="node-chip-all-icon"><svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1.5"/><circle cx="9" cy="3" r="1.5"/><circle cx="3" cy="9" r="1.5"/><circle cx="9" cy="9" r="1.5"/></svg></span>
      <span class="node-chip-name">Todos</span>
      <span class="node-chip-count">${visibleNodes.length}</span>
    </button>`,
    ...visibleNodes.map((node) => {
      const role = (node.role || "worker").toLowerCase();
      const icon = _NODE_CHIP_ICON[role] || _NODE_CHIP_ICON.worker;
      const selected = node.id === state.selectedNodeId ? " active" : "";
      const status = node.status === "error" ? "bad" : (node.status === "idle" || node.status === "completed") ? "ok" : "warn";
      const shortName = (node.name || "Nodo").split("(")[0].trim().split(",")[0].trim();
      const lvl = (node.levels || []).map(l => _LEVEL_SHORT[l]).filter(Boolean);
      const lvlBadge = lvl.length ? `<span class="node-chip-lvl">${lvl.join(" ")}</span>` : "";
      return `<button type="button" class="node-chip role-${role}${selected}" data-tab-node="${escapeHtml(node.id)}" title="${escapeHtml(node.name)}">
        <span class="node-chip-icon">${icon}</span>
        <span class="node-chip-name">${escapeHtml(shortName)}</span>
        ${lvlBadge}
        <span class="node-chip-dot ${status}"></span>
      </button>`;
    }),
  ].join("");

  target.querySelectorAll("button[data-tab-node]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nodeId = btn.dataset.tabNode;
      state.selectedNodeId = nodeId === "__all__" ? (visibleNodes[0]?.id || "") : nodeId;
      target.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn || (nodeId === "__all__" && b.dataset.tabNode === "__all__")));
      setMonitorSide(true);
      _renderAgentPanels(visibleNodes, state.lastObservability?.model_usage || [], state.lastObservability?.execution_flow || [], state.lastObservability?.audit_timeline || []);
    });
  });
}

const _NOC_ICON = {
  agent:     `<svg width="16" height="16" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M7 1a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm-5 11c0-2.2 2.24-4 5-4s5 1.8 5 4H2z"/></svg>`,
  worker:    `<svg width="16" height="16" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M7 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM12.4 6h-1A4.5 4.5 0 0 0 8 3.7V2.6a1 1 0 0 0-2 0v1.1A4.5 4.5 0 0 0 2.6 6h-1a1 1 0 0 0 0 2h1A4.5 4.5 0 0 0 6 10.3v1.1a1 1 0 0 0 2 0v-1.1A4.5 4.5 0 0 0 11.4 8h1a1 1 0 0 0 0-2z"/></svg>`,
  backup:    `<svg width="16" height="16" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M7 1 2 3v4c0 3 2.2 5.5 5 6 2.8-.5 5-3 5-6V3L7 1z"/></svg>`,
  validator: `<svg width="16" height="16" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M7 1 2 3v4c0 3 2.2 5.5 5 6 2.8-.5 5-3 5-6V3L7 1zm3.5 4-4 4-2-2-.7.7L6.5 10.2l4.7-4.7-.7-.7z"/></svg>`,
  memory:    `<svg width="16" height="16" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="2" y="3" width="10" height="8" rx="1.5"/><path d="M5 3V1.5M9 3V1.5M5 11v1.5M9 11v1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,
};
const _LEVEL_COLOR = { level_1_simple:"lvl-1", level_2_moderate:"lvl-2", level_3_intermediate:"lvl-3", level_4_complex:"lvl-4", level_5_critical:"lvl-5" };

function renderNodeOverview(nodes) {
  const target = $("#nodeOverview");
  if (!target) return;
  if (!nodes.length) {
    target.innerHTML = `<div class="chart-empty">Sin nodos observados todavía.</div>`;
    return;
  }
  const maxTasks = Math.max(...nodes.map((n) => n.task_count || 0), 1);

  target.innerHTML = `<div class="node-overview-grid">
    ${nodes.map((node) => {
      const selected = node.id === state.selectedNodeId ? "selected" : "";
      const status = node.status === "error" ? "bad" : (node.status === "completed" || node.status === "idle") ? "ok" : "warn";
      const role = (node.role || "worker").toLowerCase();
      const icon = _NOC_ICON[role] || _NOC_ICON.worker;
      const taskPct = Math.round((node.task_count || 0) / maxTasks * 100);
      const modelLabel = (node.active_model || node.provider || "—").replace("auto / simulado", "simulado");
      const levelBadges = (node.levels || [])
        .map((l) => `<span class="noc-lvl-badge ${_LEVEL_COLOR[l] || ""}">${_LEVEL_SHORT[l] || l}</span>`)
        .join("") || `<span class="noc-lvl-badge muted">—</span>`;
      const shortName = (node.name || "Nodo").split("(")[0].trim().split(",")[0].trim();
      return `<button type="button" class="node-overview-card ${selected}" data-node="${escapeHtml(node.id)}">
        <div class="noc-header">
          <span class="noc-icon role-${role}">${icon}</span>
          <div class="noc-identity">
            <b class="noc-name">${escapeHtml(shortName)}</b>
            <span class="noc-model">${escapeHtml(modelLabel)}</span>
          </div>
          <span class="noc-status-dot ${status}"></span>
        </div>
        <div class="noc-levels">${levelBadges}</div>
        <div class="noc-bar-wrap">
          <div class="noc-bar"><div class="noc-bar-fill ${status}" style="width:${taskPct}%"></div></div>
          <span class="noc-bar-label">${node.task_count || 0} tareas</span>
        </div>
        <div class="noc-footer">
          <span class="noc-stat"><small>lat.</small><b>${node.latency_ms || 0}ms</b></span>
          <span class="noc-stat"><small>coste</small><b>$${Number(node.estimated_cost || 0).toFixed(4)}</b></span>
          <span class="noc-stat"><small>err</small><b>${node.error_count || 0}</b></span>
        </div>
      </button>`;
    }).join("")}
  </div>`;

  $$("#nodeOverview .node-overview-card").forEach((button) =>
    button.addEventListener("click", () => {
      state.selectedNodeId = button.dataset.node;
      setMonitorSide(true);
      renderProcessingNodeTabs(nodes);
      renderNodeOverview(nodes);
      _renderAgentPanels(nodes, state.lastObservability?.model_usage || [], state.lastObservability?.execution_flow || [], state.lastObservability?.audit_timeline || []);
    })
  );
}

function renderMonitorGraphs(metrics, observability) {
  const target = $("#monitorGraphs");
  if (!target) return;
  const nodes = observability?.nodes || [];

  const tasksByNode = nodes.map((n) => [n.name.split("(")[0].trim().split(",")[0].trim(), n.task_count || 0]);
  const latByNode   = nodes.map((n) => [n.name.split("(")[0].trim().split(",")[0].trim(), n.latency_ms || 0]);
  const modelEntries = Object.entries(metrics.by_model || {}).slice(0, 6);
  const statusEntries = Object.entries(metrics.by_status || {});

  target.innerHTML = `<div class="monitor-graph-grid">
    ${miniBarPanel("Tareas por nodo", tasksByNode)}
    ${miniBarPanel("Latencia por nodo (ms)", latByNode)}
    ${miniBarPanel("Tier de modelo", modelEntries, TIER_LABEL)}
    ${miniBarPanel("Estado de tareas", statusEntries)}
  </div>`;
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

function renderHumanReviewQueue(tasks) {
  const target = $("#humanReviewQueue");
  if (!target) return;
  const queue = tasks.filter((task) => task.classification?.requires_human_review || task.status === "delegated");
  if (!queue.length) {
    target.innerHTML = `<div class="human-empty">
      <b>Sin aprobaciones pendientes</b>
      <span>Las tareas actuales no requieren credenciales, login, API externa ni firma humana.</span>
    </div>`;
    return;
  }
  target.innerHTML = `<div class="human-queue">
    ${queue
      .map((task) => {
        const c = task.classification;
        const why = c.requires_human_review
          ? "Requiere confirmación antes de ejecutar o delegar."
          : "Delegada: pendiente de seguimiento operativo.";
        const approvals = [
          c.requires_human_review ? "aprobación humana" : "",
          c.recommended_strategy?.includes("human") ? "estrategia con control" : "",
          c.reason || "",
        ].filter(Boolean);
        return `<article class="human-card">
          <header><b>${escapeHtml(c.intent || "Tarea")}</b>${statusPill(task.status)}</header>
          <p>${escapeHtml(why)}</p>
          <div class="human-meta">
            <span><small>Riesgo</small><b>${escapeHtml(c.complexity_level.replace("level_", "N").replace(/_.*/, ""))} · ${Number(c.complexity_score).toFixed(2)}</b></span>
            <span><small>Modelo</small><b>${escapeHtml(TIER_LABEL[c.recommended_model] || c.recommended_model)}</b></span>
            <span><small>Dominio</small><b>${escapeHtml((c.domain || []).slice(0, 2).join(", "))}</b></span>
          </div>
          <ul>${approvals.slice(0, 3).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
          ${task.status === "delegated" && c.requires_human_review ? `<button class="approve-review" data-approve="${task.task_id}">Aprobar y liberar ejecución</button>` : ""}
        </article>`;
      })
      .join("")}
  </div>`;
}

function renderHumanHome(metrics = state.lastMetrics, tasks = state.tasks, observability = state.lastObservability) {
  if (!$("#view-human")) return;
  metrics ||= {};
  tasks ||= [];
  observability ||= {};
  const providers = state.catalog || [];
  const statusByProvider = new Map((state.providers || []).map((item) => [item.provider, item]));
  const pending = tasks.filter((task) => task.classification?.requires_human_review || task.status === "delegated");
  const paid = providers.filter((item) => !item.is_free);
  const ready = providers.filter((item) => statusByProvider.get(item.name)?.ready);
  const needsSetup = providers.filter((item) => !statusByProvider.get(item.name)?.ready);
  const totalCost = Number(metrics.total_estimated_cost_usd || observability.health?.total_cost || 0);

  $("#humanHomeStatus").innerHTML = `
    <span class="${pending.length ? "tone-warn" : "tone-ok"}"><b>${pending.length}</b><small>decisiones</small></span>
    <span><b>${ready.length}/${providers.length}</b><small>agentes listos</small></span>
    <span><b>$${totalCost.toFixed(4)}</b><small>coste estimado</small></span>
  `;

  $("#humanDecisionCount").textContent = pending.length;
  const providerCount = $("#humanProviderCount");
  if (providerCount) providerCount.textContent = providers.length;
  renderHumanDecisionQueue(pending);
  renderHumanProviderGrid(providers, statusByProvider);
  renderHumanCostPanel({ providers, paid, ready, needsSetup, metrics, totalCost });
  renderHumanActionPanel({ pending, needsSetup, paid, observability });
  requestAnimationFrame(syncHumanSideOffset);
}

function renderHumanDecisionQueue(tasks) {
  const target = $("#humanDecisionQueue");
  if (!target) return;
  if (!tasks.length) {
    target.innerHTML = `<div class="human-home-empty">
      <b>Sin bloqueos humanos</b>
      <span>No hay tareas esperando aprobación, login, API key o confirmación de coste.</span>
    </div>`;
    return;
  }
  target.innerHTML = tasks
    .map((task) => {
      const c = task.classification;
      const level = c.complexity_level.replace("level_", "N").replace(/_.*/, "");
      const blockers = [
        c.requires_human_review ? "Aprobación humana" : "",
        c.recommended_strategy?.includes("human") ? "Estrategia con puerta humana" : "",
        c.recommended_model?.includes("human") ? "Modelo crítico" : "",
      ].filter(Boolean);
      return `<article class="human-decision-item">
        <div class="human-decision-title">
          <span class="status-dot ${task.status === "completed" ? "ok" : "warn"}"></span>
          <div><b>${escapeHtml(c.intent || "Decisión pendiente")}</b><small>${escapeHtml((c.domain || []).join(", ") || "sin dominio")}</small></div>
          ${statusPill(task.status)}
        </div>
        ${decisionRoadmap(task)}
        <p>${escapeHtml(c.reason || "Requiere revisión antes de continuar.")}</p>
        <div class="human-decision-meta">
          <span><small>Nivel</small><b>${escapeHtml(level)} · ${Number(c.complexity_score || 0).toFixed(2)}</b></span>
          <span><small>Ruta</small><b>${escapeHtml(TIER_LABEL[c.recommended_model] || c.recommended_model)}</b></span>
          <span><small>Bloqueo</small><b>${escapeHtml(blockers.join(" · ") || "seguimiento")}</b></span>
        </div>
        <div class="human-decision-actions">
          ${task.status === "delegated" && c.requires_human_review ? `<button class="primary approve-review" data-approve="${task.task_id}">Aprobar ejecución</button>` : ""}
          <button type="button" data-select-task="${escapeHtml(task.task_id)}">Ver en Monitor</button>
        </div>
      </article>`;
    })
    .join("");
}

function decisionRoadmap(task) {
  const c = task.classification || {};
  const blocked = Boolean(c.requires_human_review || task.status === "delegated");
  const delegatedTo = (task.executions || []).map((execution) => execution.model || execution.provider).filter(Boolean)[0];
  const stages = [
    ["Entrada", "Prompt recibido", "request"],
    ["Router", "clasifica riesgo", "agent"],
    ["Delegación", delegatedTo || TIER_LABEL[c.recommended_model] || "modelo recomendado", "worker"],
    ["Control", blocked ? "aprobación humana" : "sin bloqueo", blocked ? "blocker" : "check"],
    ["Meta", blocked ? "pendiente" : "listo", "goal"],
  ];
  return `<div class="decision-roadmap ${blocked ? "blocked" : "clear"}">
    <div class="roadmap-track">
      ${stages
        .map(([label, detail, kind], index) => `<div class="roadmap-step ${kind} ${blocked && kind === "blocker" ? "locked" : ""}">
          <span class="roadmap-avatar">${roadmapIcon(kind)}</span>
          <b>${escapeHtml(label)}</b>
          <small>${escapeHtml(detail)}</small>
          ${index < stages.length - 1 ? `<i></i>` : ""}
        </div>`)
        .join("")}
      <span class="roadmap-courier" aria-hidden="true"></span>
    </div>
    ${blocked ? `<div class="roadmap-obstacle"><b>Bloqueo activo</b><span>Desbloquea la ejecución con aprobación humana.</span></div>` : ""}
  </div>`;
}

function roadmapIcon(kind) {
  return {
    request: "◆",
    agent: "A",
    worker: "W",
    blocker: "!",
    check: "✓",
    goal: "◎",
  }[kind] || "•";
}

function renderHumanProviderGrid(providers, statusByProvider) {
  const target = $("#humanProviderGrid");
  if (!target) return;
  if (!providers.length) {
    target.innerHTML = `<div class="human-home-empty">Sin catálogo de proveedores.</div>`;
    return;
  }
  target.innerHTML = providers
    .map((provider) => {
      const status = statusByProvider.get(provider.name) || {};
      const cls = status.ready ? "ready" : status.available ? "available" : "missing";
      const auth = provider.auth_method === "api_key" ? provider.env_var || "API key" : provider.login_command || provider.auth_method;
      const tiers = Object.keys(provider.tiers || {}).length;
      return `<article class="human-provider-card ${cls}">
        <header>
          <span><i class="status-dot ${status.ready ? "ok" : status.available ? "warn" : "bad"}"></i><b>${escapeHtml(provider.label)}</b></span>
          <em class="cost-tag ${provider.is_free ? "free" : "paid"}">${provider.is_free ? "Gratis" : "Pago"}</em>
        </header>
        <p>${escapeHtml(status.detail || "sin estado detectado")}</p>
        <div class="human-provider-meta">
          <span><small>Tipo</small><b>${escapeHtml(provider.backend)}</b></span>
          <span><small>Auth</small><b>${escapeHtml(auth)}</b></span>
          <span><small>Tiers</small><b>${tiers}</b></span>
        </div>
        <div class="human-provider-actions">
          <button type="button" data-refresh-providers>Comprobar</button>
          <button type="button" data-provider-setup="${escapeHtml(provider.name)}">Configurar</button>
          ${provider.signup_url ? `<a href="${escapeHtml(provider.signup_url)}" target="_blank" rel="noreferrer">Abrir consola</a>` : ""}
          ${provider.login_command ? `<code>${escapeHtml(provider.login_command)}</code>` : provider.env_var ? `<code>${escapeHtml(provider.env_var)}</code>` : ""}
        </div>
        <div class="provider-setup" data-provider-setup-target="${escapeHtml(provider.name)}" hidden></div>
      </article>`;
    })
    .join("");
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

function renderHumanCostPanel({ providers, paid, ready, needsSetup, metrics, totalCost }) {
  const target = $("#humanCostPanel");
  if (!target) return;
  const paidReady = paid.filter((item) => ready.some((readyItem) => readyItem.name === item.name)).length;
  const freeProviders = providers.length - paid.length;
  const paidPct = providers.length ? Math.round((paid.length / providers.length) * 100) : 0;
  const reviewCount = metrics.human_review_required || 0;
  target.innerHTML = `<div class="cost-home-hero">
      <span>Gasto estimado</span>
      <b>$${totalCost.toFixed(4)}</b>
      <small>${paidReady} proveedores de pago listos · ${freeProviders} gratis disponibles</small>
    </div>
    <div class="cost-meter"><i style="width:${paidPct}%"></i></div>
    <div class="human-side-grid">
      <span><b>${paid.length}</b><small>Pago</small></span>
      <span class="tone-ok"><b>${freeProviders}</b><small>Gratis</small></span>
      <span class="${reviewCount ? "tone-warn" : "tone-ok"}"><b>${reviewCount}</b><small>Revisión</small></span>
      <span class="${needsSetup.length ? "tone-bad" : "tone-ok"}"><b>${needsSetup.length}</b><small>Por conectar</small></span>
    </div>`;
}

function renderHumanActionPanel({ pending, needsSetup, paid, observability }) {
  const target = $("#humanActionPanel");
  if (!target) return;
  const actions = [
    pending.length ? [`${pending.length} aprobaciones pendientes`, "Revisa intención, coste y riesgo antes de liberar ejecución."] : null,
    needsSetup.length ? [`${needsSetup.length} proveedores por conectar`, "Configura API key, login CLI o servicio local antes de delegar tareas reales."] : null,
    paid.length ? [`${paid.length} proveedores de pago`, "Mantén el uso bajo control antes de activar modelos fuertes o revisión humana."] : null,
    observability?.health?.blocked_tasks ? [`${observability.health.blocked_tasks} tareas bloqueadas`, "Puede requerir firma, credenciales o intervención manual."] : null,
  ].filter(Boolean);
  target.innerHTML = actions.length
    ? `<div class="human-action-list">${actions.map(([title, body]) => `<div><b>${escapeHtml(title)}</b><span>${escapeHtml(body)}</span></div>`).join("")}</div>`
    : `<div class="human-home-empty"><b>Todo despejado</b><span>No hay acciones humanas obligatorias ahora mismo.</span></div>`;
}

function renderSummaryMetrics(metrics, tasks, observability) {
  const nodes = observability.nodes || [];
  const usage = observability.model_usage || [];
  const totalCalls = usage.reduce((acc, item) => acc + Number(item.calls || 0), 0);
  const avgLatency = observability.health?.avg_latency_ms || 0;
  const blocked = observability.health?.blocked_tasks || 0;
  const completed = metrics.by_status?.completed || 0;
  const delegated = metrics.by_status?.delegated || metrics.delegated_tasks || 0;
  const items = [
    ["Nodos", nodes.length || observability.health?.observed_nodes || 0],
    ["Llamadas", totalCalls],
    ["Completadas", completed],
    ["Delegadas", delegated],
    ["Latencia media", `${avgLatency}ms`],
    ["Coste total", `$${Number(metrics.total_estimated_cost_usd || 0).toFixed(4)}`],
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
    task_delegated: "Delegación",
    validation: "Validación",
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

function persistEntityState() {
  localStorage.setItem("karajan-decision-entities", JSON.stringify(state.entities));
  clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(saveRoutingLayout, 500);
}

async function loadRoutingLayout() {
  try {
    const layout = await api("/routing-layout");
    if (layout.entities?.length) {
      state.entities = layout.entities;
      state.diagramZoom = layout.zoom || state.diagramZoom;
      state.drawerWidth = layout.drawer_width || state.drawerWidth;
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
        zoom: state.diagramZoom,
        drawer_width: state.drawerWidth,
      }),
    });
  } catch {
    // Keep UI edits responsive even if the backend is temporarily unavailable.
  }
}

function normalizeEntityPositions() {
  const usedLevels = new Set();
  state.entities.forEach((entity, index) => {
    entity.x = Number.isFinite(Number(entity.x)) ? Number(entity.x) : 24 + index * 344;
    entity.y = Number.isFinite(Number(entity.y)) ? Number(entity.y) : 36;
    entity.levels ||= [];
    entity.skills ||= [];
    entity.capabilities ||= [];
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
      if (usedLevels.has(level)) return false;
      usedLevels.add(level);
      return true;
    });
  });
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
  ensureEntities();
  $("#diagramNodes").innerHTML = state.entities.map(entityCard).join("");

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
  $$("#diagramNodes .entity-parent-link").forEach((sel) =>
    sel.addEventListener("change", (event) => {
      const entity = findEntity(event.target.dataset.entity);
      if (!entity) return;
      entity.parentId = event.target.value;
      renderDiagram();
      scheduleRoutingSave("Conexión actualizada. Guardando…");
    })
  );
  $$("#diagramNodes .level-chip").forEach((btn) =>
    btn.addEventListener("click", () => {
      const entity = findEntity(btn.dataset.entity);
      if (!entity || btn.disabled) return;
      entity.levels ||= [];
      if (entity.levels.includes(btn.dataset.level)) {
        entity.levels = entity.levels.filter((item) => item !== btn.dataset.level);
      } else {
        entity.levels.push(btn.dataset.level);
      }
      renderDiagram();
      scheduleRoutingSave("Niveles actualizados. Guardando…");
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

  requestAnimationFrame(drawWires);
}

function entityCard(entity) {
  if (entity.role === "skill" || entity.role === "worker") entity.role = "child";
  if (entity.role === "agent") entity.role = "parent";
  entity.role_tags = normalizeRoleTags(entity);
  const role = roleDef(entity.role);
  const roleLabel = roleLabels(entity).join(" · ");
  const remove = entity.id !== "entity-parent" ? `<button class="node-x" data-remove="${entity.id}" title="Quitar entidad">✕</button>` : "";
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
  const connection =
    canConnectToAgent(entity.role)
      ? `<label>Conexión padre
          <select class="entity-parent-link" data-entity="${entity.id}">
            <option value="">Sin conexión</option>${parentOptions}
          </select>
        </label>`
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
      <div class="entity-controls">
        ${roleTagPicker(entity)}
        ${connection}
        ${levelControls}
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

function syncAgentCapabilities(entity) {
  const known = new Set(AGENT_CAPABILITY_DEFS.map(([name]) => name));
  if (!isAgentRole(entity.role)) {
    entity.capabilities = [];
    return [];
  }
  const selected = new Set((entity.capabilities || []).filter((name) => known.has(name)));
  AGENT_INTERNAL_CAPABILITIES.forEach((name) => selected.add(name));
  entity.capabilities = [...selected];
  return entity.capabilities;
}

function toggleAgentCapability(entity, capability) {
  if (!isAgentRole(entity.role)) return;
  if (AGENT_INTERNAL_CAPABILITIES.includes(capability)) return;
  const known = new Set(AGENT_CAPABILITY_DEFS.map(([name]) => name));
  if (!known.has(capability)) return;
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
    ...tags.map((role) => `<span class="role-chip role-chip-${roleDef(role).restriction.toLowerCase()}">${escapeHtml(roleDef(role).label)}</span>`),
    ...capabilities.map((name) => `<span class="role-chip role-chip-cap">${escapeHtml(name)}</span>`),
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
  const isLocked = AGENT_INTERNAL_CAPABILITIES.includes(name);
  return `<button type="button" class="role-tag-option capability ${isSelected ? "selected" : ""} ${isLocked ? "locked" : ""}" data-entity="${entity.id}" data-capability="${escapeHtml(name)}" title="${escapeHtml(description)}">
      <span class="role-option-check">${isSelected ? "✓" : ""}</span>
      <span><b>${escapeHtml(name)}</b><small>${escapeHtml(group)}${isLocked ? " · base" : ""}</small></span>
    </button>`;
}

function roleTagOption(entity, value, def, selected) {
  const isSelected = selected.has(value);
  const isPrimary = PRIMARY_ROLES.includes(value);
  const otherPrimary = isPrimary && [...selected].some((role) => PRIMARY_ROLES.includes(role) && role !== value);
  const note = isPrimary ? "primario" : def.restriction === "R2" ? "auxiliar" : "estado";
  return `<button type="button" class="role-tag-option ${isSelected ? "selected" : ""} ${otherPrimary ? "will-replace" : ""}" data-entity="${entity.id}" data-role="${value}">
      <span class="role-option-check">${isSelected ? "✓" : ""}</span>
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

function levelOwner(level) {
  return state.entities.find((item) => canOwnLevels(item.role) && item.levels?.includes(level));
}

function levelChip(entity, level, short) {
  const owner = levelOwner(level);
  const selected = entity.levels?.includes(level);
  const occupied = !!owner && owner.id !== entity.id;
  const ownerAccent = owner ? entityAccent(owner) : entityAccent(entity);
  const ownerName = owner ? owner.name || modelTitle(owner.provider) || "otra entidad" : "";
  return `<button class="level-chip ${selected ? "on" : ""} ${occupied ? "occupied" : ""}" style="--level-accent:${ownerAccent.color}; --level-ink:${ownerAccent.ink}" ${occupied ? "disabled" : ""} data-entity="${entity.id}" data-level="${level}" title="${occupied ? `Asignado a ${ownerName}` : LEVEL_FULL[level]}">
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
    x: Math.max(0, position?.x ?? 360 + nextIndex * 28),
    y: Math.max(0, position?.y ?? 48 + nextIndex * 28),
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
    x: Math.max(0, (clientX - rect.left + diagram.scrollLeft) / state.diagramZoom - DIAGRAM_PAD_X - 120),
    y: Math.max(0, (clientY - rect.top + diagram.scrollTop) / state.diagramZoom - DIAGRAM_PAD_Y - 30),
  };
}

function scaled(value) {
  return Math.round(Math.max(0, Number(value) || 0) * state.diagramZoom);
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
  if (!state.diagramCentered && $("#view-decision").classList.contains("active")) {
    diagram.scrollLeft = Math.max(0, screenX(0) - Math.round(diagram.clientWidth * 0.18));
    diagram.scrollTop = Math.max(0, screenY(0) - Math.round(diagram.clientHeight * 0.18));
    state.diagramCentered = true;
  }
  requestAnimationFrame(drawWires);
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
  svg.innerHTML = $$("#diagramNodes .node.entity.child")
    .filter((node) => node.dataset.entity && findEntity(node.dataset.entity)?.parentId)
    .map((node) => {
      const route = connectionRoute(parent, node);
      setNodePort(parent, route.from);
      setNodePort(node, route.to);
      return `<path d="${wirePath(route.start, route.end, route.from, route.to)}" fill="none" stroke="${accent}" stroke-width="1.5" opacity="${opacity}"/>`;
    })
    .join("");
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
      document.addEventListener("pointermove", onEntityMove);
      document.addEventListener("pointerup", stopEntityMove, { once: true });
    });
  });
}

function onEntityMove(event) {
  if (!activeEntityMove) return;
  const entity = findEntity(activeEntityMove.id);
  if (!entity) return;
  entity.x = Math.max(0, activeEntityMove.originX + (event.clientX - activeEntityMove.startX) / state.diagramZoom);
  entity.y = Math.max(0, activeEntityMove.originY + (event.clientY - activeEntityMove.startY) / state.diagramZoom);
  activeEntityMove.node.style.left = `${screenX(entity.x)}px`;
  activeEntityMove.node.style.top = `${screenY(entity.y)}px`;
  requestAnimationFrame(drawWires);
}

function stopEntityMove() {
  if (activeEntityMove) activeEntityMove.node.classList.remove("moving");
  activeEntityMove = null;
  document.body.classList.remove("moving-node");
  document.removeEventListener("pointermove", onEntityMove);
  persistEntityState();
  scheduleRoutingSave("Posición actualizada. Guardando…");
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
      requestAnimationFrame(drawWires);
    },
    { passive: false }
  );
}

function onDiagramPan(event) {
  if (!activeDiagramPan) return;
  const diagram = $("#diagram");
  diagram.scrollLeft = activeDiagramPan.scrollLeft - (event.clientX - activeDiagramPan.startX);
  diagram.scrollTop = activeDiagramPan.scrollTop - (event.clientY - activeDiagramPan.startY);
  requestAnimationFrame(drawWires);
}

function stopDiagramPan() {
  activeDiagramPan = null;
  state.panningDiagram = false;
  $("#diagram")?.classList.remove("panning");
  document.removeEventListener("pointermove", onDiagramPan);
}

function applyDrawerState() {
  document.documentElement.style.setProperty("--drawer-width", `${state.drawerWidth}px`);
  requestAnimationFrame(drawWires);
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
  requestAnimationFrame(drawWires);
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
async function renderModels() {
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
  const visibleCatalog = activeProviders.size ? catalog.filter((provider) => activeProviders.has(provider.name)) : catalog;

  const groups = {};
  visibleCatalog.forEach((p) => (groups[p.backend] || (groups[p.backend] = [])).push(p));
  const groupTitle = { cli: "Local / terminal", api: "Nube (API)", simulated: "Simulado" };

  $("#providerGroups").innerHTML = Object.entries(groups)
    .filter(([, list]) => list.length)
    .map(([backend, list]) => {
      const cards = list.map((p) => providerCard(p, status.get(p.name), advanced)).join("");
      return `<section class="provider-group"><h3>${groupTitle[backend] || backend}</h3>
        <div class="provider-cards">${cards}</div></section>`;
    })
    .join("");

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
  if ($("#view-decision").classList.contains("active")) renderDiagram();
}

function activeArchitectureProviderNames() {
  return new Set((state.entities || []).map((entity) => entity.provider).filter(Boolean));
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

function providerCard(provider, status, advanced) {
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
  return `<div class="pcard model-card ${advanced ? "adv" : ""}" draggable="true" data-name="${escapeHtml(provider.name)}">
      <div class="top">
        <span class="name"><span class="status-dot ${dot}"></span>${escapeHtml(provider.label)}</span>
        <span class="cost-tag ${provider.is_free ? "free" : "paid"}">${provider.is_free ? "Gratis" : "Pago"}</span>
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

function setConfigTab(tab) {
  state.configTab = tab;
  $$(".config-tab").forEach((button) => button.classList.toggle("active", button.dataset.configTab === tab));
  $$(".config-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `config-panel-${tab}`));
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

  $("#flowGrid").innerHTML = general + orchestration + weights + levels + tables;
  updateWeightsSum();
  CRITERIA.forEach((name) => $(`#cfg-w-${name}`).addEventListener("input", updateWeightsSum));
  bindFlowAutosave();
  renderPromptConfiguration();
  setConfigMode(state.configMode);
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
  const groups = {
    cli: catalog.filter((p) => p.backend === "cli"),
    api: catalog.filter((p) => p.backend === "api"),
    simulated: catalog.filter((p) => p.backend === "simulated"),
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

function configAgentCard(provider, status = {}) {
  const ready = status.ready;
  const available = status.available;
  const dot = ready ? "ok" : available ? "warn" : "bad";
  const auth = provider.auth_method === "api_key" ? provider.env_var || "API key" : provider.login_command || provider.auth_method;
  const selected = state.selectedConfigAgent === provider.name ? "selected" : "";
  return `<article class="config-agent-card compact ${ready ? "ready" : available ? "available" : "missing"} ${selected}" data-agent-card="${escapeHtml(provider.name)}">
    <span class="status-dot ${dot}"></span>
    <div class="config-agent-card-body">
      <b>${escapeHtml(provider.label)}</b>
      <small>${escapeHtml(provider.backend)} · ${escapeHtml(auth)}</small>
    </div>
    <span class="cost-tag ${provider.is_free ? "free" : "paid"}">${provider.is_free ? "Gratis" : "Pago"}</span>
  </article>`;
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
  $("#monitorTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-monitor-tab]");
    if (button) setMonitorTab(button.dataset.monitorTab);
  });
  $("#view-flow")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-config-mode]");
    if (button) setConfigMode(button.dataset.configMode);
  });
  $("#toggleMonitorSide")?.addEventListener("click", () => setMonitorSide(!state.monitorSideOpen));
  $("#toggleHumanSide")?.addEventListener("click", () => setHumanSide(!state.humanSideOpen));
  $("#toggleAgentsSide")?.addEventListener("click", () => setAgentsSide(!state.agentsSideOpen));
  initMonitorSplitter();
  initHumanSplitter();
  initAgentsSplitter();
  initMonitorBlocks();
  $("#modelsAdvanced").addEventListener("change", renderModels);
  initAutoRefresh();
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
      $('[data-view="agents"]')?.click();
      state.selectedConfigAgent = notificationProvider.dataset.notificationProvider;
      renderAgentsView();
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
      renderPromptConfiguration();
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
      renderPromptConfiguration();
      return;
    }
    const applyPrompt = event.target.closest("[data-apply-prompt]");
    if (applyPrompt) {
      if (applyPrompt.dataset.applyPrompt === "default-config") {
        applyDefaultConfig();
      } else {
        toast("Primer flujo preparado: copia el prompt o pásalo al agente elegido en la siguiente iteración.");
      }
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
    }
  });
  document.addEventListener("change", (event) => {
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
    if ($("#view-decision").classList.contains("active")) drawWires();
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

init();

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
var lastBellCount=-1;
var panelStates={metrics:'open',spec:'open'}; // 'open'|'mini'|'closed'
// fixed workstation offsets per agent (relative to home tile)
var WORKSPOTS={
  claude:   {dx:-0.5,dy:-0.8},
  codex:    {dx:-0.9,dy: 0.6},
  qwen:     {dx: 0.8,dy:-0.5},
  deepseek: {dx:-0.6,dy: 0.8},
  mistral:  {dx: 0.7,dy: 0.7},
};

// ── HELPERS ──────────────────────────────────────────────────────────────────
function iso(gx,gy){return {x:OX+(gx-gy)*TW, y:OY+(gx+gy)*TH};}
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
  OX=LW+(W-LW)*0.5; // center of available area right of left panel
  OY=H*0.06;
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
    var ws=WORKSPOTS[ag.id];if(!ws)return;
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
    ctx2.fillStyle=ag?c(ag.col,0.14):nearCard?'rgba(100,160,255,0.04)':'rgba(255,255,255,0.018)';
    ctx2.strokeStyle=ag?c(ag.col,0.4):nearCard?'rgba(100,160,255,0.06)':'rgba(255,255,255,0.045)';
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
  ctx2.fillStyle=selectedId===ag.id?'#FFF':ag.col;ctx2.textAlign='center';ctx2.textBaseline='bottom';ctx2.fillText(ag.name,cx,nameY);
  ctx2.font='600 '+Math.round(TW*0.135)+'px system-ui';
  var lw=ctx2.measureText(ag.level).width,lx=cx+ctx2.measureText(ag.name).width/2+3.5*sc;
  ctx2.fillStyle=c(ag.col,0.2);ctx2.beginPath();rr(lx,nameY-9*sc,lw+5*sc,8*sc,2);ctx2.fill();
  ctx2.strokeStyle=c(ag.col,0.4);ctx2.lineWidth=0.5;ctx2.beginPath();rr(lx,nameY-9*sc,lw+5*sc,8*sc,2);ctx2.stroke();
  ctx2.fillStyle=ag.col;ctx2.textAlign='center';ctx2.fillText(ag.level,lx+lw/2+2.5*sc,nameY-1*sc);

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
function syncBell(){
  var pending=decisions.filter(function(d){return !d.resolved;}).length;
  if(pending===lastBellCount)return;
  lastBellCount=pending;
  var badge=document.getElementById('notificationBadge');
  var count=document.getElementById('notificationPanelCount');
  if(badge){badge.textContent=String(pending);badge.hidden=pending===0;}
  if(count)count.textContent=String(pending);
  // populate panel summary with our decisions
  var summary=document.getElementById('notificationSummary');
  if(summary&&pending>0){
    summary.innerHTML=decisions.filter(function(d){return !d.resolved;}).map(function(d){
      return '<article class="notification-item warn">'
        +'<span class="status-dot warn"></span>'
        +'<div><b>'+escHtml(d.title)+'</b>'
        +'<small>'+(d.agentId||'IA')+' · Decisión de agente pendiente</small>'
        +'</div></article>';
    }).join('');
  }
}
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
  // window buttons — only minimize (no close)
  winBtn(LW-25,panY+5,17,17,'255,190,30',st==='mini'?'▪':'─',st==='mini'?'open_metrics':'mini_metrics');

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
    if(alive){var mp=0.6+0.4*Math.abs(Math.sin(tick*0.08+ag.ph));ctx2.fillStyle=c(ag.col,mp);ctx2.beginPath();ctx2.arc(px+3,py+5,3,0,Math.PI*2);ctx2.fill();}
    else{ctx2.fillStyle='rgba(80,100,130,0.4)';ctx2.beginPath();ctx2.arc(px+3,py+5,2.5,0,Math.PI*2);ctx2.fill();}
    ctx2.fillStyle=alive?ag.col:'rgba(90,110,140,0.5)';
    ctx2.font=(alive?'bold ':'')+'8.5px system-ui';ctx2.textAlign='left';ctx2.textBaseline='middle';
    ctx2.fillText(ag.name.substring(0,10),px+9,py+5);
    var bW=LW-24-68,bX2=px+68;
    ctx2.fillStyle='rgba(255,255,255,0.06)';ctx2.beginPath();ctx2.rect(bX2,py+1,bW,7);ctx2.fill();
    if(load>0){ctx2.fillStyle=ag.col;ctx2.beginPath();rr(bX2,py+1,Math.max(3,bW*load),7,2);ctx2.fill();}
    ctx2.fillStyle=alive?ag.col:'rgba(90,110,140,0.5)';ctx2.font='7.5px monospace';ctx2.textAlign='right';
    ctx2.fillText(Math.round(load*100)+'%',LW-8,py+5);py+=15;
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
  ctx2.fillStyle='rgba(255,255,255,0.92)';ctx2.font='bold 11px system-ui';ctx2.textAlign='left';ctx2.textBaseline='middle';
  ctx2.fillText(ag.name+' '+ag.level,PX+10,PY+13);
  ctx2.fillStyle='rgba(255,255,255,0.55)';ctx2.font='9px system-ui';ctx2.fillText(ag.role,PX+10+ctx2.measureText(ag.name+' '+ag.level).width+8,PY+13);
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
  syncBell();
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
  if(demoRunning)return;stopDemo();demoRunning=true;
  taskCards=[];links=[];sparkles=[];dataStacks={};
  // keep existing unresolved decisions, only clear resolved ones
  decisions=decisions.filter(function(d){return !d.resolved;});
  effTarget=0;effCur=0;effHistory=[];
  AGENTS.forEach(function(ag){agentModes[ag.id]={mode:'idle',since:Date.now()};});
  DEMO.forEach(function(step){demoTimers.push(setTimeout(function(){if(DACT[step.fn])DACT[step.fn].apply(null,step.a);},step.ms));});
  demoTimers.push(setTimeout(function(){demoRunning=false;},23000));
}
function stopDemo(){demoTimers.forEach(clearTimeout);demoTimers=[];demoRunning=false;}

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

// ── CLICK ─────────────────────────────────────────────────────────────────────
function handleClick(e){
  if(!cvs)return;
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
  }
  resize();initWander();
  if(!running){running=true;requestAnimationFrame(frame);}
  poll();clearInterval(cvs._pollInt);cvs._pollInt=setInterval(poll,5000);
}

setTimeout(activate,400);
})();
