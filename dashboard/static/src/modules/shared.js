// Constantes y utilidades transversales (sin vista propia).
//
// Extraído mecánicamente de app.js (nota "Plan de mejora", §18): mismo
// código, mismo comportamiento — solo cambia de dónde vienen sus nombres
// compartidos (antes globals de un único archivo, ahora imports explícitos).

﻿"use strict";

// ---- constants -------------------------------------------------------------
export const TIERS = [
  "cheap_model",
  "cheap_or_medium_model",
  "medium_model",
  "strong_model",
  "strong_model_with_human_review",
];

export const TIER_LABEL = {
  cheap_model: "barato",
  cheap_or_medium_model: "barato/medio",
  medium_model: "medio",
  strong_model: "fuerte",
  strong_model_with_human_review: "fuerte + revisión",
};

export const LEVELS = [
  ["level_1_simple", "N1"],
  ["level_2_moderate", "N2"],
  ["level_3_intermediate", "N3"],
  ["level_4_complex", "N4"],
  ["level_5_critical", "N5"],
];

export const LEVEL_FULL = {
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
export const GROUP_COLOR_PALETTE = [
  "#7cc4ff",
  "#ffb25f",
  "#b9a7ff",
  "#5fd0a8",
  "#ff8fb1",
  "#f2d05a",
];

export function nextGroupColor() {
  const used = (state.groups || []).length;
  return GROUP_COLOR_PALETTE[used % GROUP_COLOR_PALETTE.length];
}

export function prioChipLabel(n) {
  return `Prio ${n}`;
}

// Group colors come from an <input type="color"> (#rrggbb) but may be
// hand-edited in the persisted JSON; sanitize before injecting into SVG markup.
export function safeColor(value) {
  return /^#[0-9a-fA-F]{3,8}$/.test(String(value || "")) ? value : "#7cc4ff";
}

export const CRITERIA = [
  "ambiguity",
  "context_required",
  "reasoning_depth",
  "autonomy_required",
  "operational_risk",
  "validation_difficulty",
];

export const DIAGRAM_BASE_WIDTH = 12000;

export const DIAGRAM_BASE_HEIGHT = 8000;

export const DIAGRAM_PAD_X = 6000;

export const DIAGRAM_PAD_Y = 4000;

export const OPENCLAW_NODE_ACCENT = "#3ecf9a"; // teal — visually distinct from routing-entity accents

export const OPENCLAW_POS_KEY = "karajan-openclaw-pos";

export const state = {
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
  skillAnalyticsDays: 30,
  skillInventoryView: localStorage.getItem("karajan-skill-inventory-view") === "timeline" ? "timeline" : "table",
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
  resources: [],
  selectedResourceId: "",
  resourceDetail: null,
  resourceFilters: { query: "", kind: "", status: "", runtime: "", agent: "", source: "", structure: "" },
  resourceSearchTimer: 0,
  resourceWizard: { step: 1, mode: "catalog", repoUrl: "", analysis: null },
  resourceConfirm: null,
  resourceOperationPending: null,
  resourceDiscoverySources: [],
  resourceDiscoveryFeed: [],
  resourceDiscoveryErrors: [],
  resourceDiscoveryLastFetchedAt: 0,
  resourceDiscoverySource: "",
  resourceRefreshSettings: { repository_enabled: true, repository_interval_days: 7, radar_interval_minutes: 60 },
  resourceRefreshRun: null,
  resourceRefreshPollId: "",
  resourceInspectorOpen: false,
  resourceInspectorTriggerId: "",
  resourceInspectorWidth: Math.min(760, Math.max(360, Number(localStorage.getItem("karajan-inspiration-inspector-width")) || 520)),
  resizingResourceInspector: false,
  resourceGroups: [],
  resourceGroupView: [],
  resourceGroupFilter: "",
  resourceDisplayMode: (() => {
    const current = localStorage.getItem("karajan-inspiration-display-v2");
    if (["gallery", "list", "tree"].includes(current)) return current;
    return localStorage.getItem("karajan-inspiration-display") === "tree" ? "list" : "gallery";
  })(),
  resourceTreeFocusId: "",
  resourceGroupPersistenceAvailable: true,
  resourceGroupManagerOpen: false,
  editingResourceGroupId: "",
  inspirationSidebarWidth: Math.min(360, Math.max(220, Number(localStorage.getItem("karajan-inspiration-sidebar-width")) || 270)),
  inspirationSidebarOpen: localStorage.getItem("karajan-inspiration-sidebar-open") !== "false",
  resizingInspirationSidebar: false,
  inspirationSubview: "catalogo",
  activeView: "human",
};

export const ROLE_DEFS = {
  parent: {
    label: "Agent",
    summary: "Orquesta, clasifica, planifica, enruta y delega.",
    detail: "Autoridad raíz de la jerarquía. Recibe la petición, decide la complejidad, planifica el flujo y reparte trabajo entre Workers, Backups y roles de soporte. No es el mejor sitio para ejecutar trabajo de dominio: su valor está en decidir quién debe hacerlo, con qué restricciones y cuándo pedir revisión humana.",
    example: "Define un Agent raíz que reciba la tarea, la clasifique y delegue cada parte al nodo adecuado.",
    group: "Autoridad",
    restriction: "R0",
    kind: "agent",
    canOwnLevels: true,
    canConnectToAgent: false,
  },
  child: {
    label: "Worker",
    summary: "Ejecuta tareas concretas asignadas por el Agent.",
    detail: "Ejecutor principal de trabajo. Un Worker recibe una subtarea concreta y la resuelve con el modelo asignado a su nivel o prioridad. Puede ser propietario de niveles de complejidad; evita duplicar varios Workers con el mismo nivel salvo que formen parte de jerarquías/prioridades distintas.",
    example: "Asigna un Worker por nivel de complejidad para que ejecute sin solaparse con otros.",
    group: "Ejecución",
    restriction: "R1",
    kind: "worker",
    canOwnLevels: true,
    canConnectToAgent: true,
  },
  backup: {
    label: "Backup",
    summary: "Reserva en standby; puede asumir Agent si falla el principal.",
    detail: "Reserva operativa. Permanece fuera del camino crítico hasta que el Agent o un Worker principal falla, se satura o supera el timeout. No revisa ni valida por defecto: aporta continuidad y capacidad de relevo sin convertir el flujo normal en doble ejecución.",
    example: "Mantén un Backup en standby para asumir la coordinación si el Agent principal cae.",
    group: "Ejecución",
    restriction: "R1",
    kind: "backup",
    canOwnLevels: true,
    canConnectToAgent: true,
  },
  guardian: {
    label: "Guardian",
    summary: "Supervisa un Worker durante la ejecución y detecta riesgos antes de que avance.",
    detail: "Supervisor preventivo de un nodo concreto. Un Guardian acompaña a un Worker mientras trabaja: vigila coherencia, deriva de alcance, riesgo operativo y señales de salida dudosa. No emite la aprobación final ni aplica parches; su función es levantar alertas tempranas y pedir freno o revisión cuando el ejecutor se desvía.",
    example: "Añade un Guardian a un Worker crítico para supervisar su proceso y frenar desviaciones antes de entregar.",
    group: "Soporte",
    restriction: "R2",
    kind: "guardian",
    canOwnLevels: false,
    canConnectToAgent: true,
  },
  validator: {
    label: "Validator",
    summary: "Acepta o rechaza una salida comparándola contra criterios verificables.",
    detail: "Puerta de calidad sobre resultados. Un Validator revisa una salida parcial o final ya producida y decide si pasa: contrato cumplido, tests esperados, evidencias suficientes, formato correcto y restricciones respetadas. No acompaña el proceso como Guardian ni corrige el código como Fixeador; devuelve aprobación, rechazo o feedback accionable.",
    example: "Coloca un Validator al final del flujo para aceptar o rechazar la salida antes de cerrarla.",
    group: "Soporte",
    restriction: "R2",
    kind: "validator",
    canOwnLevels: false,
    canConnectToAgent: true,
  },
  fixer: {
    label: "Fixeador",
    summary: "Recibe un reporte de errores concreto y aplica correcciones activas sobre el código.",
    detail: "Rol de reparación activa. Cuando se le delega un reporte de errores de detección de código (p. ej. de un linter, test suite o auditoría externa), el agente marcado como Fixeador aplica parches acotados para resolverlos. No sustituye al Validator: el Validator acepta o rechaza resultados; el Fixeador interviene sobre código con un reporte de fallos concreto.",
    example: "Etiqueta un agente como Fixeador para delegarle un reporte de errores y que aplique las correcciones.",
    group: "Soporte",
    restriction: "R2",
    kind: "fixer",
    canOwnLevels: false,
    canConnectToAgent: true,
  },
  memory: {
    label: "Memory",
    summary: "Mantiene estado, checkpoints y contexto.",
    detail: "Memoria de trabajo del sistema. Conserva contexto, decisiones, checkpoints y estado entre iteraciones largas. No ejecuta, no valida y no supervisa: evita que la jerarquía pierda continuidad cuando la tarea se divide, se pausa o requiere retomar información previa.",
    example: "Usa Memory para conservar contexto y checkpoints en flujos largos o reanudables.",
    group: "Estado",
    restriction: "R3",
    kind: "memory",
    canOwnLevels: false,
    canConnectToAgent: true,
  },
  monitor: {
    label: "Monitor",
    summary: "Vigila salud, timeouts, errores y disponibilidad.",
    detail: "Observabilidad operativa. Vigila disponibilidad, timeouts, errores, latencia y señales de saturación del resto de nodos. No evalúa la calidad del contenido como Validator ni interviene en la tarea como Guardian; informa al Agent para que reasigne, pause o escale cuando el sistema se degrada.",
    example: "Despliega un Monitor para detectar timeouts, nodos caídos o saturación antes de que bloqueen la cola.",
    group: "Estado",
    restriction: "R3",
    kind: "monitor",
    canOwnLevels: false,
    canConnectToAgent: true,
  },
};

export const PRIMARY_ROLES = ["parent", "child", "backup"];

export const SUPPORT_ROLES = ["guardian", "validator", "fixer", "memory", "monitor"];

// Hierarchy depth is no longer a role tag — it lives in `state.groups` +
// `entity.memberships` (see GROUP_COLOR_PALETTE above). The ROL dropdown only
// keeps Autoridad/Ejecución/Soporte/Estado now.
export const ROLE_GROUPS = ["Autoridad", "Ejecución", "Soporte", "Estado"];

export const AGENT_INTERNAL_CAPABILITIES = ["Classifier", "Planner", "Router"];

const AGENT_OPTIONAL_CAPABILITIES = [
  ["Reallocator", "Reasigna roles, tareas y enlaces cuando la jerarquía se rompe."],
  ["Aggregator", "Consolida respuestas de varios nodos."],
  ["Policy", "Aplica permisos, límites y reglas críticas."],
  ["Recovery", "Gestiona reintentos y recuperación operativa."],
];

export const AGENT_CAPABILITY_DEFS = [
  ...AGENT_INTERNAL_CAPABILITIES.map((name) => [name, "Base Agent", "Capacidad base del Agent."]),
  ...AGENT_OPTIONAL_CAPABILITIES.map(([name, description]) => [name, "Agent avanzado", description]),
];

// ---- helpers ---------------------------------------------------------------
export const $ = (sel, root = document) => root.querySelector(sel);

export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Cliente de la API — extraído a `src/core/api-client.js` (nota "Plan de
// mejora", §3/§19): un módulo aparte que sabe dónde vive el backend, en vez
// de que cada vista resuelva `fetch`/la base por su cuenta. Se reexportan
// `API_BASE`/`apiUrl`/`api` con la misma forma de antes para no tocar las
// ~550 funciones que ya las usan por su nombre — la migración de cada vista a
// `runtimeContext.api` es incremental (ver `src/core/runtime.js`).
import { ApiClient, resolveApiBase } from "../core/api-client.js";

const API_BASE = resolveApiBase();

const __apiClient = new ApiClient({ base: API_BASE });

export const apiUrl = (path) => __apiClient.url(path);

export const api = (path, options = {}) => __apiClient.request(path, options);

let toastTimer = null;

export function toast(message, ms = 2400) {
  const node = $("#toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), ms);
}

export const escapeHtml = (value) =>
  String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function entityLabel(id) {
  const entity = (state.entities || []).find((item) => item.id === id);
  if (!entity) return id || "entidad";
  const provider = (state.catalog || []).find((item) => item.name === entity.provider);
  return entity.name || provider?.label || entity.provider || entity.id;
}

export function readStoredOpenClawPos() {
  try {
    const stored = JSON.parse(localStorage.getItem(OPENCLAW_POS_KEY) || "null");
    if (stored && Number.isFinite(Number(stored.x)) && Number.isFinite(Number(stored.y))) {
      return { x: Number(stored.x), y: Number(stored.y) };
    }
  } catch {
    return null;
  }
  return null;
}

function readOpenClawPos() {
  const stored = readStoredOpenClawPos();
  if (stored) return stored;
  return { x: -300, y: 40 };
}
