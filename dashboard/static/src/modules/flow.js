// Pestañas "Configuración" y "Agentes" (`data-view="flow"`/`"agents"`): en el archivo original ambas viven bajo el mismo banner FLOW/PARAMETERS — se mantienen juntas en esta primera extracción mecánica (nota "Plan de mejora", §27: mover primero, separar después) y quedan pendientes de partirse en una pasada propia y verificada aparte.
//
// Extraído mecánicamente de app.js (nota "Plan de mejora", §18): mismo
// código, mismo comportamiento — solo cambia de dónde vienen sus nombres
// compartidos (antes globals de un único archivo, ahora imports explícitos).

import { activeArchitectureProviderNames, addEntityFromProvider, normalizeEntityPositions, renderDiagram, renderModels } from "./decision.js";
import { initAgentsSplitter, setAgentsSide } from "./monitor.js";
import { $, $$, CRITERIA, LEVELS, LEVEL_FULL, ROLE_DEFS, TIERS, TIER_LABEL, api, entityLabel, escapeHtml, state, toast } from "./shared.js";
import { putConfig } from "./shell.js";

let flowSaveTimer = null;

let configHitTimer = null;

function scheduleFlowSave() {
  toast("Cambio detectado. Guardando configuración…", 1400);
  clearTimeout(flowSaveTimer);
  flowSaveTimer = setTimeout(() => saveFlow(true), 650);
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
export function setConfigTab(tab, { scroll = true } = {}) {
  state.configTab = tab;
  $$(".config-tab").forEach((button) => button.classList.toggle("active", button.dataset.configTab === tab));
  if (scroll) {
    $(`#view-flow [data-config-panel="${tab}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
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
  const panels = $$("#view-flow [data-config-panel]");
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

export function setConfigMode(mode) {
  state.configMode = mode;
  const view = $("#view-flow");
  view?.classList.toggle("mode-traditional", mode === "traditional");
  view?.classList.toggle("mode-prompting", mode === "prompting");
  $$("#configModeTabs button").forEach((button) => button.classList.toggle("active", button.dataset.configMode === mode));
  $$(".config-mode-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `config-mode-${mode}`));
  if (mode === "prompting") renderPromptConfiguration();
}

export function renderFlow() {
  const c = state.config;
  if (!c) return;
  const o = c.orchestration;
  c.policy ||= defaultPolicyConfig();

  const general = `<div class="fcard fcard-general"><h3>General</h3>
    ${field("Perfil", selectInput("cfg-profile", c.profile, ["simple", "pro", "offline"]))}
    ${field("Backend", selectInput("cfg-backend", c.backend, ["cli", "api"]))}
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
  const inspirationPanel = $("#resourceRefreshSection");
  if (inspirationPanel) {
    inspirationPanel.classList.add("config-panel", "config-panel-inspiration");
    inspirationPanel.dataset.configPanel = "inspiration";
    $("#flowGrid").append(inspirationPanel);
  }
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

export function renderPromptConfiguration() {
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

export function renderPromptResourceGrid() {
  renderPromptConfiguration();
  renderTraditionalLibrary();
}

// Reuses the SAME resource-library rendering as Prompting mode. In traditional
// mode the index lives on the right and the selected definition is promoted to a
// full-width panel above the config columns.
function renderTraditionalLibrary() {
  const target = $("#traditionalLibraryPanel");
  const detailTarget = $("#traditionalResourceDetailPanel");
  if (!target || !detailTarget || !state.config) return;
  const allResources = buildPromptResourceLibrary();
  const resources = filterPromptResources(allResources, state.promptLibraryQuery);
  if (!state.selectedPromptResourceId || !allResources.some((resource) => resource.id === state.selectedPromptResourceId)) {
    state.selectedPromptResourceId = resources[0]?.id || allResources[0]?.id || "";
  }
  const selectedResource = allResources.find((resource) => resource.id === state.selectedPromptResourceId) || resources[0] || null;
  detailTarget.innerHTML = promptResourceDetailCard(selectedResource, { insertAction: false });
  target.innerHTML = `<section class="prompt-library-panel">
      <header>
        <div class="prompt-library-title">
          <span class="eyebrow">Resource library</span>
          <h3>Biblioteca de recursos</h3>
        </div>
      </header>
      <div class="prompt-library-body">
        ${promptResourceSidebar(resources, selectedResource)}
      </div>
    </section>`;
}

// Live typeahead over every setting row's .field-label across all 5 sections.
// On the first match, switch to that field's section tab and flash-highlight it.
export function filterConfigFields(query) {
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

function promptResourceDetailCard(selectedResource, { insertAction = true } = {}) {
  return selectedResource ? `<article class="prompt-resource-detail">
      <span>${escapeHtml(selectedResource.group)}</span>
      <h4>${escapeHtml(selectedResource.title)}</h4>
      <p>${escapeHtml(selectedResource.description)}</p>
      <code>${escapeHtml(selectedResource.example)}</code>
      ${insertAction ? `<button type="button" data-insert-prompt-resource="${escapeHtml(selectedResource.id)}">Insertar en plantilla</button>` : ""}
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
    description: `${role.restriction || "R?"} · ${role.group || "Rol"} · ${role.detail || role.summary}`,
    example: role.example || `Usa ${role.label} para ${role.summary.toLowerCase()}`,
    snippet: `\n\n## Rol sugerido: ${role.label}\n- Restricción: ${role.restriction || "R?"}\n- Tipo: ${role.group || "Rol"}\n- Uso principal: ${role.summary}\n- Criterio operativo: ${role.detail || "asigna este rol solo si aporta valor claro y no duplica otra responsabilidad."}\n- Prompt breve: ${role.example || `usa ${role.label} solo cuando su responsabilidad esté claramente separada del resto.`}`,
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

export function insertPromptResource(id) {
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

export function saveCurrentPromptTemplate(id) {
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

export function createPromptTemplateFromForm() {
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

export function deletePromptTemplate(id) {
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

export async function renderConfigAgentsPanel() {
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
  };
  const groupLabel = { cli: "Locales / CLI", api: "Nube / API" };
  target.innerHTML = `<div class="config-agent-layout">
    <section class="fcard config-agent-add">
      <h3>Agregar agente manual</h3>
      <div class="agent-console-line">
        <span class="agent-console-prompt">&gt;</span>
        <input id="manual-agent-command" type="text" spellcheck="false" placeholder='add "Nombre" backend=cli auth="comando o ENV"' />
        <button type="button" class="primary" id="runManualAgentCommand">Ejecutar</button>
      </div>
      <p class="config-note">Sintaxis: <code>add "Nombre" backend=cli|api auth="comando o ENV"</code> · <code>remove &lt;id&gt;</code>. Quedan guardados localmente para documentar la topología.</p>
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

export function configAgentCard(provider, status = {}) {
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

export function runManualAgentCommand() {
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

export function removeManualAgent(id) {
  saveManualAgents(getManualAgents().filter((agent) => agent.id !== id));
  if (state.selectedConfigAgent === id) state.selectedConfigAgent = "";
  renderConfigAgentsPanel();
  toast("Agente manual eliminado.");
}

export async function renderAgentsView() {
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

export function ensureEntityForProvider(providerName) {
  let entity = (state.entities || []).find((item) => item.provider === providerName);
  if (entity) return entity;
  entity = addEntityFromProvider(providerName, "child");
  return entity || (state.entities || []).find((item) => item.provider === providerName);
}

export async function setCatalogProviderInDecision(providerName, enabled) {
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

export function renderAgentsSidePanel() {
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

export function addPolicyChip(key) {
  const input = $(`[data-policy-input="${key}"]`);
  const value = input?.value?.trim();
  if (!value) return;
  addPolicyChipValue(key, value);
}

export function addPolicyChipValue(key, value) {
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

export function removePolicyChip(key, value) {
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
