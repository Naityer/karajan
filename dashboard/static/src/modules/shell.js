// El shell de la aplicación: arranque, tema, cambio de pestaña, refresco automático, SSE y los modales genéricos (onboarding, activación de OpenClaw). No es una vista — orquesta a las demás.
//
// Extraído mecánicamente de app.js (nota "Plan de mejora", §18): mismo
// código, mismo comportamiento — solo cambia de dónde vienen sus nombres
// compartidos (antes globals de un único archivo, ahora imports explícitos).

import { addPolicyChip, addPolicyChipValue, configAgentCard, createPromptTemplateFromForm, deletePromptTemplate, ensureEntityForProvider, filterConfigFields, insertPromptResource, removeManualAgent, removePolicyChip, renderAgentsSidePanel, renderAgentsView, renderConfigAgentsPanel, renderFlow, renderPromptConfiguration, renderPromptResourceGrid, runManualAgentCommand, saveCurrentPromptTemplate, setCatalogProviderInDecision, setConfigMode, setConfigTab } from "./flow.js";
import { applyDiagramZoom, applyDrawerState, createGroup, initDiagramViewport, initDrawerControls, loadRoutingLayout, renderDiagram, renderModels, scheduleDrawWires, scheduleRoutingSave } from "./decision.js";
import { applyInspirationSidebarState, initResourceLibraryControls, refreshResourceDiscovery, refreshResourceRefreshSettings, refreshResources, renderResourceDiscoveryUnavailable, renderResourceError, renderResourceRefreshSettings, setInspirationSubview, setResourceGroupManager, setResourceInspector } from "./inspiration.js";
import { initAgentsSplitter, initDataviz, initHumanSplitter, initMonitorBlocks, initMonitorSplitter, initMonitorSubnav, initTaskSearch, refreshMonitor, renderAnalyticsSection, renderPredictionsPanel, renderSkillsAnalytics, restoreMonitorSubview, setAgentsSide, setHumanSide, setMonitorSide, showProviderSetup, syncHumanSideHeight, syncHumanSideOffset } from "./monitor.js";
import { $, $$, api, apiUrl, escapeHtml, state, toast } from "./shared.js";

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
  if (view === "flow") {
    loadConfig().then(renderFlow).catch((error) => toast(error.message));
    refreshResourceRefreshSettings().catch(() => renderResourceRefreshSettings());
  }
  if (view === "agents") refreshProvidersAndAgents().catch((error) => toast(error.message));
  if (view === "resources") {
    applyInspirationSidebarState();
    setInspirationSubview(state.inspirationSubview);
    refreshResources().catch((error) => renderResourceError(error));
    refreshResourceRefreshSettings().catch(() => renderResourceRefreshSettings());
    refreshResourceDiscovery().catch((error) => renderResourceDiscoveryUnavailable(error));
  } else if (state.resourceInspectorOpen) {
    // El drawer es `position: fixed`; si se cambia de pestaña con él abierto,
    // hay que soltar el estado o `body.insp-drawer-open` queda colgando.
    setResourceInspector(false, { restoreFocus: false });
  }
  if (view !== "resources") {
    document.body.classList.remove("insp-sidebar-mobile-open");
    if (state.resourceGroupManagerOpen) setResourceGroupManager(false);
  }
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
    if (view === "resources") {
      refreshResources({ preserveSelection: true }).catch(() => {});
      refreshResourceDiscovery({ preserveSource: true }).catch(() => {});
    }
    // Decisión: refresh only the provider/readiness panel (renderModels),
    // never renderDiagram — re-rendering the editable canvas mid-interaction
    // would fight the user. This keeps "Arquitectura activa" live (which
    // providers are ready) as models get installed/authenticated. The
    // flow/config view is edit-only.
    if (view === "decision") renderModels().catch(() => {});
  }, AUTO_REFRESH_INTERVAL_MS);
}

// ---- live push (SSE) --------------------------------------------------------
// The 20s poll above is the resilience fallback; this makes the UI react the
// instant the backend publishes a change (a task delegated by an agent,
// config/architecture edited). One EventSource, dispatched to whichever view
// is active.
function initLiveEvents() {
  let es;
  try {
    es = new EventSource(apiUrl("/events"));
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
    } else if (ev.type === "layout_changed") {
      if (view === "decision") renderModels().catch(() => {});
      // Phase 4: keep Control Humano's dynamic roster (zones/figures) in sync with
      // routing-layout edits made ANYWHERE — another browser tab's Decisión edit,
      // or a Phase-3 drag-drop in another window — regardless of which view this
      // tab currently shows, so it's already correct the instant the user switches
      // to Control Humano. Unconditional (not gated by view, unlike renderModels()
      // above). loadRoutingLayout() is a plain GET + state assignment and
      // rebuildRoster() is deterministic/idempotent (Phase 1), so re-running both
      // for this tab's own echo of a change it just made itself (drag →
      // scheduleRoutingSave → PUT → backend re-publishes layout_changed to every
      // open tab, including the sender) is harmless — no extra network calls
      // beyond the one GET, no jitter (same entities/groups → same deterministic
      // layout), no feedback loop (loadRoutingLayout never PUTs).
      loadRoutingLayout()
        .then(() => {
          if (window.karajanCanvas && window.karajanCanvas.rebuildRoster) {
            try { window.karajanCanvas.rebuildRoster(); } catch (_) {}
          }
        })
        .catch(() => {});
    } else if (ev.type === "resource_refresh_progress") {
      if (view === "flow") refreshResourceRefreshSettings().catch(() => {});
    } else if (String(ev.type || "").startsWith("resource_")) {
      if (view === "resources") {
        refreshResources({ preserveSelection: true }).catch(() => {});
        if (String(ev.type).includes("discovery")) refreshResourceDiscovery({ preserveSource: true }).catch(() => {});
      }
    }
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
          action: "Ver Estadísticas",
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

export function renderNotifications() {
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

export function renderAgentNotifications() {
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

// ---- config plumbing -------------------------------------------------------
async function loadConfig() {
  state.config = await api("/config");
}

export async function putConfig(message) {
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
    if (tab) {
      if (tab.dataset.configTab === "inspiration" && state.configMode !== "traditional") setConfigMode("traditional");
      setConfigTab(tab.dataset.configTab);
    }
  });
  $("#toggleMonitorSide")?.addEventListener("click", () => setMonitorSide(!state.monitorSideOpen));
  $("#toggleHumanSide")?.addEventListener("click", () => setHumanSide(!state.humanSideOpen));
  $("#toggleAgentsSide")?.addEventListener("click", () => setAgentsSide(!state.agentsSideOpen));
  initMonitorSplitter();
  initMonitorSubnav();
  $("#skillsView")?.addEventListener("click", (event) => {
    const viewButton = event.target.closest("[data-skills-inventory-view]");
    if (viewButton) {
      state.skillInventoryView = viewButton.dataset.skillsInventoryView === "timeline" ? "timeline" : "table";
      localStorage.setItem("karajan-skill-inventory-view", state.skillInventoryView);
      renderSkillsAnalytics().catch(() => {});
      return;
    }
    const button = event.target.closest("[data-skills-period]");
    if (!button) return;
    state.skillAnalyticsDays = Number(button.dataset.skillsPeriod);
    renderSkillsAnalytics().catch(() => {});
  });
  initDataviz();
  initHumanSplitter();
  initAgentsSplitter();
  initMonitorBlocks();
  initTaskSearch();
  $("#modelsAdvanced").addEventListener("change", renderModels);
  $("#addHierarchyGroup")?.addEventListener("click", () => createGroup());
  initAutoRefresh();
  initLiveEvents();
  initResourceLibraryControls();
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
      const detail = $("#traditionalResourceDetailPanel") || $(".prompt-resource-detail-panel");
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
      // Control Humano roster is derived from state.entities/state.groups; rebuild
      // now that the routing layout has loaded so its figures reflect real data.
      if (window.karajanCanvas && window.karajanCanvas.rebuildRoster) {
        try { window.karajanCanvas.rebuildRoster(); } catch (_) {}
      }
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

export function openOpenClawPanel() {
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
