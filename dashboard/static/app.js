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
};

const ROLE_DEFS = {
  parent: {
    label: "Agent",
    summary: "Orquesta, clasifica, planifica, enruta y delega.",
    kind: "agent",
    canOwnLevels: true,
    canConnectToAgent: false,
  },
  child: {
    label: "Worker",
    summary: "Ejecuta tareas concretas asignadas por el Agent.",
    kind: "worker",
    canOwnLevels: true,
    canConnectToAgent: true,
  },
  backup: {
    label: "Backup",
    summary: "Reserva en standby; puede asumir Agent si falla el principal.",
    kind: "backup",
    canOwnLevels: true,
    canConnectToAgent: true,
  },
  guardian: {
    label: "Guardian",
    summary: "Apoya o revisa un Worker concreto.",
    kind: "guardian",
    canOwnLevels: false,
    canConnectToAgent: true,
  },
  validator: {
    label: "Validator",
    summary: "Valida salidas parciales o finales de otros nodos.",
    kind: "validator",
    canOwnLevels: false,
    canConnectToAgent: true,
  },
  memory: {
    label: "Memory",
    summary: "Mantiene estado, checkpoints y contexto.",
    kind: "memory",
    canOwnLevels: false,
    canConnectToAgent: true,
  },
  monitor: {
    label: "Monitor",
    summary: "Vigila salud, timeouts, errores y disponibilidad.",
    kind: "monitor",
    canOwnLevels: false,
    canConnectToAgent: true,
  },
};

const AGENT_INTERNAL_CAPABILITIES = ["Classifier", "Planner", "Router"];
const AGENT_OPTIONAL_CAPABILITIES = [
  ["Reallocator", "Reasigna roles, tareas y enlaces cuando la jerarquía se rompe."],
  ["Aggregator", "Consolida respuestas de varios nodos."],
  ["Policy", "Aplica permisos, límites y reglas críticas."],
  ["Recovery", "Gestiona reintentos y recuperación operativa."],
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
  setActiveViewActions("monitor");
  $("#viewNav").addEventListener("click", (event) => {
    const tab = event.target.closest(".view-tab");
    if (!tab) return;
    const view = tab.dataset.view;
    $$(".view-tab").forEach((t) => t.classList.toggle("active", t === tab));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
    setActiveViewActions(view);
    if (view === "decision") {
      renderDiagram();
      renderModels();
    }
    if (view === "flow") renderFlow();
  });
}

function setActiveViewActions(view) {
  $$(".action-set").forEach((set) => set.classList.toggle("active", set.dataset.actionView === view));
}

// ---- MONITOR ---------------------------------------------------------------
async function refreshMonitor() {
  if (!$("#monitorMainContent") && !$("#kpis")) return;
  const [metrics, tasks, observability] = await Promise.all([api("/metrics"), api("/tasks"), api("/observability")]);
  state.tasks = tasks;
  state.lastObservability = observability;
  if (!state.selectedNodeId && observability.nodes?.length) state.selectedNodeId = observability.nodes[0].id;
  if ($("#monitorMainContent")) {
    renderSummaryMetrics(metrics, tasks, observability);
    renderSystemHealth(observability.health);
    renderExecutionFlow(observability.execution_flow || []);
    renderProcessingNodeTabs(observability.nodes || []);
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
  $("#systemHealth").innerHTML = `<div class="health-hero ${status}">
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
    </div>
    <div class="health-foot"><span>$${Number(health.total_cost || 0).toFixed(4)} coste</span><span>${formatTime(health.last_activity)}</span></div>`;
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
    { key: "_caps",                  label: "Capacidades",  fmt: (n) => n },
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
  if (key === "_levels") return (node.levels || []).map((l) => LEVEL_FULL[l] || l).join(", ") || "sin niveles";
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
    .slice(0, 18);
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
  target.innerHTML = [
    `<button class="${!state.selectedNodeId || state.selectedNodeId === "__all__" ? "active" : ""}" type="button" data-tab-node="__all__">ALL NODES</button>`,
    ...visibleNodes.map((node) => {
      const role = node.role || "Node";
      const name = node.name || node.active_model || "Modelo";
      const selected = node.id === state.selectedNodeId ? "active" : "";
      return `<button type="button" class="${selected}" data-tab-node="${escapeHtml(node.id)}">${escapeHtml(name)} (${escapeHtml(role)})</button>`;
    }),
  ].join("");
  target.querySelectorAll("button[data-tab-node]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nodeId = btn.dataset.tabNode;
      if (nodeId === "__all__") {
        state.selectedNodeId = visibleNodes[0]?.id || "";
      } else {
        state.selectedNodeId = nodeId;
      }
      target.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn || (nodeId === "__all__" && b.dataset.tabNode === "__all__")));
      setMonitorSide(true);
      _renderAgentPanels(
        visibleNodes,
        state.lastObservability?.model_usage || [],
        state.lastObservability?.execution_flow || [],
        state.lastObservability?.audit_timeline || []
      );
    });
  });
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
  $("#auditTimeline").innerHTML = eventList(events.slice(0, 18), "Sin eventos de auditoría.");
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
                <b>${escapeHtml(event.event_type)}</b>
                <em>${event.cost ? `$${Number(event.cost).toFixed(4)}` : event.latency_ms ? `${event.latency_ms}ms` : ""}</em>
              </div>
              <span>${escapeHtml(event.summary)}</span>
              <small>${escapeHtml(event.source_node || "Agent")}${event.target_node ? ` → ${escapeHtml(event.target_node)}` : ""} · ${escapeHtml(event.task_id)}${event.model ? ` · ${escapeHtml(event.model)}` : ""}</small>
            </div>
          </div>`
        )
        .join("")
    : `<div class="chart-empty">${emptyText}</div>`;
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
  $$("#diagramNodes .entity-role").forEach((sel) =>
    sel.addEventListener("change", (event) => {
      const entity = findEntity(event.target.dataset.entity);
      if (!entity) return;
      entity.role = event.target.value;
      if (isAgentRole(entity.role)) {
        state.entities.forEach((item) => {
          if (item.id !== entity.id && isAgentRole(item.role)) item.role = "child";
        });
        entity.parentId = "";
      } else {
        entity.parentId ||= state.entities.find((item) => isAgentRole(item.role))?.id || "";
        entity.capabilities = [];
      }
      if (!canOwnLevels(entity.role)) {
        entity.levels = [];
      }
      renderDiagram();
      scheduleRoutingSave("Rol actualizado. Guardando…");
    })
  );
  $$("#diagramNodes .agent-capability").forEach((box) =>
    box.addEventListener("change", (event) => {
      const entity = findEntity(event.target.dataset.entity);
      if (!entity || !isAgentRole(entity.role)) return;
      entity.capabilities ||= [];
      if (event.target.checked && !entity.capabilities.includes(event.target.value)) entity.capabilities.push(event.target.value);
      if (!event.target.checked) entity.capabilities = entity.capabilities.filter((item) => item !== event.target.value);
      renderDiagram();
      scheduleRoutingSave("Capacidades del Agent actualizadas. Guardando…");
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
  const role = roleDef(entity.role);
  const roleLabel = role.label;
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
  const capabilities = agentCapabilities(entity);
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
        <label>Rol
          <select class="entity-role" data-entity="${entity.id}">
            ${roleOptions(entity.role)}
          </select>
          <small>${escapeHtml(role.summary)}</small>
        </label>
        ${connection}
        ${levelControls}
        ${capabilities}
        ${skills}
      </div>
    </div>`.replace('<div class="node entity', `<div style="left:${screenX(entity.x || 0)}px; top:${screenY(entity.y || 0)}px; --entity-accent:${accent.color}; --entity-ink:${accent.ink}" class="node entity`);
}

function roleDef(role) {
  return ROLE_DEFS[role] || ROLE_DEFS.child;
}

function roleOptions(current) {
  return Object.entries(ROLE_DEFS)
    .map(([value, role]) => `<option value="${value}" ${value === current ? "selected" : ""}>${role.label}</option>`)
    .join("");
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

function agentCapabilities(entity) {
  if (!isAgentRole(entity.role)) return "";
  const selected = new Set(entity.capabilities || []);
  const base = AGENT_INTERNAL_CAPABILITIES.map((name) => `<span title="Capacidad interna del Agent">${name}</span>`).join("");
  const optional = AGENT_OPTIONAL_CAPABILITIES.map(
    ([name, description]) =>
      `<label title="${escapeHtml(description)}"><input class="agent-capability" data-entity="${entity.id}" type="checkbox" value="${name}" ${selected.has(name) ? "checked" : ""}/> ${name}</label>`
  ).join("");
  return `<div class="agent-capabilities">
      <div class="cap-row fixed">${base}</div>
      <div class="cap-row optional">${optional}</div>
    </div>`;
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
  state.entities.push({
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
  });
  renderDiagram();
  scheduleRoutingSave("Entidad añadida. Guardando…");
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
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  svg.innerHTML = $$("#diagramNodes .node.entity.child")
    .filter((node) => node.dataset.entity && findEntity(node.dataset.entity)?.parentId)
    .map((node) => {
      const route = connectionRoute(parent, node);
      setNodePort(parent, route.from);
      setNodePort(node, route.to);
      return `<path d="${wirePath(route.start, route.end, route.from, route.to)}" fill="none" stroke="${accent}" stroke-width="1.5" opacity="0.7"/>`;
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

  const groups = {};
  catalog.forEach((p) => (groups[p.backend] || (groups[p.backend] = [])).push(p));
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

function renderFlow() {
  const c = state.config;
  if (!c) return;
  const o = c.orchestration;

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
    <h4>Coste por modelo ($)</h4>
    ${TIERS.map((tier) => field(TIER_LABEL[tier], numberInput(`cfg-cost-${tier}`, c.cost_table[tier] ?? 0, "0.0001", "0"))).join("")}
    <h4>Latencia base (ms)</h4>
    ${TIERS.map((tier) => field(TIER_LABEL[tier], numberInput(`cfg-lat-${tier}`, c.latency_table[tier] ?? 0, "10", "0"))).join("")}</div>`;

  $("#flowGrid").innerHTML = general + orchestration + weights + levels + tables;
  updateWeightsSum();
  CRITERIA.forEach((name) => $(`#cfg-w-${name}`).addEventListener("input", updateWeightsSum));
  bindFlowAutosave();
}

function updateWeightsSum() {
  const sum = CRITERIA.reduce((acc, name) => acc + (parseFloat($(`#cfg-w-${name}`).value) || 0), 0);
  const node = $("#weightsSum");
  node.textContent = `Suma de pesos: ${sum.toFixed(2)} (ideal 1.00)`;
  node.classList.toggle("bad", Math.abs(sum - 1) > 0.001);
}

function collectConfig() {
  const c = structuredClone(state.config);
  c.profile = $("#cfg-profile").value;
  c.backend = $("#cfg-backend").value;
  c.prefer_free = $("#cfg-prefer_free").checked;
  c.orchestration.parallel = $("#cfg-parallel").checked;
  c.orchestration.max_parallel = parseInt($("#cfg-max_parallel").value, 10);
  c.orchestration.subtask_timeout_s = parseInt($("#cfg-subtask_timeout_s").value, 10);
  c.orchestration.max_retries = parseInt($("#cfg-max_retries").value, 10);
  c.orchestration.require_human_review_gate = $("#cfg-review_gate").checked;
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
  $("#monitorTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-monitor-tab]");
    if (button) setMonitorTab(button.dataset.monitorTab);
  });
  $("#toggleMonitorSide")?.addEventListener("click", () => setMonitorSide(!state.monitorSideOpen));
  initMonitorSplitter();
  initMonitorBlocks();
  $("#refreshMonitor").addEventListener("click", () => refreshMonitor().catch((e) => toast(e.message)));
  $("#saveRouting").addEventListener("click", () => saveRouting(false));
  $("#modelsAdvanced").addEventListener("change", renderModels);
  document.addEventListener("click", (event) => {
    const approve = event.target.closest("[data-approve]");
    if (approve) {
      api(`/tasks/${approve.dataset.approve}/approve-review`, { method: "POST" })
        .then((task) => {
          state.selected = task.task_id;
          toast("Revisión humana aprobada.");
          return refreshMonitor();
        })
        .catch((error) => toast(error.message));
      return;
    }
    if (!event.target.closest(".model-chip-picker")) {
      $$(".model-chip-picker.open").forEach((item) => item.classList.remove("open"));
    }
  });
  $("#saveConfig").addEventListener("click", () => saveFlow(false));
  $("#reloadConfig").addEventListener("click", async () => {
    await loadConfig();
    renderFlow();
    toast("Configuración recargada.");
  });
  window.addEventListener("resize", () => {
    if ($("#view-decision").classList.contains("active")) drawWires();
  });
  initDrawerControls();
  initDiagramViewport();

  loadConfig()
    .then(() => Promise.all([api("/catalog").then((c) => (state.catalog = c)), loadRoutingLayout(), refreshMonitor()]))
    .then(() => {
      applyDrawerState();
      applyDiagramZoom();
    })
    .catch((error) => toast(error.message));
}

init();
