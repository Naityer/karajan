// Pestaña "Decisión" (`data-view="decision"`): diagrama, grupos de jerarquía y modelos.
//
// Extraído mecánicamente de app.js (nota "Plan de mejora", §18): mismo
// código, mismo comportamiento — solo cambia de dónde vienen sus nombres
// compartidos (antes globals de un único archivo, ahora imports explícitos).

import { $, $$, AGENT_CAPABILITY_DEFS, AGENT_INTERNAL_CAPABILITIES, DIAGRAM_BASE_HEIGHT, DIAGRAM_BASE_WIDTH, DIAGRAM_PAD_X, DIAGRAM_PAD_Y, GROUP_COLOR_PALETTE, LEVELS, LEVEL_FULL, OPENCLAW_NODE_ACCENT, OPENCLAW_POS_KEY, PRIMARY_ROLES, ROLE_DEFS, ROLE_GROUPS, SUPPORT_ROLES, TIER_LABEL, api, escapeHtml, nextGroupColor, prioChipLabel, readStoredOpenClawPos, safeColor, state, toast } from "./shared.js";
import { openOpenClawPanel, putConfig } from "./shell.js";

let routingSaveTimer = null;

let layoutSaveTimer = null;

let activeModelDrag = null;

let activeEntityMove = null;

let activeGroupMove = null;

let activeDiagramPan = null;

let wiresFrame = null;

export function scheduleRoutingSave(message = "Cambio detectado. Guardando enrutado…") {
  persistEntityState();
  toast(message, 1400);
  clearTimeout(routingSaveTimer);
  routingSaveTimer = setTimeout(() => saveRouting(true), 650);
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

function persistOpenClawPos() {
  localStorage.setItem(OPENCLAW_POS_KEY, JSON.stringify(state.openclawPos));
}

export async function loadRoutingLayout() {
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
      const localOpenClawPos = readStoredOpenClawPos();
      if (
        localOpenClawPos &&
        Number.isFinite(Number(localOpenClawPos.x)) &&
        Number.isFinite(Number(localOpenClawPos.y))
      ) {
        state.openclawPos = localOpenClawPos;
      } else if (
        layout.openclaw_pos &&
        Number.isFinite(Number(layout.openclaw_pos.x)) &&
        Number.isFinite(Number(layout.openclaw_pos.y))
      ) {
        state.openclawPos = {
          x: Number(layout.openclaw_pos.x),
          y: Number(layout.openclaw_pos.y),
        };
        persistOpenClawPos();
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

export function normalizeEntityPositions() {
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
  return [`<option value="">(sin asignar)</option>`]
    .concat(
      state.catalog.map(
        (p) => `<option value="${p.name}" ${p.name === current ? "selected" : ""}>${escapeHtml(p.label || p.name)}</option>`
      )
    )
    .join("");
}

export function renderDiagram() {
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

export function roleDef(role) {
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
  const options = [`<button class="entity-model-option ${!providerName ? "active" : ""}" data-entity="${entity.id}" data-provider="">(sin asignar)</button>`]
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

export function addEntityFromProvider(providerName, role = "child", position = null) {
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
  return Math.min(1.8, Math.max(0.2, value));
}

export function applyDiagramZoom() {
  const diagram = $("#diagram");
  const layer = $("#diagramLayer");
  if (!diagram || !layer) return;
  const zoom = state.diagramZoom;
  diagram.style.setProperty("--diagram-zoom", String(zoom));
  diagram.classList.toggle("zoom-loupe", zoom < 0.72);
  diagram.style.setProperty("--diagram-loupe", String(Math.min(1.85, Math.max(1.12, 0.9 / Math.max(zoom, 0.2))).toFixed(3)));
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

export function scheduleDrawWires() {
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
      pointerId: event.pointerId,
    };
    card.setPointerCapture?.(event.pointerId);
    card.classList.add("moving");
    document.body.classList.add("moving-node");
    setDiagramNodeDragging(true);
    document.addEventListener("pointermove", onOpenClawMove);
    document.addEventListener("pointerup", stopOpenClawMove, { once: true });
    document.addEventListener("pointercancel", stopOpenClawMove, { once: true });
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
  persistOpenClawPos();
}

function stopOpenClawMove() {
  const card = $("#openclawDiagramCard");
  if (card && activeOpenclawMove?.pointerId != null) {
    card.releasePointerCapture?.(activeOpenclawMove.pointerId);
  }
  card?.classList.remove("moving");
  activeOpenclawMove = null;
  document.body.classList.remove("moving-node");
  document.removeEventListener("pointermove", onOpenClawMove);
  document.removeEventListener("pointerup", stopOpenClawMove);
  document.removeEventListener("pointercancel", stopOpenClawMove);
  setDiagramNodeDragging(false);
  persistOpenClawPos();
  clearTimeout(layoutSaveTimer);
  saveRoutingLayout();
  toast("Posición de OpenClaw guardada.");
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

export function createGroup() {
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

export function addEntityToGroup(groupId, entityId) {
  const group = findGroup(groupId);
  const entity = findEntity(entityId);
  if (!group || !entity) return;
  entity.memberships = normalizeMemberships(entity.memberships);
  if (entity.memberships.some((m) => m.group_id === groupId)) return;
  entity.memberships.push({ group_id: groupId, prio: nextFreePrio(group) });
  renderDiagram();
  scheduleRoutingSave("Agente añadido a la jerarquía. Guardando…");
}

export function removeEntityFromGroup(groupId, entityId) {
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

export function initDiagramViewport() {
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

export function applyDrawerState() {
  document.documentElement.style.setProperty("--drawer-width", `${state.drawerWidth}px`);
  scheduleDrawWires();
}

export function initDrawerControls() {
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
export async function renderModels({ restoreSearchFocus = false } = {}) {
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
  const groupTitle = { cli: "Local / terminal", api: "Nube (API)" };

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

export function activeArchitectureProviderNames() {
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
