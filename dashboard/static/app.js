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
};

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
let activeModelDrag = null;
let activeEntityMove = null;
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
  const [metrics, tasks] = await Promise.all([api("/metrics"), api("/tasks")]);
  state.tasks = tasks;
  renderKpis(metrics);
  renderCharts(metrics);
  renderTaskRows(tasks);
  const selected = tasks.find((t) => t.task_id === state.selected) || tasks[0];
  if (selected) {
    state.selected = selected.task_id;
    await renderDetail(selected);
  }
}

function renderKpis(metrics) {
  const topModel = Object.entries(metrics.by_model).sort((a, b) => b[1] - a[1])[0];
  const cells = [
    ["Tareas", metrics.total_tasks],
    ["Score medio", metrics.average_complexity_score.toFixed(2)],
    ["Revisión humana", metrics.human_review_required],
    ["Coste est.", `$${metrics.total_estimated_cost_usd.toFixed(4)}`],
    ["Modelo top", topModel ? TIER_LABEL[topModel[0]] || topModel[0] : "—"],
  ];
  $("#kpis").innerHTML = cells
    .map(([label, value]) => `<div class="kpi"><span>${label}</span><b>${escapeHtml(value)}</b></div>`)
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
  return `<section class="card chart-card"><header class="card-h">${title}</header><div class="chart-body">${rows}</div></section>`;
}

function renderCharts(metrics) {
  const byLevel = LEVELS.map(([key]) => [key, metrics.by_level[key] || 0]).filter(([, v]) => v || true);
  const reviewRatio = metrics.total_tasks
    ? Math.round((metrics.human_review_required / metrics.total_tasks) * 100)
    : 0;
  const gauge = `<section class="card chart-card"><header class="card-h">Revisión humana</header>
    <div class="gauge"><div class="gauge-num">${reviewRatio}%</div>
      <div class="gauge-track"><div class="gauge-fill" style="width:${reviewRatio}%"></div></div>
      <div class="gauge-sub">${metrics.human_review_required}/${metrics.total_tasks} tareas · score medio ${metrics.average_complexity_score.toFixed(
        2
      )}</div></div></section>`;
  $("#charts").innerHTML =
    barCard("Por nivel de complejidad", byLevel, LEVEL_FULL) +
    barCard("Por modelo / tier", Object.entries(metrics.by_model), TIER_LABEL) +
    barCard("Por backend", Object.entries(metrics.by_backend)) +
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
    $("#dDecisions").innerHTML =
      decisions
        .map(
          (d) =>
            `<div class="row"><b>[${d.phase}]</b> ${escapeHtml(d.decision)}${
              d.reason ? ` — ${escapeHtml(d.reason)}` : ""
            }</div>`
        )
        .join("") || `<div class="row">Sin decisiones registradas.</div>`;
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
}

function normalizeEntityPositions() {
  const usedLevels = new Set();
  state.entities.forEach((entity, index) => {
    entity.x = Number.isFinite(Number(entity.x)) ? Number(entity.x) : 24 + index * 344;
    entity.y = Number.isFinite(Number(entity.y)) ? Number(entity.y) : 36;
    entity.levels ||= [];
    entity.skills ||= [];
    if (entity.role === "skill") {
      entity.levels = [];
      return;
    }
    entity.levels = entity.levels.filter((level) => {
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
      entity.name = provider?.label || (entity.role === "parent" ? "Padre" : entity.role === "skill" ? "Skill" : "Hijo");
      renderDiagram();
      scheduleRoutingSave("Modelo actualizado. Guardando…");
    })
  );
  $$("#diagramNodes .entity-role").forEach((sel) =>
    sel.addEventListener("change", (event) => {
      const entity = findEntity(event.target.dataset.entity);
      if (!entity) return;
      entity.role = event.target.value;
      if (entity.role === "parent") {
        state.entities.forEach((item) => {
          if (item.id !== entity.id && item.role === "parent") item.role = "child";
        });
        entity.parentId = "";
      }
      if (entity.role === "skill") {
        entity.levels = [];
        entity.parentId = "";
      }
      renderDiagram();
      scheduleRoutingSave("Rol actualizado. Guardando…");
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
      renderDiagram();
      scheduleRoutingSave("Skills actualizadas. Guardando…");
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

  requestAnimationFrame(drawWires);
}

function entityCard(entity) {
  const roleLabel = entity.role === "parent" ? "Padre" : entity.role === "skill" ? "Skill" : "Hijo";
  const remove = entity.id !== "entity-parent" ? `<button class="node-x" data-remove="${entity.id}" title="Quitar entidad">✕</button>` : "";
  const title = entity.provider ? modelTitle(entity.provider) : roleLabel;
  const model = modelMeta(entity);
  const parentOptions = state.entities
    .filter((item) => item.role === "parent" && item.id !== entity.id)
    .map((item) => `<option value="${item.id}" ${entity.parentId === item.id ? "selected" : ""}>${escapeHtml(item.name || "Padre")}</option>`)
    .join("");
  const levelControls =
    entity.role === "parent" || entity.role === "child"
      ? `<div class="level-picker">
          ${LEVELS.map(([level, short]) => levelChip(entity, level, short)).join("")}
        </div>`
      : "";
  const connection =
    entity.role === "child"
      ? `<label>Conexión padre
          <select class="entity-parent-link" data-entity="${entity.id}">
            <option value="">Sin conexión</option>${parentOptions}
          </select>
        </label>`
      : "";
  const skills = skillPicker(entity);
  return `<div class="node entity ${entity.role}" data-entity="${entity.id}">
      <div class="drop-hint">Suelta modelo aquí</div>
      ${remove}
      <div class="node-port" title="Punto de conexión"></div>
      <div class="role">Entidad · ${roleLabel}</div>
      <div class="node-title">${escapeHtml(title)}</div>
      <div class="model-meta">${model}</div>
      <div class="entity-controls">
        <label>Rol
          <select class="entity-role" data-entity="${entity.id}">
            <option value="parent" ${entity.role === "parent" ? "selected" : ""}>Padre</option>
            <option value="child" ${entity.role === "child" ? "selected" : ""}>Hijo</option>
            <option value="skill" ${entity.role === "skill" ? "selected" : ""}>Skill</option>
          </select>
        </label>
        ${connection}
        ${levelControls}
        ${skills}
      </div>
    </div>`.replace('<div class="node entity', `<div style="left:${Math.max(0, entity.x || 0)}px; top:${Math.max(0, entity.y || 0)}px" class="node entity`);
}

function findEntity(id) {
  return state.entities.find((item) => item.id === id);
}

function modelTitle(providerName) {
  const provider = state.catalog.find((p) => p.name === providerName);
  return provider?.label || providerName || "Modelo";
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
  if (entity.role === "parent") {
    return state.entities.filter((item) => item.parentId === entity.id || item.id === entity.id).map((item) => item.id);
  }
  if (entity.role === "child" && entity.parentId) {
    return state.entities.filter((item) => item.id === entity.parentId || item.parentId === entity.parentId).map((item) => item.id);
  }
  return [entity.id];
}

function levelOwner(level, entity) {
  return state.entities.find((item) => item.id !== entity.id && item.role !== "skill" && item.levels?.includes(level));
}

function levelChip(entity, level, short) {
  const owner = levelOwner(level, entity);
  const selected = entity.levels?.includes(level);
  const disabled = !!owner;
  return `<button class="level-chip ${selected ? "on" : ""}" ${disabled ? "disabled" : ""} data-entity="${entity.id}" data-level="${level}" title="${disabled ? `Asignado a ${owner.name || "otra entidad"}` : LEVEL_FULL[level]}">
      <span>${short}</span><small>${disabled ? owner.name || modelTitle(owner.provider) || "ocupado" : LEVEL_FULL[level].replace(`${short} · `, "")}</small>
    </button>`;
}

function skillPicker(entity) {
  if (!state.skills.length) return "";
  const selected = new Set(entity.skills || []);
  return `<details class="skill-picker">
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
  state.entities.push({
    id: `entity-${Date.now().toString(36)}`,
    name: provider?.label || providerName,
    role,
    provider: providerName,
    parentId: role === "child" ? state.entities.find((item) => item.role === "parent")?.id || "" : "",
    levels: [],
    skills: [],
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
    x: Math.max(0, clientX - rect.left + diagram.scrollLeft - 120),
    y: Math.max(0, clientY - rect.top + diagram.scrollTop - 30),
  };
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
  const container = $("#diagram");
  const parent = $(".node.entity.parent");
  if (svg) svg.innerHTML = "";
  if (!svg || !parent || !container) return;
  const base = container.getBoundingClientRect();
  const from = parent.getBoundingClientRect();
  const x1 = from.right - base.left;
  const y1 = from.top - base.top + from.height / 2;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  svg.innerHTML = $$("#diagramNodes .node.entity.child")
    .filter((node) => node.dataset.entity && findEntity(node.dataset.entity)?.parentId)
    .map((node) => {
      const r = node.getBoundingClientRect();
      const x2 = r.left - base.left;
      const y2 = r.top - base.top + r.height / 2;
      const mid = (x1 + x2) / 2;
      return `<path d="M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}" fill="none" stroke="${accent}" stroke-width="1.5" opacity="0.7"/>`;
    })
    .join("");
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
  entity.x = Math.max(0, activeEntityMove.originX + event.clientX - activeEntityMove.startX);
  entity.y = Math.max(0, activeEntityMove.originY + event.clientY - activeEntityMove.startY);
  activeEntityMove.node.style.left = `${entity.x}px`;
  activeEntityMove.node.style.top = `${entity.y}px`;
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
  const parent = state.entities.find((item) => item.role === "parent" && item.provider);
  Object.values(state.config.level_to_model).forEach((tier) => delete prefs[tier]);
  if (parent) {
    prefs.strong_model = parent.provider;
    prefs.strong_model_with_human_review = parent.provider;
  } else {
    delete prefs.strong_model;
    delete prefs.strong_model_with_human_review;
  }
  state.entities
    .filter((item) => item.role !== "skill" && item.provider)
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
  $("#refreshMonitor").addEventListener("click", () => refreshMonitor().catch((e) => toast(e.message)));
  $("#saveRouting").addEventListener("click", () => saveRouting(false));
  $("#modelsAdvanced").addEventListener("change", renderModels);
  document.addEventListener("click", (event) => {
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

  loadConfig()
    .then(() => Promise.all([api("/catalog").then((c) => (state.catalog = c)), refreshMonitor()]))
    .catch((error) => toast(error.message));
}

init();
