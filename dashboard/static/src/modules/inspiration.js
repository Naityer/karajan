// Pestaña "Inspiration" (`data-view="resources"`): biblioteca de recursos.
//
// Extraído mecánicamente de app.js (nota "Plan de mejora", §18): mismo
// código, mismo comportamiento — solo cambia de dónde vienen sus nombres
// compartidos (antes globals de un único archivo, ahora imports explícitos).

import { $, $$, api, apiUrl, entityLabel, escapeHtml, state, toast } from "./shared.js";

// ---- resource library -----------------------------------------------------
// The resource API is intentionally treated as a loose contract: early server
// versions returned arrays directly, while newer ones wrap them in `items`.
function resourceItems(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.items || payload?.resources || payload?.data || [];
}

function resourceId(item) {
  return String(item?.id ?? item?.resource_id ?? item?.slug ?? item?.name ?? item?.repo_url ?? "");
}

function resourceCardDomId(id) {
  return `resource-card-${String(id || "resource").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function resourceValues(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value && typeof value === "object") return Object.entries(value).filter(([, enabled]) => enabled).map(([name]) => name);
  return value ? [String(value)] : [];
}

function resourceAgents(item) {
  return resourceValues(item?.visible_agent_ids || item?.agent_ids || item?.visibility?.agent_ids || item?.agents || item?.visible_to);
}

function resourceRuntime(item) {
  return resourceValues(item?.compatible_runtimes || item?.runtime || item?.runtimes || item?.targets || item?.compatibility?.runtimes);
}

function safeExternalUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return ["https:", "http:"].includes(parsed.protocol) ? parsed.href : "";
  } catch (_) {
    return "";
  }
}

function resourceLabel(item) {
  return item?.display_name || item?.title || item?.name || item?.slug || "Recurso sin nombre";
}

function resourceSummary(item) {
  return item?.summary || item?.description || "";
}

function rebuildResourceIndex() {
  const byId = new Map();
  const childrenByParent = new Map();
  const searchTextById = new Map();
  (state.resources || []).forEach((item) => {
    const id = resourceId(item);
    byId.set(id, item);
    const parentId = String(item?.parent_resource_id || item?.parent_id || "");
    if (parentId) {
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(item);
    }
    searchTextById.set(id, [resourceLabel(item), resourceSummary(item), item.repo_url, item.source_url, item.source,
      ...resourceRuntime(item), ...resourceAgents(item), ...resourceValues(item.tags), ...resourceValues(item.capabilities)]
      .join(" ").toLocaleLowerCase("es"));
  });
  state.resourceIndex = { byId, childrenByParent, searchTextById, groupArtifacts: new Map() };
}

function resourceParent(item) {
  const parentId = String(item?.parent_resource_id || item?.parent_id || "");
  if (!parentId) return null;
  return state.resourceIndex?.byId?.get(parentId)
    || { id: parentId, name: item?.metadata?.parent_name || "Referencia padre" };
}

function resourceChildren(item) {
  if (Array.isArray(item?.children)) return item.children;
  const id = resourceId(item);
  return state.resourceIndex?.childrenByParent?.get(id) || [];
}

// Composite de la biblioteca: las colecciones de la API son planas, pero la
// interfaz trabaja con Artefacto -> Hijos. Un hijo nunca se convierte en una
// tarjeta de primer nivel; si coincide con una búsqueda, proyecta su padre.
function resourceArtifact(item) {
  if (!item) return null;
  const parentId = String(item?.parent_resource_id || item?.parent_id || "");
  if (!parentId) return item;
  return state.resourceIndex?.byId?.get(parentId) || null;
}

function resourceArtifactId(itemOrId) {
  const item = typeof itemOrId === "object"
    ? itemOrId
    : state.resourceIndex?.byId?.get(String(itemOrId || ""));
  return resourceId(resourceArtifact(item)) || resourceId(item) || String(itemOrId || "");
}

function resourceArtifacts(items = state.resources || []) {
  const artifacts = new Map();
  items.forEach((item) => {
    const artifact = resourceArtifact(item);
    const id = resourceId(artifact);
    if (id && !artifacts.has(id)) artifacts.set(id, artifact);
  });
  return [...artifacts.values()];
}

function filteredResourceArtifacts(options = {}) {
  return resourceArtifacts(filteredResources(options));
}

function resourceLineage(item) {
  const parent = resourceParent(item);
  const children = resourceChildren(item);
  return { parent, children, childCount: children.length, parentLabel: parent ? resourceLabel(parent) : "" };
}

function resourceSupportsNestedIndex(item) {
  if (item?.metadata?.nested_indexer || item?.metadata?.nested_resources) return true;
  const url = safeExternalUrl(item?.source_url || item?.repo_url || item?.url);
  try {
    return url ? /(^|\.)(itsfree\.dev|refactoring\.guru|toools\.design)$/i.test(new URL(url).hostname) : false;
  } catch (_) {
    return false;
  }
}

function resourceLineageMarkup(item, compact = false) {
  const { parent, childCount, parentLabel } = resourceLineage(item);
  const labels = [];
  if (childCount) labels.push(`<span class="insp-lineage-chip children" title="Esta referencia contiene elementos indexados">${childCount} ${childCount === 1 ? "elemento" : "elementos"}</span>`);
  if (parent) labels.push(`<span class="insp-lineage-chip parent" title="Elemento indexado dentro de ${escapeHtml(parentLabel)}">Parte de ${escapeHtml(parentLabel)}</span>`);
  if (!childCount && !parent && resourceSupportsNestedIndex(item)) labels.push(`<span class="insp-lineage-chip pending" title="Esta referencia puede indexarse para descubrir sus elementos">Contenido indexable</span>`);
  return labels.length ? `<span class="insp-lineage ${compact ? "compact" : ""}">${labels.join("")}</span>` : "";
}

function resourceStatus(item) {
  return String(item?.status || item?.installation_status || (item?.installed ? "installed" : "available")).toLowerCase();
}

function resourceStatusLabel(status) {
  return ({ installed: "Instalado", available: "Disponible", update_available: "Actualización", updating: "Actualizando", analyzing: "Analizando", error: "Error", disabled: "Desactivado" })[status] || status || "Desconocido";
}

function resourceTone(status) {
  if (["installed", "ready", "active", "ok", "succeeded", "verified"].includes(status)) return "ok";
  if (["error", "failed", "broken", "denied"].includes(status)) return "bad";
  if (["updating", "analyzing", "pending", "update_available"].includes(status)) return "warn";
  return "neutral";
}

function resourceFacet(item, key) {
  if (key === "kind") return resourceValues(item.kind || item.type || item.resource_kind);
  if (key === "status") return [resourceStatus(item)];
  if (key === "runtime") return resourceRuntime(item);
  if (key === "agent") return resourceAgents(item);
  if (key === "source") return resourceValues(item.source || item.provider || (item.repo_url ? "github" : "local"));
  if (key === "structure") {
    const parentId = String(item?.parent_resource_id || item?.parent_id || "");
    if (parentId) return ["component"];
    if (item?.metadata?.source_role === "collection" || resourceSupportsNestedIndex(item)) return ["gallery"];
    if (resourceChildren(item).length) return ["composite"];
    return ["standalone"];
  }
  return [];
}

function filteredResources(options = {}) {
 const f = state.resourceFilters;
  const query = options.ignoreQuery ? "" : f.query.trim().toLowerCase();
  return (state.resources || []).filter((item) => {
    const haystack = state.resourceIndex?.searchTextById?.get(resourceId(item)) || "";
    if (query && !haystack.includes(query)) return false;
    if (state.resourceGroupFilter) {
      if (!resourceArtifactIdsForGroup(state.resourceGroupFilter).has(resourceArtifactId(item))) return false;
    }
    return ["kind", "status", "runtime", "agent", "source", "structure"].every((key) => !f[key] || resourceFacet(item, key).map((v) => v.toLowerCase()).includes(f[key].toLowerCase()));
  });
}

function resourceFacetLabel(key, value) {
  const raw = String(value || "");
  const normalized = raw.toLowerCase();
  if (key === "kind") return ({ skill: "Skill", capability: "Habilidad", reference: "Referencia" })[normalized] || raw;
  if (key === "status") return resourceStatusLabel(normalized);
  if (key === "structure") return ({ gallery: "Galería indexable", composite: "Con elementos", standalone: "Individual", component: "Componente" })[normalized] || raw;
  if (key === "runtime") return ({ claude: "Claude", codex: "Codex" })[normalized] || raw;
  if (key === "agent") return entityLabel(raw);
  if (key === "source") return ({ github: "GitHub", local: "Local", naityer: "Naityer" })[normalized] || raw;
  return raw;
}

function fillResourceFilter(id, key, label) {
  const select = $(id);
  if (!select) return;
  const current = state.resourceFilters[key];
  const counts = new Map();
  resourceArtifacts().forEach((item) => {
    const values = [...new Set(resourceFacet(item, key).filter(Boolean))];
    values.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  });
  const values = [...counts.keys()]
    .sort((a, b) => resourceFacetLabel(key, a).localeCompare(resourceFacetLabel(key, b), "es"));
  select.innerHTML = `<option value="">${label}</option>${values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(resourceFacetLabel(key, value))} (${counts.get(value)})</option>`).join("")}`;
  select.value = values.includes(current) ? current : "";
  if (!select.value) state.resourceFilters[key] = "";
}

function renderResourceFilters() {
  fillResourceFilter("#resourceKindFilter", "kind", "Todos los tipos");
  fillResourceFilter("#resourceStatusFilter", "status", "Todos los estados");
  fillResourceFilter("#resourceRuntimeFilter", "runtime", "Todos los runtimes");
  fillResourceFilter("#resourceAgentFilter", "agent", "Todos los agentes");
  fillResourceFilter("#resourceSourceFilter", "source", "Todos los orígenes");
  fillResourceFilter("#resourceStructureFilter", "structure", "Todos los contenidos");
}

// Estado como píldora tintada: color + glifo + texto, nunca sólo color.
function resourceStatusPill(status) {
  return `<span class="insp-pill tone-${resourceTone(status)}"><i></i>${escapeHtml(resourceStatusLabel(status))}</span>`;
}

function renderResourceKpis() {
  const target = $("#resourceKpis");
  if (!target) return;
  const all = resourceArtifacts();
  const available = all.filter((item) => resourceStatus(item) === "available").length;
  const installed = all.filter((item) => resourceStatus(item) === "installed").length;
  const galleries = all.filter((item) => resourceArtifactRole(item) === "Galería indexable").length;
  const signals = (state.resourceDiscoveryFeed || []).length;
  const components = (state.resources || []).filter((item) => item?.parent_resource_id || item?.parent_id).length;
  target.innerHTML = `<span><b>${all.length}</b> artefactos</span><span><b>${components}</b> componentes</span><span><b>${installed}</b> instalados</span><span><b>${available}</b> disponibles</span><span><b>${galleries}</b> galerías</span><span><b>${signals}</b> señales</span>`;
}

function resourceArtifactRole(item) {
  if (resourceLineage(item).parent) return "Componente";
  if (item?.metadata?.source_role === "collection" || resourceSupportsNestedIndex(item)) return "Galería indexable";
  return "Artefacto";
}

function inspirationResourceCard(item) {
  const id = resourceId(item);
  const status = resourceStatus(item);
  const runtime = resourceRuntime(item);
  const agents = resourceAgents(item);
  const kind = resourceFacet(item, "kind")[0] || "resource";
  const selected = state.resourceInspectorOpen && id === state.selectedResourceId;
  const runtimeTags = runtime.slice(0, 2).map((name) => `<em class="insp-tag">${escapeHtml(name)}</em>`).join("")
    || `<em class="insp-tag">agnóstico</em>`;
  return `<button type="button" id="${resourceCardDomId(id)}" class="insp-card${selected ? " selected" : ""}" data-resource-id="${escapeHtml(id)}" aria-controls="resourceInspector" aria-expanded="${selected}">
    <span class="insp-card-top"><span class="insp-card-kind">${escapeHtml(kind.slice(0, 2).toUpperCase())}</span><span class="insp-artifact-role">${escapeHtml(resourceArtifactRole(item))}</span>${resourceStatusPill(status)}</span>
    <span class="insp-card-copy"><b>${escapeHtml(resourceLabel(item))}</b><small>${escapeHtml(resourceSummary(item) || item.repo_url || "Sin descripción")}</small></span>
    ${resourceLineageMarkup(item)}
    <span class="insp-card-foot"><span class="insp-runtimes">${runtimeTags}</span><small>${agents.length ? `${agents.length} agente${agents.length === 1 ? "" : "s"}` : "Visibilidad global"}</small></span>
  </button>`;
}

function resourceTreeItem(item) {
  const id = resourceId(item);
  const kind = resourceFacet(item, "kind")[0] || "resource";
  const status = resourceStatus(item);
  const selected = state.resourceInspectorOpen && id === state.selectedResourceId;
  const childCount = resourceLineage(item).childCount;
  const childLabel = `${childCount} ${childCount === 1 ? "elemento" : "elementos"}`;
  return `<button type="button" id="${resourceCardDomId(id)}" class="insp-tree-resource${selected ? " selected" : ""}" data-resource-id="${escapeHtml(id)}" role="treeitem" aria-controls="resourceInspector" aria-expanded="${selected}" title="${escapeHtml(resourceSummary(item) || resourceLabel(item))}">
    <span class="insp-tree-kind" aria-hidden="true">${escapeHtml(kind.slice(0, 2).toUpperCase())}</span>
    <span class="insp-tree-resource-copy"><span class="insp-tree-resource-primary"><b>${escapeHtml(resourceLabel(item))}</b><span class="insp-tree-element-count">${escapeHtml(childLabel)}</span></span><span class="insp-tree-resource-secondary"><span class="insp-tree-role">${escapeHtml(resourceArtifactRole(item))}</span>${resourceStatusPill(status)}</span></span>
  </button>`;
}

function resourceArtifactGroupId(itemOrId) {
  const artifactId = resourceArtifactId(itemOrId);
  const groups = orderedResourceGroups();
  const direct = groups.find((group) => resourceValues(group.resource_ids).includes(artifactId));
  if (direct) return String(direct.id);
  const inherited = groups.find((group) => resourceValues(group.resource_ids).some((id) => resourceArtifactId(id) === artifactId));
  return inherited ? String(inherited.id) : "";
}

function directResourceIdsForTree(group) {
  const descendantIds = new Set(groupDescendants(group.id).flatMap((child) => resourceIdsForGroup(child.id)).map(resourceArtifactId));
  return [...new Set(resourceValues(group.resource_ids).map(resourceArtifactId))]
    .filter((id) => resourceArtifactGroupId(id) === String(group.id) && !descendantIds.has(id));
}

function resourceTreeGroup(group, itemById, visibleIds, depth = 0) {
  const children = groupDescendants(group.id)
    .map((child) => resourceTreeGroup(child, itemById, visibleIds, depth + 1))
    .filter(Boolean);
  const resources = directResourceIdsForTree(group)
    .filter((id) => visibleIds.has(id) && itemById.has(id))
    .map((id) => itemById.get(id))
    .sort((a, b) => resourceLabel(a).localeCompare(resourceLabel(b), "es"));
  if (!resources.length && !children.length) return "";
  const familyCount = new Set(resourceIdsForGroup(group.id).map(resourceArtifactId).filter((id) => visibleIds.has(id))).size;
  return `<section class="insp-tree-family depth-${Math.min(depth, 4)}" data-tree-group="${escapeHtml(group.id)}" role="group" aria-label="${escapeHtml(group.name)}">
    <header class="insp-tree-family-head" role="treeitem" aria-expanded="true">
      <span class="insp-tree-branch" aria-hidden="true"></span>
      <span><b>${escapeHtml(group.name)}</b><small>${escapeHtml(group.description || (depth ? "Subgrupo" : "Familia de recursos"))}</small></span>
      <em>${familyCount}</em>
    </header>
    <div class="insp-tree-family-content">${children.join("")}${resources.map(resourceTreeItem).join("")}</div>
  </section>`;
}

function renderResourceGallery(target, items) {
  const visibleIds = new Set(items.map(resourceId));
  const groups = orderedResourceGroups().map((group) => ({
    ...group,
    label: group.name,
    items: items.filter((item) => visibleIds.has(resourceId(item)) && resourceArtifactGroupId(item) === String(group.id)),
    depth: resourceGroupDepth(group),
  }));
  const assignedIds = new Set(items.filter((item) => resourceArtifactGroupId(item)).map(resourceId));
  const unclassified = items.filter((item) => !assignedIds.has(resourceId(item)));
  if (unclassified.length) groups.push({ id: "unclassified", label: "Sin clasificar", description: "Recursos pendientes de organizar", items: unclassified, depth: 0 });
  target.className = "insp-groups";
  target.removeAttribute("role");
  target.innerHTML = groups.filter((group) => group.items.length).map((group) => `<section class="insp-group" data-resource-group="${escapeHtml(group.id)}" style="--group-depth:${group.depth || 0}">
    <div class="insp-group-head"><h2>${escapeHtml(group.label)}</h2><span class="insp-group-count">${group.items.length}</span><p>${escapeHtml(group.description || "Grupo del catálogo")}</p></div>
    <div class="insp-card-grid">${group.items.map(inspirationResourceCard).join("")}</div>
  </section>`).join("");
}

function renderResourceListView(target, items) {
  const visibleIds = new Set(items.map(resourceId));
  const itemById = new Map(items.map((item) => [resourceId(item), item]));
  const roots = groupDescendants("");
  const rootIds = new Set(roots.map((group) => String(group.id)));
  const displayGroups = catalogResourceGroups();
  const orphanRoots = displayGroups.filter((group) => group.parent_id && !displayGroups.some((candidate) => String(candidate.id) === String(group.parent_id)) && !rootIds.has(String(group.id)));
  const assignedIds = new Set(items.filter((item) => resourceArtifactGroupId(item)).map(resourceId));
  const unclassified = items.filter((item) => !assignedIds.has(resourceId(item)));
  const families = [...roots, ...orphanRoots]
    .map((group) => resourceTreeGroup(group, itemById, visibleIds))
    .filter(Boolean);
  if (unclassified.length) {
    families.push(`<section class="insp-tree-family" role="group" aria-label="Sin clasificar"><header class="insp-tree-family-head" role="treeitem" aria-expanded="true"><span class="insp-tree-branch" aria-hidden="true"></span><span><b>Sin clasificar</b><small>Recursos pendientes de organizar</small></span><em>${unclassified.length}</em></header><div class="insp-tree-family-content">${unclassified.sort((a, b) => resourceLabel(a).localeCompare(resourceLabel(b), "es")).map(resourceTreeItem).join("")}</div></section>`);
  }
  target.className = "insp-resource-tree";
  target.setAttribute("role", "tree");
  target.setAttribute("aria-label", "Familias y recursos del catálogo");
  target.innerHTML = families.join("");
}

function constellationInitials(label) {
  return String(label || "").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "R";
}

function constellationTone(rootId) {
  return ({
    rgrp_domain_development: "green",
    rgrp_domain_design: "violet",
    rgrp_domain_agents: "amber",
    rgrp_domain_quality: "red",
    rgrp_domain_knowledge: "blue",
  })[rootId] || "amber";
}

/* ---- Geometría del árbol ---------------------------------------------------
   El layout anterior repartía los subgrupos sobre un ancho de familia fijo
   (mínimo 1120px) y forzaba el lienzo a 2800x1500 como mínimo, así que los
   nodos quedaban a cientos de píxeles de sus hijos, el bus horizontal cruzaba
   media pantalla y sobraba más de la mitad del alto. Aquí se mide de abajo
   arriba (Reingold-Tilford simplificado): cada subárbol declara el ancho que
   necesita, los hermanos se empaquetan uno junto a otro y el padre se centra
   sobre sus hijos. El lienzo acaba midiendo exactamente lo que ocupa el
   contenido. */
// Los recursos de un grupo van SIEMPRE en una sola fila. Repartirlos en varias
// obligaba a colgar los de la segunda fila del recurso que tenían encima, lo
// que dibujaba una jerarquía que no existe: son todos hermanos. El grupo más
// poblado del catálogo tiene 7 recursos, así que la fila no se dispara.
const TREE_LEAF_W = 118;        // hueco horizontal por recurso hoja

const TREE_LEVEL_H = 156;       // separación vertical entre niveles

const TREE_SIBLING_GAP = 30;    // aire entre subárboles hermanos

const TREE_FOREST_GAP = 132;    // aire entre dominios raíz

const TREE_ROOT_MIN_W = 236;

const TREE_GROUP_MIN_W = 184;

const TREE_PAD_X = 80;

const TREE_PAD_TOP = 88;

const TREE_PAD_BOTTOM = 96;

// Alto aproximado de cada nodo (círculo + etiqueta). Se usa para que las
// aristas arranquen por debajo del texto y terminen por encima del círculo
// siguiente, en vez de atravesarlos.
const TREE_BOX = { root: 112, group: 84, resource: 68 };

function treeTopAnchor(y, kind) { return Math.round(y - TREE_BOX[kind] / 2 - 8); }

function treeBottomAnchor(y, kind) { return Math.round(y + TREE_BOX[kind] / 2 + 8); }

// Conector ortogonal: baja del padre, cruza en horizontal a mitad de camino y
// entra vertical en el hijo. Es lo que hace que se lea como un árbol y no como
// un haz de diagonales.
function treeElbow(from, to, tone) {
  const midY = Math.round((from.y + to.y) / 2);
  const d = from.x === to.x
    ? `M ${from.x} ${from.y} V ${to.y}`
    : `M ${from.x} ${from.y} V ${midY} H ${to.x} V ${to.y}`;
  return `<path class="insp-constellation-edge tone-${tone}" d="${d}"></path>`;
}

function constellationResourceNode(item, point, tone) {
  const id = resourceId(item);
  const installed = resourceStatus(item) === "installed";
  const label = resourceLabel(item);
  return `<button type="button" class="insp-constellation-node resource tone-${tone}${installed ? " installed" : ""}" style="--node-x:${point.x}px;--node-y:${point.y}px" data-resource-id="${escapeHtml(id)}" aria-controls="resourceInspector" title="${escapeHtml(resourceSummary(item) || label)}">
    <span class="insp-constellation-core" aria-hidden="true">${escapeHtml(constellationInitials(label))}</span>
    <span class="insp-constellation-label"><b>${escapeHtml(label)}</b><small>${installed ? "Instalado" : "Disponible"}</small></span>
  </button>`;
}

function renderResourceTreeNavigation(roots) {
  const nav = $("#resourceTreeNav");
  if (!nav) return;
  const visible = state.resourceDisplayMode === "tree" && roots.length > 0;
  nav.hidden = !visible;
  if (!visible) {
    nav.innerHTML = "";
    return;
  }
  nav.innerHTML = roots.map((root) => `<button type="button" class="insp-tree-nav-pill${state.resourceTreeFocusId === root.id ? " active" : ""}" data-resource-tree-focus="${escapeHtml(root.id)}" aria-pressed="${state.resourceTreeFocusId === root.id}">${escapeHtml(root.name)}</button>`).join("");
}

function focusResourceTree(rootId) {
  const resourceList = $("#resourceList");
  if (!resourceList || state.resourceDisplayMode !== "tree") return;
  state.resourceTreeFocusId = String(rootId || "");
  $$('[data-resource-tree-focus]', $("#resourceTreeNav")).forEach((button) => {
    const active = button.dataset.resourceTreeFocus === state.resourceTreeFocusId;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const node = resourceList.querySelector(`[data-resource-tree-root="${CSS.escape(state.resourceTreeFocusId)}"]`);
  if (!node) return;
  // El nodo se posiciona con translate(-50%, -50%), así que offsetLeft/Top ya
  // son su centro: sumarles media caja lo descentraba al hacer scroll.
  const left = Math.max(0, node.offsetLeft - resourceList.clientWidth / 2);
  const top = Math.max(0, node.offsetTop - resourceList.clientHeight / 3);
  resourceList.scrollTo({ left, top, behavior: "smooth" });
}

function focusResourceSearchTarget() {
  const resourceList = $("#resourceList");
  const query = String((state.resourceFilters && state.resourceFilters.query) || "").trim();
  if (!resourceList || state.resourceDisplayMode !== "tree" || !query) return;
  const match = filteredResources()[0];
  const id = match && resourceId(match);
  if (!id) return;
  const selector = "[data-resource-id=\"" + CSS.escape(String(id)) + "\"]";
  const node = resourceList.querySelector(selector);
  if (!node) return;
  const x = Number.parseFloat(node.style.getPropertyValue("--node-x"));
  const y = Number.parseFloat(node.style.getPropertyValue("--node-y"));
  const centerX = Number.isFinite(x) ? x : node.offsetLeft;
  const centerY = Number.isFinite(y) ? y : node.offsetTop;
  const maxLeft = Math.max(0, resourceList.scrollWidth - resourceList.clientWidth);
  const maxTop = Math.max(0, resourceList.scrollHeight - resourceList.clientHeight);
  const left = Math.max(0, Math.min(maxLeft, centerX - resourceList.clientWidth / 2));
  const top = Math.max(0, Math.min(maxTop, centerY - resourceList.clientHeight / 2));
  resourceList.scrollTo({ left, top, behavior: "smooth" });
  node.classList.add("search-focus");
  window.clearTimeout(state.resourceSearchFocusTimer);
  state.resourceSearchFocusTimer = window.setTimeout(() => node.classList.remove("search-focus"), 1400);
}

function resourceArtifactFamily(item) {
  const id = resourceId(item);
  return groupDescendants("").find((group) => resourceArtifactIdsForGroup(group.id).has(id)) || null;
}

function resourceArtifactGroup(item, family = resourceArtifactFamily(item)) {
  const id = resourceId(item);
  if (!family) return null;
  return orderedResourceGroups(family.id).find((group) => resourceValues(group.resource_ids).includes(id)) || null;
}

// Bosque Composite: Familia -> Grupo funcional -> Artefacto -> Hijos.
function buildCompositeTree(items) {
  const families = new Map();
  resourceArtifacts(items).forEach((artifact) => {
    const family = resourceArtifactFamily(artifact);
    const familyId = String(family?.id || "unclassified");
    if (!families.has(familyId)) families.set(familyId, { id: familyId, name: family?.name || "Sin clasificar", description: family?.description || "Artefactos pendientes de clasificación", tone: constellationTone(familyId), groups: new Map() });
    const familyBranch = families.get(familyId);
    const group = resourceArtifactGroup(artifact, family);
    const groupId = String(group?.id || `${familyId}--other`);
    if (!familyBranch.groups.has(groupId)) familyBranch.groups.set(groupId, { id: groupId, name: group?.name || "Otros artefactos", description: group?.description || "Sin subgrupo funcional", artifacts: [] });
    const children = resourceChildren(artifact).sort((a, b) => resourceLabel(a).localeCompare(resourceLabel(b), "es"));
    familyBranch.groups.get(groupId).artifacts.push({
      artifact,
      children,
      width: Math.max(TREE_GROUP_MIN_W, children.length * TREE_LEAF_W),
    });
  });
  const rootOrder = groupDescendants("").map((group) => String(group.id));
  return [...families.values()].map((family) => {
    family.groups = [...family.groups.values()].map((group) => {
      group.artifacts.sort((a, b) => resourceLabel(a.artifact).localeCompare(resourceLabel(b.artifact), "es"));
      group.width = Math.max(TREE_ROOT_MIN_W, group.artifacts.reduce((sum, artifact) => sum + artifact.width, 0) + Math.max(0, group.artifacts.length - 1) * TREE_SIBLING_GAP);
      return group;
    });
    family.width = Math.max(TREE_ROOT_MIN_W, family.groups.reduce((sum, group) => sum + group.width, 0) + Math.max(0, family.groups.length - 1) * TREE_FOREST_GAP);
    return family;
  }).sort((a, b) => {
    const left = rootOrder.indexOf(a.id);
    const right = rootOrder.indexOf(b.id);
    return (left < 0 ? 999 : left) - (right < 0 ? 999 : right) || a.name.localeCompare(b.name, "es");
  });
}

function renderResourceSkillTree(target, items) {
  const treeZoom = Math.min(1.8, Math.max(0.65, Number(target.dataset.treeZoom || "1")));
  target.dataset.treeZoom = String(treeZoom);
  const families = buildCompositeTree(items);
  const edges = [];
  const nodes = [];
  const familyRoots = [];
  const familyY = TREE_PAD_TOP;
  const groupY = familyY + TREE_LEVEL_H;
  const artifactY = groupY + TREE_LEVEL_H;
  const childY = artifactY + TREE_LEVEL_H;
  let cursorX = TREE_PAD_X;

  families.forEach((family) => {
    const familyLeft = cursorX;
    family.x = Math.round(familyLeft + family.width / 2);
    familyRoots.push({ id: family.id, name: family.name });
    nodes.push(`<div class="insp-constellation-node root family-root tone-${family.tone}" data-resource-tree-root="${escapeHtml(family.id)}" style="--node-x:${family.x}px;--node-y:${familyY}px" aria-label="${escapeHtml(family.name)}"><span class="insp-constellation-core" aria-hidden="true">${escapeHtml(constellationInitials(family.name))}</span><span class="insp-constellation-label"><b>${escapeHtml(family.name)}</b><small>${family.groups.reduce((sum, group) => sum + group.artifacts.length, 0)} artefactos</small></span></div>`);
    let groupCursor = familyLeft;
    family.groups.forEach((group) => {
      group.x = Math.round(groupCursor + group.width / 2);
      edges.push(treeElbow({ x: family.x, y: treeBottomAnchor(familyY, "root") }, { x: group.x, y: treeTopAnchor(groupY, "group") }, family.tone));
      nodes.push(`<div class="insp-constellation-node subgroup classification tone-${family.tone}" style="--node-x:${group.x}px;--node-y:${groupY}px" title="${escapeHtml(group.description)}"><span class="insp-constellation-core" aria-hidden="true">${group.artifacts.length}</span><span class="insp-constellation-label"><b>${escapeHtml(group.name)}</b><small>${group.artifacts.length} artefactos</small></span></div>`);
      let artifactCursor = groupCursor;
      group.artifacts.forEach((branch) => {
        branch.x = Math.round(artifactCursor + branch.width / 2);
        const artifact = branch.artifact;
        const artifactId = resourceId(artifact);
        edges.push(treeElbow({ x: group.x, y: treeBottomAnchor(groupY, "group") }, { x: branch.x, y: treeTopAnchor(artifactY, "group") }, family.tone));
        nodes.push(`<button type="button" class="insp-constellation-node subgroup artifact tone-${family.tone}" style="--node-x:${branch.x}px;--node-y:${artifactY}px" data-resource-id="${escapeHtml(artifactId)}" aria-controls="resourceInspector" title="${escapeHtml(resourceSummary(artifact) || resourceLabel(artifact))}"><span class="insp-constellation-core" aria-hidden="true">${escapeHtml(constellationInitials(resourceLabel(artifact)))}</span><span class="insp-constellation-label"><b>${escapeHtml(resourceLabel(artifact))}</b><small>Artefacto · ${branch.children.length} ${branch.children.length === 1 ? "componente" : "componentes"}</small></span></button>`);
        const leafLeft = branch.x - (branch.children.length * TREE_LEAF_W) / 2;
        branch.children.forEach((child, index) => {
          const x = Math.round(leafLeft + TREE_LEAF_W / 2 + index * TREE_LEAF_W);
          edges.push(treeElbow({ x: branch.x, y: treeBottomAnchor(artifactY, "group") }, { x, y: treeTopAnchor(childY, "resource") }, family.tone));
          nodes.push(constellationResourceNode(child, { x, y: childY }, family.tone));
        });
        artifactCursor += branch.width + TREE_SIBLING_GAP;
      });
      groupCursor += group.width + TREE_FOREST_GAP;
    });
    cursorX += family.width + TREE_FOREST_GAP;
  });

  const treeWidth = Math.max(TREE_ROOT_MIN_W, cursorX - TREE_FOREST_GAP + TREE_PAD_X);
  target.className = "insp-skill-tree";
  target.removeAttribute("role");
  target.setAttribute("aria-label", "Bosque de familias, grupos funcionales, artefactos y componentes");
  renderResourceTreeNavigation(familyRoots);
  if (!families.length) {
    target.innerHTML = `<div class="insp-empty"><b>Sin árbol que mostrar</b><span>Ningún artefacto coincide con los filtros activos.</span></div>`;
    return;
  }
  const canvasWidth = Math.round(treeWidth + TREE_PAD_X * 2);
  const canvasHeight = Math.round(childY + TREE_BOX.resource / 2 + TREE_PAD_BOTTOM);
  target.innerHTML = `<div class="insp-constellation-canvas composite-tree" style="width:${canvasWidth}px;height:${canvasHeight}px"><svg class="insp-constellation-lines" viewBox="0 0 ${canvasWidth} ${canvasHeight}" aria-hidden="true">${edges.join("")}</svg>${nodes.join("")}</div>`;
  const canvas = target.querySelector(".insp-constellation-canvas");
  if (canvas && treeZoom !== 1) canvas.style.zoom = String(treeZoom);
}

function setResourceDisplayMode(mode) {
  state.resourceDisplayMode = ["gallery", "list", "tree"].includes(mode) ? mode : "gallery";
  localStorage.setItem("karajan-inspiration-display-v2", state.resourceDisplayMode);
  renderResourceList();
  if (["list", "tree"].includes(state.resourceDisplayMode)) {
    requestAnimationFrame(() => {
      const resourceList = $("#resourceList");
      if (resourceList?.classList.contains("insp-resource-tree") || resourceList?.classList.contains("insp-skill-tree")) {
        resourceList.scrollLeft = state.resourceDisplayMode === "tree" ? 80 : 0;
        resourceList.scrollTop = state.resourceDisplayMode === "tree" ? 90 : 0;
      }
    });
  }
}

function renderResourceList() {
  const target = $("#resourceList");
  if (!target) return;
  const resourcesView = $("#view-resources");
  resourcesView?.classList.toggle("resource-mode-tree", state.resourceDisplayMode === "tree");
  resourcesView?.classList.toggle("resource-mode-scroll", state.resourceDisplayMode !== "tree");
  const items = filteredResourceArtifacts();
  const total = resourceArtifacts().length;
  const componentTotal = (state.resources || []).filter((item) => item?.parent_resource_id || item?.parent_id).length;
  $("#resourceResultCount").textContent = `${items.length} ${items.length === 1 ? "artefacto" : "artefactos"}`;
  const filterState = $("#resourceFilterState");
  if (filterState) {
    const active = ["kind", "status", "runtime", "agent", "source", "structure"].filter((key) => state.resourceFilters[key]).length
      + (state.resourceFilters.query.trim() ? 1 : 0) + (state.resourceGroupFilter ? 1 : 0);
    filterState.textContent = active
      ? `${active} ${active === 1 ? "filtro activo" : "filtros activos"} · ${total} en total`
      : `${total} artefactos · ${componentTotal} componentes`;
  }
  $$("[data-resource-display]", $("#resourceDisplaySwitch")).forEach((button) => {
    const active = button.dataset.resourceDisplay === state.resourceDisplayMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (state.resourceDisplayMode !== "tree") renderResourceTreeNavigation([]);
  if (!items.length) {
    renderResourceTreeNavigation([]);
    target.className = "insp-groups";
    target.removeAttribute("role");
    target.innerHTML = `<div class="insp-empty"><b>No hay coincidencias</b><span>Prueba otros filtros o añade un repositorio de GitHub al catálogo.</span><button type="button" class="ghost-btn" data-resource-open-wizard>Añadir recurso</button></div>`;
    return;
  }
  if (state.resourceDisplayMode === "list") renderResourceListView(target, items);
  else if (state.resourceDisplayMode === "tree") {
    const treeItems = state.resourceFilters.query.trim() ? filteredResourceArtifacts({ ignoreQuery: true }) : items;
    renderResourceSkillTree(target, treeItems);
    requestAnimationFrame(() => focusResourceSearchTarget());
  }
  else renderResourceGallery(target, items);
}

function resourceGroupItems(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.groups || payload?.items || payload?.data || [];
}

const RESOURCE_DOMAIN_ROOTS = [
  ["rgrp_domain_development", "Desarrollo de software", "Construir, mantener y operar productos", 0],
  ["rgrp_domain_design", "Diseño de producto", "Diseñar interfaces y explorar referencias visuales", 10],
  ["rgrp_domain_agents", "Agentes y automatización", "Crear, orquestar y extender sistemas de agentes", 20],
  ["rgrp_domain_quality", "Calidad y seguridad", "Verificar comportamiento, riesgo y robustez", 30],
  ["rgrp_domain_knowledge", "Conocimiento y contenidos", "Procesar documentos, datos e investigación", 40],
];

function resourceDecisionTaxonomy(item) {
  return item?.metadata?.decision_taxonomy || null;
}

function buildResourceGroupView(groups) {
  const view = groups.map((group) => ({ ...group, resource_ids: [...resourceValues(group.resource_ids)] }));
  const legacyRootIds = new Set(["rgrp_skills", "rgrp_capabilities", "rgrp_references"]);
  const taxonomyItems = resourceArtifacts().filter((item) => resourceDecisionTaxonomy(item));
  if (!taxonomyItems.length) return projectResourceGroupsToArtifacts(view);
  const custom = view.filter((group) => !legacyRootIds.has(String(group.id)) && !String(group.description || "").startsWith("Clasificación editorial:"));
  const rebuilt = [...custom];
  RESOURCE_DOMAIN_ROOTS.forEach(([id, name, description, sortOrder]) => {
    if (!rebuilt.some((group) => String(group.id) === id)) rebuilt.push({ id, name, description, parent_id: null, sort_order: sortOrder, resource_ids: [], fallback: true });
  });
  taxonomyItems.forEach((item) => {
    const id = resourceId(item);
    const taxonomy = resourceDecisionTaxonomy(item);
    if (!id || !taxonomy?.family_id || !taxonomy?.group_id) return;
    const manuallyOwned = custom.some((group) => resourceValues(group.resource_ids).includes(id));
    if (manuallyOwned) return;
    let taxonomyGroup = rebuilt.find((group) => String(group.id) === String(taxonomy.group_id));
    if (!taxonomyGroup) {
      taxonomyGroup = {
        id: taxonomy.group_id,
        name: taxonomy.group,
        description: "Clasificación orientada a la tarea",
        parent_id: taxonomy.family_id,
        sort_order: 0,
        resource_ids: [],
        fallback: true,
      };
      rebuilt.push(taxonomyGroup);
    }
    if (!taxonomyGroup.resource_ids.includes(id)) taxonomyGroup.resource_ids.push(id);
  });
  return projectResourceGroupsToArtifacts(rebuilt);
}

function projectResourceGroupsToArtifacts(groups) {
  const artifactIds = new Set(resourceArtifacts().map(resourceId));
  const owners = new Map();
  groups.forEach((group, groupIndex) => {
    let depth = 0;
    let parentId = String(group.parent_id || "");
    const seen = new Set();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = groups.find((candidate) => String(candidate.id) === parentId);
      if (!parent) break;
      depth += 1;
      parentId = String(parent.parent_id || "");
    }
    resourceValues(group.resource_ids).forEach((rawId) => {
      const artifactId = resourceArtifactId(rawId);
      if (!artifactIds.has(artifactId)) return;
      const candidate = { groupId: String(group.id), direct: String(rawId) === artifactId, depth, groupIndex };
      const current = owners.get(artifactId);
      if (!current || Number(candidate.direct) > Number(current.direct) || (candidate.direct === current.direct && candidate.depth > current.depth) || (candidate.direct === current.direct && candidate.depth === current.depth && candidate.groupIndex < current.groupIndex)) owners.set(artifactId, candidate);
    });
  });
  return groups.map((group) => ({ ...group, resource_ids: [...owners.entries()].filter(([, owner]) => owner.groupId === String(group.id)).map(([artifactId]) => artifactId) }));
}

function catalogResourceGroups() {
  return state.resourceGroupView.length ? state.resourceGroupView : state.resourceGroups;
}

function fallbackResourceGroups() {
  return buildResourceGroupView([]);
}

function groupDescendants(parentId) {
  return catalogResourceGroups().filter((group) => String(group.parent_id || "") === String(parentId || "")).sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
}

function orderedResourceGroups(parentId = "", visited = new Set()) {
  const ordered = [];
  groupDescendants(parentId).forEach((group) => {
    const id = String(group.id);
    if (visited.has(id)) return;
    visited.add(id);
    ordered.push(group, ...orderedResourceGroups(id, visited));
  });
  if (!parentId) {
    catalogResourceGroups().forEach((group) => {
      if (!visited.has(String(group.id))) ordered.push(group);
    });
  }
  return ordered;
}

function resourceGroupDepth(group) {
  let depth = 0;
  let parentId = String(group?.parent_id || "");
  const visited = new Set();
  while (parentId && !visited.has(parentId) && depth < 4) {
    visited.add(parentId);
    const parent = catalogResourceGroups().find((entry) => String(entry.id) === parentId);
    if (!parent) break;
    depth += 1;
    parentId = String(parent.parent_id || "");
  }
  return depth;
}

function resourceIdsForGroup(groupId) {
  const group = catalogResourceGroups().find((entry) => String(entry.id) === String(groupId));
  if (!group) return [];
  return [...new Set(resourceValues(group.resource_ids).concat(groupDescendants(group.id).flatMap((child) => resourceIdsForGroup(child.id))))];
}

function isResourceGroupDescendant(groupId, parentId) {
  let group = state.resourceGroups.find((entry) => String(entry.id) === String(groupId));
  const visited = new Set();
  while (group?.parent_id && !visited.has(String(group.parent_id))) {
    const currentParent = String(group.parent_id);
    if (currentParent === String(parentId)) return true;
    visited.add(currentParent);
    group = state.resourceGroups.find((entry) => String(entry.id) === currentParent);
  }
  return false;
}

function resourceGroupBranch(group, depth = 0) {
  const children = groupDescendants(group.id).filter((child) => resourceArtifactIdsForGroup(child.id).size);
  const active = state.resourceGroupFilter === String(group.id);
  const artifactCount = resourceArtifactIdsForGroup(group.id).size;
  return `<div class="resource-group-branch"><button type="button" class="resource-group-node ${active ? "active" : ""}" data-resource-group-filter="${escapeHtml(group.id)}" style="--group-depth:${depth}"><span>${escapeHtml(group.name)}</span><small>${artifactCount}</small></button>${children.map((child) => resourceGroupBranch(child, depth + 1)).join("")}</div>`;
}

function renderResourceGroupTree() {
  const target = $("#resourceGroupTree");
  if (!target) return;
  const roots = groupDescendants("").filter((group) => resourceArtifactIdsForGroup(group.id).size);
  target.innerHTML = `<button type="button" class="resource-group-node ${state.resourceGroupFilter ? "" : "active"}" data-resource-group-filter=""><span>Todos</span><small>${resourceArtifacts().length}</small></button>${roots.map((group) => resourceGroupBranch(group)).join("") || `<p>Sin grupos configurados.</p>`}`;
}

async function refreshResourceGroups() {
  try {
    const payload = await api("/resource-groups");
    state.resourceGroups = resourceGroupItems(payload);
    state.resourceGroupPersistenceAvailable = true;
  } catch (_) {
    state.resourceGroups = fallbackResourceGroups();
    state.resourceGroupPersistenceAvailable = false;
  }
  state.resourceGroupView = buildResourceGroupView(state.resourceGroups);
  state.resourceIndex.groupArtifacts = new Map();
  if (state.resourceGroupFilter && !catalogResourceGroups().some((group) => String(group.id) === state.resourceGroupFilter)) state.resourceGroupFilter = "";
  renderResourceGroupTree();
}

function renderResourceGroupManager() {
  const target = $("#resourceGroupManagerBody");
  if (!target) return;
  const editing = state.resourceGroups.find((group) => String(group.id) === state.editingResourceGroupId) || null;
  const parentOptions = state.resourceGroups.filter((group) => !group.fallback && String(group.id) !== state.editingResourceGroupId && !isResourceGroupDescendant(group.id, state.editingResourceGroupId))
    .map((group) => `<option value="${escapeHtml(group.id)}" ${String(editing?.parent_id || "") === String(group.id) ? "selected" : ""}>${escapeHtml(group.name)}</option>`).join("");
  const deleteTargets = state.resourceGroups.filter((group) => !group.fallback && String(group.id) !== state.editingResourceGroupId && !isResourceGroupDescendant(group.id, editing?.id))
    .map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join("");
  const assigned = new Set(resourceValues(editing?.resource_ids));
  const locked = !state.resourceGroupPersistenceAvailable;
  target.innerHTML = `${locked ? `<div class="resource-group-notice"><b>Modo local</b><span>El endpoint de grupos no responde. Se muestran las agrupaciones actuales sin persistir cambios.</span></div>` : ""}
    <div class="resource-group-manager-list"><header><b>Estructura</b><button type="button" data-resource-group-new ${locked ? "disabled" : ""}>Nuevo grupo</button></header>${state.resourceGroups.map((group) => `<button type="button" data-resource-group-edit="${escapeHtml(group.id)}" class="${String(group.id) === state.editingResourceGroupId ? "active" : ""}"><span>${escapeHtml(group.name)}</span><small>${resourceValues(group.resource_ids).length}</small></button>`).join("")}</div>
    <form id="resourceGroupForm" class="resource-group-form">
      <h3>${editing ? "Editar grupo" : "Nuevo grupo"}</h3>
      <label>Nombre<input name="name" required maxlength="120" value="${escapeHtml(editing?.name || "")}" ${locked ? "disabled" : ""}/></label>
      <label>Descripción<textarea name="description" rows="2" ${locked ? "disabled" : ""}>${escapeHtml(editing?.description || "")}</textarea></label>
      <div class="resource-group-form-grid"><label>Grupo padre<select name="parent_id" ${locked ? "disabled" : ""}><option value="">Sin padre</option>${parentOptions}</select></label><label>Orden<input type="number" name="sort_order" value="${Number(editing?.sort_order || 0)}" ${locked ? "disabled" : ""}/></label></div>
      <fieldset ${locked ? "disabled" : ""}><legend>Recursos asignados · una ubicación por recurso</legend><div class="resource-group-assignment-list">${state.resources.map((item) => { const owner = state.resourceGroups.find((group) => resourceValues(group.resource_ids).includes(resourceId(item))); return `<label><input type="checkbox" name="resource_ids" value="${escapeHtml(resourceId(item))}" ${assigned.has(resourceId(item)) ? "checked" : ""}/><span>${escapeHtml(resourceLabel(item))}${owner && String(owner.id) !== String(editing?.id || "") ? `<small>Ahora en ${escapeHtml(owner.name)}</small>` : ""}</span></label>`; }).join("")}</div></fieldset>
      ${editing && !editing.fallback ? `<label class="resource-group-delete-target">Al eliminar, mover recursos a<select id="resourceGroupDeleteTarget"><option value="">Sin clasificar</option>${deleteTargets}</select></label>` : ""}
      <div class="resource-group-form-actions">${editing && !editing.fallback ? `<button type="button" class="danger-btn" data-resource-group-delete="${escapeHtml(editing.id)}">Eliminar</button>` : ""}<button type="submit" class="primary" ${locked ? "disabled" : ""}>${editing ? "Guardar cambios" : "Crear grupo"}</button></div>
    </form>`;
}

export function setResourceGroupManager(open, groupId = "") {
  const drawer = $("#resourceGroupManager");
  const scrim = $("#resourceGroupManagerScrim");
  if (!drawer) return;
  state.resourceGroupManagerOpen = Boolean(open);
  state.editingResourceGroupId = open ? String(groupId || "") : "";
  document.body.classList.toggle("resource-group-manager-open", state.resourceGroupManagerOpen);
  if (scrim) scrim.hidden = !state.resourceGroupManagerOpen;
  drawer.setAttribute("aria-hidden", String(!state.resourceGroupManagerOpen));
  drawer.inert = !state.resourceGroupManagerOpen;
  if (open) {
    if (state.resourceInspectorOpen) setResourceInspector(false, { restoreFocus: false });
    renderResourceGroupManager();
    requestAnimationFrame(() => $("#closeResourceGroupManager")?.focus());
  } else {
    requestAnimationFrame(() => $("#openResourceGroupManager")?.focus());
  }
}

async function saveResourceGroup(form) {
  const values = new FormData(form);
  const resourceIds = values.getAll("resource_ids").map(String);
  const payload = { name: String(values.get("name") || "").trim(), description: String(values.get("description") || "").trim(), parent_id: String(values.get("parent_id") || "") || null, sort_order: Number(values.get("sort_order") || 0) };
  const endpoint = state.editingResourceGroupId ? `/resource-groups/${encodeURIComponent(state.editingResourceGroupId)}` : "/resource-groups";
  const saved = await api(endpoint, { method: state.editingResourceGroupId ? "PUT" : "POST", body: JSON.stringify(payload) });
  const group = saved?.group || saved;
  const groupId = String(group?.id || state.editingResourceGroupId || "");
  if (groupId) {
    const selected = new Set(resourceIds);
    const assignments = {};
    state.resources.forEach((item) => {
      const id = resourceId(item);
      const currentlyAssigned = state.resourceGroups.some((entry) => String(entry.id) === groupId && resourceValues(entry.resource_ids).includes(id));
      if (selected.has(id)) assignments[id] = groupId;
      else if (currentlyAssigned) assignments[id] = null;
    });
    if (Object.keys(assignments).length) await api("/resource-groups/assignments", { method: "PUT", body: JSON.stringify({ assignments }) });
  }
  await refreshResourceGroups();
  renderResourceList();
  state.editingResourceGroupId = groupId;
  renderResourceGroupManager();
  toast("Grupo guardado.");
}

async function deleteResourceGroup(id) {
  if (!window.confirm("¿Eliminar este grupo? Los recursos no se eliminarán.")) return;
  const moveToId = String($("#resourceGroupDeleteTarget")?.value || "");
  const query = new URLSearchParams({ confirmed: "true" });
  if (moveToId) query.set("move_to_id", moveToId);
  await api(`/resource-groups/${encodeURIComponent(id)}?${query}`, { method: "DELETE" });
  state.editingResourceGroupId = "";
  await refreshResourceGroups();
  renderResourceList();
  renderResourceGroupManager();
  toast("Grupo eliminado.");
}

function discoveryItems(payload, key) {
  if (Array.isArray(payload)) return payload;
  return payload?.[key] || payload?.items || payload?.sources || payload?.feed || payload?.results || payload?.data || [];
}

function discoverySourceId(source) {
  return String(source?.id || source?.source_id || source?.slug || source?.name || "").toLowerCase();
}

function normalizedDiscoverySources(payload) {
  const selected = new Set(resourceValues(payload?.selected_source_ids).map((id) => id.toLowerCase()));
  const sources = discoveryItems(payload, "sources").map((source) => ({
    ...source,
    id: discoverySourceId(source),
    name: source.name || source.label || source.title || discoverySourceId(source),
    connected: source.available !== undefined ? Boolean(source.available) : Boolean(source.connected || source.configured || source.status === "connected"),
    enabled: selected.size ? selected.has(discoverySourceId(source)) : Boolean(source.enabled || source.selected),
    requires_credentials: Boolean(source.requires_credentials || source.credentials_required),
  })).filter((source) => source.id);
  if (!sources.some((source) => source.id === "threads")) {
    sources.push({ id: "threads", name: "Threads", connected: false, enabled: false, requires_credentials: true, placeholder: true });
  }
  return sources;
}

function renderResourceDiscoverySources() {
  const select = $("#resourceDiscoverySourceSelect");
  const target = $("#resourceDiscoverySources");
  if (!select || !target) return;
  select.innerHTML = `<option value="">Todas las fuentes</option>${state.resourceDiscoverySources.map((source) => `<option value="${escapeHtml(source.id)}" ${source.id === state.resourceDiscoverySource ? "selected" : ""}>${escapeHtml(source.name)}${source.connected ? "" : " · sin conectar"}</option>`).join("")}`;
  target.innerHTML = state.resourceDiscoverySources.map((source) => {
    const needsCredentials = source.requires_credentials && !source.connected;
    const status = source.connected ? "Conectada" : needsCredentials ? "Requiere credenciales" : "No conectada";
    return `<div class="insp-source" data-discovery-source="${escapeHtml(source.id)}">
      <label><input type="checkbox" name="resource-discovery-source" value="${escapeHtml(source.id)}" ${source.enabled ? "checked" : ""} ${source.connected ? "" : "disabled"}/><span><b>${escapeHtml(source.name)}</b><small>${escapeHtml(status)}</small></span></label>
      ${needsCredentials ? `<button type="button" data-discovery-source-connect="${escapeHtml(source.id)}" aria-label="Configurar credenciales de ${escapeHtml(source.name)}">Conectar</button>` : ""}
    </div>`;
  }).join("");
}

function resourceArtifactIdsForGroup(groupId) {
  const cache = state.resourceIndex?.groupArtifacts || new Map();
  const key = String(groupId || "");
  if (cache.has(key)) return cache.get(key);
  const known = new Set(resourceArtifacts().map(resourceId));
  const result = new Set(resourceIdsForGroup(groupId).map(resourceArtifactId).filter((id) => known.has(id)));
  cache.set(key, result);
  return result;
}

function radarSignalIsCatalogued(item) {
  const signalUrl = safeExternalUrl(item?.url || item?.repo_url || item?.external_url).replace(/\/$/, "").toLowerCase();
  const title = String(item?.title || item?.name || "").trim().toLowerCase();
  return (state.resources || []).some((resource) => {
    const resourceUrl = safeExternalUrl(resource.repo_url || resource.source_url || resource.url).replace(/\/$/, "").toLowerCase();
    return (signalUrl && resourceUrl && signalUrl === resourceUrl)
      || (title && title === resourceLabel(resource).trim().toLowerCase());
  });
}

function githubSignalStars(item) {
  const value = Number(item?.stars ?? item?.stargazers_count ?? item?.metadata?.stars);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function renderResourceDiscoveryFeed() {
  const target = $("#resourceDiscoveryFeed");
  if (!target) return;
  const source = state.resourceDiscoverySource;
  const items = [...(state.resourceDiscoveryFeed || [])]
    .filter((item) => !source || String(item.source_id || item.source || "").toLowerCase() === source)
    .filter((item) => !radarSignalIsCatalogued(item))
    .filter((item) => String(item.source_id || item.source || "").toLowerCase() !== "github" || githubSignalStars(item) > 0);
  if (!items.length) {
    const selected = state.resourceDiscoverySources.find((item) => item.id === source);
    const errorCopy = state.resourceDiscoveryErrors.join(" ");
    const copy = selected && !selected.connected ? `${selected.name} requiere conexión antes de mostrar señales.` : errorCopy || "No hay señales disponibles para las fuentes activas.";
    target.innerHTML = `<div class="insp-empty"><b>Sin señales</b><span>${escapeHtml(copy)}</span></div>`;
    return;
  }
  const warning = state.resourceDiscoveryErrors.length ? `<div class="insp-warning"><b>Algunas fuentes no respondieron</b><span>${escapeHtml(state.resourceDiscoveryErrors.join(" "))}</span></div>` : "";
  const grouped = items.reduce((groups, item) => {
    const key = String(item.source_id || item.source || item.source_name || "other").toLowerCase();
    const label = item.source_name || item.source || item.source_id || "Otras fuentes";
    const group = groups.get(key) || { label, items: [] };
    group.items.push(item);
    groups.set(key, group);
    return groups;
  }, new Map());
  target.innerHTML = warning + Array.from(grouped.values()).map((group) => {
    if (group.label.toLowerCase() === "github") group.items.sort((a, b) => githubSignalStars(b) - githubSignalStars(a));
    return `<section class="insp-signal-source-group"><header><b>${escapeHtml(group.label)}</b><small>${group.items.length} ${group.items.length === 1 ? "señal" : "señales"}</small></header><div class="insp-signal-source-items">${group.items.map((item) => {
    const url = safeExternalUrl(item.url || item.repo_url || item.external_url);
    const sourceLabel = item.source_name || item.source || item.source_id || "Radar";
    const stars = String(item.source_id || item.source || "").toLowerCase() === "github" ? githubSignalStars(item) : 0;
    // El envoltorio <a> ES la tarjeta: anidar un <article> dentro sólo añadía una
    // caja sin estilo entre el enlace y su contenido.
    const content = `<span class="insp-signal-head"><span>${escapeHtml(sourceLabel)}</span><span class="insp-signal-meta">${stars ? `${stars.toLocaleString("es-ES")} estrellas` : ""}</span><time>${escapeHtml(formatResourceTime(item.published_at || item.discovered_at || item.created_at))}</time></span>
      <h3>${escapeHtml(item.title || item.name || "Posible recurso")}</h3>
      <p>${escapeHtml(item.summary || item.description || "Sin resumen disponible.")}</p>
      <footer>${resourceValues(item.tags).slice(0, 3).map((tag) => `<em class="insp-tag">${escapeHtml(tag)}</em>`).join("")}</footer>`;
    const actions = `<footer class="insp-signal-actions">${url ? `<a class="insp-signal-open" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Abrir en web <span aria-hidden="true">&#8599;</span></a>` : ""}${url ? `<button type="button" class="insp-signal-add" data-radar-add-url="${escapeHtml(url)}" data-radar-add-title="${escapeHtml(item.title || item.name || "Referencia del Radar")}">Añadir al catálogo</button>` : ""}</footer>`;
    return `<article class="insp-signal">${content}${actions}</article>`;
  }).join("")}</div></section>`;
  }).join("");
}

function discoveryErrorMessages(errors) {
  if (Array.isArray(errors)) return errors.map((error) => typeof error === "string" ? error : error?.detail || error?.message || error?.source || "Error de fuente");
  if (errors && typeof errors === "object") return Object.entries(errors).map(([source, detail]) => `${source}: ${typeof detail === "string" ? detail : detail?.message || "error"}`);
  return errors ? [String(errors)] : [];
}

export function renderResourceDiscoveryUnavailable(error) {
  if ($("#resourceDiscoveryState")) $("#resourceDiscoveryState").textContent = "Backend pendiente";
  if (!state.resourceDiscoverySources.length) state.resourceDiscoverySources = normalizedDiscoverySources([]);
  renderResourceDiscoverySources();
  const target = $("#resourceDiscoveryFeed");
  if (target) target.innerHTML = `<div class="insp-empty error"><b>Radar no disponible</b><span>${escapeHtml(error?.message || "Los endpoints de discovery aún no responden.")}</span></div>`;
  renderResourceKpis();
}

export async function refreshResourceDiscovery(options = {}) {
  const now = Date.now();
  const rotationMs = Math.max(15, Number(state.resourceRefreshSettings?.radar_interval_minutes) || 60) * 60 * 1000;
  if (!options.force && state.resourceDiscoveryLastFetchedAt && now - state.resourceDiscoveryLastFetchedAt < rotationMs) {
    renderResourceDiscoverySources();
    renderResourceDiscoveryFeed();
    renderResourceKpis();
    return;
  }
  const sourcePayload = await api("/resources/discovery/sources");
  state.resourceDiscoverySources = normalizedDiscoverySources(sourcePayload);
  if (!options.preserveSource || !state.resourceDiscoverySources.some((source) => source.id === state.resourceDiscoverySource)) state.resourceDiscoverySource = "";
  renderResourceDiscoverySources();
  const feedPayload = await api("/resources/discovery/feed");
  state.resourceDiscoveryFeed = discoveryItems(feedPayload, "items");
  state.resourceDiscoveryErrors = discoveryErrorMessages(feedPayload?.errors);
  state.resourceDiscoveryLastFetchedAt = Date.parse(feedPayload?.fetched_at || "") || now;
  if ($("#resourceDiscoveryState")) $("#resourceDiscoveryState").textContent = `${state.resourceDiscoveryFeed.length} señales${state.resourceDiscoveryErrors.length ? " · con avisos" : ""}`;
  renderResourceDiscoveryFeed();
  renderResourceKpis();
}

async function saveResourceDiscoverySources(button) {
  const enabledSourceIds = $$('input[name="resource-discovery-source"]:checked', $("#resourceDiscoverySources")).map((input) => input.value);
  button.disabled = true;
  try {
    const payload = await api("/resources/discovery/sources", { method: "PUT", body: JSON.stringify({ source_ids: enabledSourceIds }) });
    state.resourceDiscoverySources = payload
      ? normalizedDiscoverySources(payload)
      : state.resourceDiscoverySources.map((source) => ({ ...source, enabled: enabledSourceIds.includes(source.id) }));
    renderResourceDiscoverySources();
    await refreshResourceDiscovery({ preserveSource: true, force: true });
    toast("Fuentes del Radar actualizadas.");
  } finally {
    button.disabled = false;
  }
}

function resourceCompatibility(item, runtime) {
  const installed = resourceValues(item?.installations?.filter?.((entry) => String(entry.target).toLowerCase() === runtime)?.map?.((entry) => entry.target));
  if (installed.length) {
    const verified = item.installations.filter((entry) => String(entry.target).toLowerCase() === runtime).every((entry) => entry.verified !== false);
    return { status: verified ? "installed" : "error", detail: verified ? "Instalado y verificado" : "Instalación pendiente de verificar" };
  }
  const raw = item?.compatibility?.[runtime] ?? item?.matrix?.[runtime] ?? item?.[`${runtime}_compatibility`] ?? item?.runtimes?.[runtime];
  if (typeof raw === "boolean") return { status: raw ? "compatible" : "unsupported", detail: raw ? "Compatible" : "No compatible" };
  if (typeof raw === "string") return { status: raw.toLowerCase(), detail: raw };
  if (raw && typeof raw === "object") return { status: String(raw.status || (raw.compatible === false ? "unsupported" : "compatible")).toLowerCase(), detail: raw.detail || raw.reason || raw.version || "Compatible" };
  const listed = resourceRuntime(item).map((name) => name.toLowerCase());
  return { status: listed.includes(runtime) ? "compatible" : "unknown", detail: listed.includes(runtime) ? "Declarado por el recurso" : "Sin datos" };
}

function compatibilityCell(item, runtime, label) {
  const info = resourceCompatibility(item, runtime);
  const tone = ["compatible", "ready", "supported", "installed"].includes(info.status) ? "ok" : ["unsupported", "incompatible", "error"].includes(info.status) ? "bad" : "neutral";
  return `<div class="resource-matrix-cell tone-${tone}"><header><b>${label}</b><span>${escapeHtml(info.status)}</span></header><p>${escapeHtml(info.detail)}</p></div>`;
}

function resourceLogEntries(item) {
  const raw = item?.operations || item?.logs || item?.events || item?.operation_log || [];
  const entries = Array.isArray(raw) ? raw : raw?.items || [];
  if (entries.length) return entries;
  return (item?.installations || []).map((installation) => ({
    action: "install",
    status: installation.verified === false ? "failed" : "succeeded",
    detail: `${installation.target || "runtime"} · ${installation.path || "instalación registrada"}`,
    created_at: installation.installed_at,
  }));
}

function formatResourceTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
}

function knownResourceAgents(item) {
  const ids = resourceAgents(item);
  const known = (state.entities || []).map((agent) => ({ id: String(agent.id), label: agent.name || entityLabel(agent.id) }));
  ids.forEach((id) => { if (!known.some((agent) => agent.id === id)) known.push({ id, label: id }); });
  return known;
}

// El detalle es una capa superpuesta, no una columna del grid: abrirlo y
// cerrarlo no debe recolocar la rejilla de tarjetas que hay debajo.
const RESOURCE_INSPECTOR_MIN = 360;

const RESOURCE_INSPECTOR_MAX = 760;

function resourceInspectorIsMobile() {
  return window.matchMedia("(max-width: 900px)").matches;
}

export function renderResourceRefreshSettings() {
  const settings = state.resourceRefreshSettings || {};
  const run = state.resourceRefreshRun || settings.current_run || null;
  const days = $("#resourceRefreshDays");
  if (days) [...days.options].forEach((option) => {
    const value = Number(option.value);
    option.textContent = value === 1 ? "Cada d\u00eda" : `Cada ${value} d\u00edas`;
  });
  if ($("#resourceRefreshEnabled")) $("#resourceRefreshEnabled").checked = settings.repository_enabled !== false;
  if ($("#resourceRefreshDays")) $("#resourceRefreshDays").value = String(settings.repository_interval_days || 7);
  if ($("#radarRefreshMinutes")) $("#radarRefreshMinutes").value = String(settings.radar_interval_minutes || 60);
  const stateNode = $("#resourceRefreshState");
  if (stateNode) {
    const repository = settings.repository_enabled === false ? "Repositorios: pausado" : `Repositorios: ${settings.repository_interval_days || 7} d\u00edas`;
    const minutes = Number(settings.radar_interval_minutes) || 60;
    const radar = minutes === 60 ? "Radar: 1 hora" : minutes < 60 ? `Radar: ${minutes} min` : `Radar: ${minutes / 60} h`;
    stateNode.textContent = `${repository} \u00b7 ${radar}`;
  }
  const progress = $("#resourceRefreshProgress");
  const runButton = $("#runResourceRefresh");
  const active = ["queued", "running"].includes(run?.status);
  if (runButton) {
    runButton.disabled = active;
    runButton.textContent = active ? "Reanalizando catálogo…" : "Reanalizar catálogo completo";
  }
  if (progress) {
    progress.hidden = !run;
    // Sin ninguna ejecución registrada (instalación nueva) el panel queda
    // oculto de todos modos, y el resto de este bloque lee `run.status`
    // directamente: seguir adelante tiraba la vista entera con un TypeError.
    if (!run) return;
    const total = Math.max(0, Number(run?.total) || 0);
    const processed = Math.max(0, Number(run?.processed) || 0);
    const percent = total ? Math.round((processed / total) * 100) : (active ? 0 : 100);
    const labels = {
      queued: "Preparando reanálisis",
      running: "Reanalizando todo el catálogo",
      completed: "Catálogo actualizado",
      completed_with_errors: "Reanálisis completado con incidencias",
      failed: "No se pudo completar el reanálisis",
    };
    if ($("#resourceRefreshProgressTitle")) $("#resourceRefreshProgressTitle").textContent = labels[run.status] || "Estado del reanálisis";
    if ($("#resourceRefreshProgressCount")) $("#resourceRefreshProgressCount").textContent = `${processed} / ${total}`;
    const bar = $("#resourceRefreshProgressBar");
    if (bar) {
      bar.value = percent;
      bar.textContent = `${percent}%`;
    }
    if ($("#resourceRefreshProgressMeta")) {
      $("#resourceRefreshProgressMeta").textContent =
        `${Number(run.updated) || 0} actualizados · ${Number(run.unchanged) || 0} sin cambios · ${Number(run.failed) || 0} fallidos · ${Number(run.skipped) || 0} omitidos · ${Number(run.children_indexed) || 0} componentes enlazados`;
    }
  }
}

export async function refreshResourceRefreshSettings() {
  const payload = await api("/resources/refresh/settings");
  state.resourceRefreshSettings = { ...state.resourceRefreshSettings, ...(payload || {}) };
  state.resourceRefreshRun = payload?.current_run || state.resourceRefreshRun;
  renderResourceRefreshSettings();
}

async function saveResourceRefreshSettings(button) {
  button.disabled = true;
  try {
    const payload = await api("/resources/refresh/settings", {
      method: "PUT",
      body: JSON.stringify({
        repository_enabled: $("#resourceRefreshEnabled")?.checked !== false,
        repository_interval_days: Number($("#resourceRefreshDays")?.value) || 7,
        radar_interval_minutes: Number($("#radarRefreshMinutes")?.value) || 60,
      }),
    });
    state.resourceRefreshSettings = { ...state.resourceRefreshSettings, ...(payload || {}) };
    renderResourceRefreshSettings();
    toast("Frecuencia de actualizacion guardada.");
  } finally {
    button.disabled = false;
  }
}

async function runResourceRefresh(button) {
  button.disabled = true;
  button.textContent = "Preparando…";
  try {
    const run = await api("/resources/refresh/run", { method: "POST", body: JSON.stringify({ confirmed: true }) });
    state.resourceRefreshRun = run;
    toast(`Reanálisis iniciado para ${Number(run?.total) || 0} recursos.`);
    renderResourceRefreshSettings();
    await pollResourceRefreshRun(run.run_id);
  } catch (error) {
    button.disabled = false;
    renderResourceRefreshSettings();
    throw error;
  }
}

async function pollResourceRefreshRun(runId) {
  if (!runId || state.resourceRefreshPollId === runId) return;
  state.resourceRefreshPollId = runId;
  try {
    while (state.resourceRefreshPollId === runId) {
      const run = await api(`/resources/refresh/runs/${encodeURIComponent(runId)}`);
      state.resourceRefreshRun = run;
      renderResourceRefreshSettings();
      if (!["queued", "running"].includes(run?.status)) {
        const message = run.status === "completed"
          ? `Catálogo reanalizado: ${run.updated} actualizados y ${run.unchanged} sin cambios.`
          : `Reanálisis terminado con ${run.failed} fallos y ${run.skipped} omitidos.`;
        toast(message);
        await refreshResources({ preserveSelection: true });
        await refreshResourceRefreshSettings();
        break;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
  } finally {
    if (state.resourceRefreshPollId === runId) state.resourceRefreshPollId = "";
    renderResourceRefreshSettings();
  }
}

function applyResourceInspectorWidth() {
  const inspector = $("#resourceInspector");
  const splitter = $("#resourceInspectorSplitter");
  if (!inspector) return;
  inspector.style.setProperty("--insp-inspector-width", `${state.resourceInspectorWidth}px`);
  if (splitter) {
    splitter.hidden = resourceInspectorIsMobile();
    splitter.setAttribute("aria-valuenow", String(state.resourceInspectorWidth));
  }
}

function setResourceInspectorWidth(width) {
  state.resourceInspectorWidth = Math.min(RESOURCE_INSPECTOR_MAX, Math.max(RESOURCE_INSPECTOR_MIN, Math.round(width)));
  localStorage.setItem("karajan-inspiration-inspector-width", String(state.resourceInspectorWidth));
  applyResourceInspectorWidth();
}

function initResourceInspectorResize() {
  const splitter = $("#resourceInspectorSplitter");
  if (!splitter || splitter.dataset.resizeBound) return;
  splitter.dataset.resizeBound = "1";
  splitter.addEventListener("pointerdown", (event) => {
    if (resourceInspectorIsMobile() || event.button !== 0) return;
    state.resizingResourceInspector = true;
    splitter.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-resource-inspector");
    event.preventDefault();
  });
  splitter.addEventListener("pointermove", (event) => {
    if (!state.resizingResourceInspector) return;
    setResourceInspectorWidth(window.innerWidth - event.clientX);
  });
  const stopResize = (event) => {
    if (!state.resizingResourceInspector) return;
    state.resizingResourceInspector = false;
    document.body.classList.remove("resizing-resource-inspector");
    if (event?.pointerId !== undefined && splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
  };
  splitter.addEventListener("pointerup", stopResize);
  splitter.addEventListener("pointercancel", stopResize);
  splitter.addEventListener("keydown", (event) => {
    const values = { ArrowLeft: state.resourceInspectorWidth + 10, ArrowRight: state.resourceInspectorWidth - 10, Home: RESOURCE_INSPECTOR_MIN, End: RESOURCE_INSPECTOR_MAX };
    if (!(event.key in values)) return;
    event.preventDefault();
    setResourceInspectorWidth(values[event.key]);
  });
  window.addEventListener("resize", applyResourceInspectorWidth);
  applyResourceInspectorWidth();
}

export function setResourceInspector(open, options = {}) {
  const inspector = $("#resourceInspector");
  if (!inspector) return;
  const scrim = $("#resourceInspectorScrim");
  state.resourceInspectorOpen = Boolean(open);
  document.body.classList.toggle("insp-drawer-open", state.resourceInspectorOpen);
  if (scrim) scrim.hidden = !state.resourceInspectorOpen;
  inspector.setAttribute("aria-hidden", String(!state.resourceInspectorOpen));
  inspector.inert = !state.resourceInspectorOpen;
  if (state.resourceInspectorOpen) {
    if (options.focus !== false) requestAnimationFrame(() => $("#closeResourceInspector")?.focus({ preventScroll: true }));
    return;
  }
  const triggerId = state.resourceInspectorTriggerId;
  state.selectedResourceId = "";
  state.resourceDetail = null;
  renderResourceList();
  renderResourceDetail(null);
  if (options.restoreFocus !== false && triggerId) requestAnimationFrame(() => document.getElementById(resourceCardDomId(triggerId))?.focus({ preventScroll: true }));
}

function resourceIntelligence(item) {
  const value = item?.metadata?.intelligence || item?.metadata?.resource_intelligence || item?.intelligence || {};
  return value && typeof value === "object" ? value : {};
}

function resourceDetailValues(item, key) {
  const intelligence = resourceIntelligence(item);
  const aliases = {
    capabilities: [item?.capabilities, intelligence.capabilities],
    interfaces: [intelligence.interfaces],
    frameworks: [intelligence.frameworks],
    languages: [intelligence.languages, item?.requirements],
    use_cases: [intelligence.use_cases],
    tags: [item?.tags, intelligence.tags],
  };
  return [...new Set((aliases[key] || []).flatMap(resourceValues).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
}

function resourceChipList(values, empty = "Sin datos detectados") {
  return values.length
    ? values.map((value) => `<span class="resource-capability-chip">${escapeHtml(value)}</span>`).join("")
    : `<span class="resource-capability-empty">${escapeHtml(empty)}</span>`;
}

function resourceNestedComponents(item) {
  const paths = resourceValues(item?.metadata?.skill_paths);
  return paths.map((path) => {
    const parts = String(path).replace(/\\/g, "/").split("/").filter(Boolean);
    const name = parts.length > 1 ? parts[parts.length - 2] : resourceLabel(item);
    return { name, path };
  });
}

function resourceRuntimeOption(item, runtime, label) {
  const info = resourceCompatibility(item, runtime);
  const installed = (item.installations || []).some((entry) => String(entry.target).toLowerCase() === runtime);
  const compatible = resourceRuntime(item).map((value) => value.toLowerCase()).includes(runtime);
  const enabled = installed || compatible;
  const tone = installed ? "ok" : enabled ? "neutral" : "muted";
  return `<label class="resource-runtime-option tone-${tone}${enabled ? "" : " disabled"}"><input type="checkbox" name="resource-target" value="${escapeHtml(runtime)}" ${enabled ? "checked" : "disabled"}/><span><b>${escapeHtml(label)}</b><small>${escapeHtml(info.detail)}</small></span><em>${installed ? "Instalado" : enabled ? "Compatible" : "No disponible"}</em></label>`;
}

function renderResourceDetail(item = state.resourceDetail) {
  const target = $("#resourceDetail");
  if (!target) return;
  if (!item) {
    target.innerHTML = `<div class="resource-detail-empty"><b>Selecciona un recurso</b><span>Consulta sus funciones, componentes y conexi&oacute;n con agentes.</span></div>`;
    return;
  }
  const id = resourceId(item);
  const status = resourceStatus(item);
  const repo = safeExternalUrl(item.repo_url || item.source_url || item.repository_url || item.url || item.metadata?.homepage_url || item.external_url || item.metadata?.validity?.source_url);
  const validity = item?.metadata?.validity || {};
  const githubRepository = validity.github_repository ?? (() => {
    if (!repo) return false;
    try {
      const parsed = new URL(repo);
      return parsed.hostname.toLowerCase() === "github.com" && parsed.pathname.split("/").filter(Boolean).length >= 2;
    } catch (_) { return false; }
  })();
  const rawStars = validity.github_stars ?? item?.metadata?.github_stars;
  const githubStars = rawStars !== null && rawStars !== undefined && Number.isFinite(Number(rawStars)) ? Number(rawStars) : null;
  const starFact = githubRepository
    ? githubStars === null
      ? `<span class="resource-repository-fact pending" title="Ejecuta Revalidar ahora para consultar GitHub">Estrellas pendientes de verificar</span>`
      : `<span class="resource-repository-fact verified" title="Contador obtenido de GitHub">&#9733; ${githubStars.toLocaleString("es-ES")} estrellas en GitHub</span>`
    : `<span class="resource-repository-fact neutral">Estrellas: no aplica · referencia web</span>`;
  const agents = resourceAgents(item);
  const knownAgents = knownResourceAgents(item);
  const logs = resourceLogEntries(item);
  const detectedComponents = resourceNestedComponents(item);
  const lineage = resourceLineage(item);
  const detectedChildIds = new Set(lineage.children.map(resourceId));
  const pathComponents = detectedComponents.filter((component) => !lineage.children.some((child) => resourceLabel(child).toLowerCase() === String(component.name).toLowerCase()));
  const componentCount = detectedChildIds.size + pathComponents.length;
  const parentInCatalog = lineage.parent && (state.resources || []).some((candidate) => resourceId(candidate) === resourceId(lineage.parent));
  const nestedIndexable = resourceSupportsNestedIndex(item);
  const capabilities = resourceDetailValues(item, "capabilities");
  const interfaces = resourceDetailValues(item, "interfaces");
  const frameworks = resourceDetailValues(item, "frameworks");
  const languages = resourceDetailValues(item, "languages");
  const useCases = resourceDetailValues(item, "use_cases");
  const tags = resourceDetailValues(item, "tags");
  const installedTargets = resourceValues(item.installations?.map?.((installation) => installation.target));
  const hasInstallations = installedTargets.length > 0;
  const installable = String(item.install_strategy || "none") !== "none";
  const primaryAction = hasInstallations || status === "installed" || status === "partial" ? "update" : "install";
  const pending = state.resourceOperationPending?.id === id;
  const intelligence = resourceIntelligence(item);
  const taxonomy = intelligence.primary_taxonomy || item.metadata?.decision_taxonomy || "general";
  const latest = logs.length ? logs[0] : null;
  const operationHint = !installable
    ? "Este elemento es informativo y no dispone de un instalador aprobado."
    : hasInstallations
      ? `Instalado en ${installedTargets.join(", ")}. Selecciona los destinos que quieres gestionar.`
      : "Selecciona Claude, Codex o ambos antes de instalar.";

  target.innerHTML = `<article class="resource-detail-v2">
    <header class="resource-detail-hero">
      <div class="resource-detail-title-row"><span class="resource-kind-mark">${escapeHtml((resourceFacet(item, "kind")[0] || "resource").slice(0, 2).toUpperCase())}</span><div>${resourceStatusPill(status)}<h2>${escapeHtml(resourceLabel(item))}</h2></div></div>
      <div class="resource-summary-row"><p>${escapeHtml(resourceSummary(item) || "Sin descripci\u00f3n disponible.")}</p><button type="button" class="resource-edit-description" data-resource-edit-description aria-label="Editar descripciÃ³n" title="Editar descripciÃ³n">&#9998;</button></div>
      <div class="resource-description-editor" data-resource-description-editor hidden><textarea data-resource-description-input rows="4" maxlength="4000">${escapeHtml(resourceSummary(item))}</textarea><div><button type="button" data-resource-description-cancel>Cancelar</button><button type="button" class="primary" data-resource-description-save="${escapeHtml(id)}">Guardar descripciÃ³n</button></div></div>
      <div class="resource-detail-facts">${starFact}</div>
      <div class="resource-detail-links">${repo ? `<a href="${escapeHtml(repo)}" target="_blank" rel="noreferrer">Abrir fuente <span aria-hidden="true">&#8599;</span></a>` : ""}<code>${escapeHtml(id)}</code></div>
    </header>

    ${(lineage.parent || (!lineage.children.length && nestedIndexable)) ? `<section class="resource-detail-section resource-lineage-section"><div class="resource-section-title"><div><h3>${lineage.parent ? "Artefacto de origen" : "Contenido indexable"}</h3><p>${lineage.parent ? "Este componente forma parte de un artefacto de la Biblioteca." : "Esta referencia tiene contenido interno pendiente de indexar."}</p></div><strong>${lineage.parent ? "Hijo" : "Pendiente"}</strong></div>
      ${lineage.parent ? `<div class="resource-parent-link"><span class="resource-lineage-mark">&#8593;</span><div><small>Referencia padre</small>${parentInCatalog ? `<button type="button" data-resource-id="${escapeHtml(resourceId(lineage.parent))}">${escapeHtml(resourceLabel(lineage.parent))}</button>` : `<b>${escapeHtml(resourceLabel(lineage.parent))}</b>`}</div></div>` : ""}
      ${!lineage.parent && !lineage.children.length && nestedIndexable ? `<div class="resource-nested-pending"><div><b>Contenido anidado no indexado</b><small>Indexa esta referencia para descubrir y etiquetar sus elementos internos.</small></div><button type="button" class="primary" data-resource-reindex="${escapeHtml(id)}">Indexar elementos</button></div>` : ""}
    </section>` : ""}

    <section class="resource-detail-section resource-purpose"><div class="resource-section-title"><div><h3>Funcionalidad</h3><p>Lo que aporta este recurso y las tecnologias que utiliza.</p></div></div>
      <div class="resource-capability-block"><h4>Capacidades</h4><div>${resourceChipList(capabilities, "Sin capacidades etiquetadas")}</div></div>
      <div class="resource-capability-columns">
        <div><h4>Interfaces</h4><div>${resourceChipList(interfaces)}</div></div>
        <div><h4>Frameworks</h4><div>${resourceChipList(frameworks)}</div></div>
        <div><h4>Lenguajes y requisitos</h4><div>${resourceChipList(languages)}</div></div>
        <div><h4>Casos de uso</h4><div>${resourceChipList(useCases)}</div></div>
      </div>
      ${tags.length ? `<details class="resource-tag-details"><summary>Etiquetas adicionales <span>${tags.length}</span></summary><div>${resourceChipList(tags)}</div></details>` : ""}
    </section>

    <section class="resource-detail-section resource-components"><details class="resource-components-disclosure"><summary><span><b>Componentes detectados</b><small>Hijos y piezas anidadas que componen este artefacto.</small></span><em>${componentCount}</em></summary>
      <div class="resource-components-body">
        ${lineage.children.length ? `<div class="resource-child-list">${lineage.children.map((child) => `<button type="button" class="resource-child-row" data-resource-id="${escapeHtml(resourceId(child))}" aria-label="Abrir componente ${escapeHtml(resourceLabel(child))}"><span class="resource-lineage-mark">&#8627;</span><span class="resource-child-copy"><b>${escapeHtml(resourceLabel(child))}</b><small>${escapeHtml(resourceSummary(child) || child.source_url || "Componente indexado")}</small></span>${resourceStatusPill(resourceStatus(child))}</button>`).join("")}</div>` : ""}
        ${pathComponents.length ? `<div class="resource-component-list">${pathComponents.map((component) => `<article><span class="resource-component-icon">SK</span><div><b>${escapeHtml(component.name)}</b><code>${escapeHtml(component.path)}</code></div></article>`).join("")}</div>` : ""}
        ${!componentCount ? `<p class="resource-section-empty">Este artefacto no contiene componentes detectados.</p>` : ""}
      </div>
    </details></section>

    <section class="resource-detail-section resource-agent-section"><div class="resource-section-title"><div><h3>Conectar con agentes</h3><p>Define qu&eacute; agentes pueden descubrir y utilizar este recurso.</p></div><strong>${agents.length}/${knownAgents.length}</strong></div>
      <div class="resource-agent-toolbar"><button type="button" data-resource-agent-select="all">Seleccionar todos</button><button type="button" data-resource-agent-select="none">Quitar todos</button></div>
      <div class="resource-agent-list">${knownAgents.length ? knownAgents.map((agent) => `<label><input type="checkbox" name="resource-agent" value="${escapeHtml(agent.id)}" ${agents.includes(agent.id) ? "checked" : ""}/><span><b>${escapeHtml(agent.label)}</b><small>${escapeHtml(agent.id)}</small></span><em>${agents.includes(agent.id) ? "Conectado" : "Sin acceso"}</em></label>`).join("") : `<p>No hay agentes registrados. Crea un agente antes de asignar recursos.</p>`}</div>
      <button type="button" class="resource-agent-save" data-resource-save-visibility="${escapeHtml(id)}" ${knownAgents.length ? "" : "disabled"}>Guardar conexi&oacute;n</button>
    </section>

    <section class="resource-detail-section resource-install-section"><div class="resource-section-title"><div><h3>Instalaci&oacute;n y mantenimiento</h3><p>${escapeHtml(operationHint)}</p></div></div>
      <div class="resource-runtime-list">${resourceRuntimeOption(item, "claude", "Claude")}${resourceRuntimeOption(item, "codex", "Codex")}</div>
      ${latest ? `<div class="resource-latest-operation tone-${resourceTone(String(latest.status || ""))}"><span>&Uacute;ltima operaci&oacute;n</span><b>${escapeHtml(latest.action || "evento")}</b><small>${escapeHtml(latest.detail || latest.message || latest.status || "Sin detalle")}</small></div>` : ""}
      <div class="resource-operation-actions">
        <button type="button" class="primary" data-resource-operation="${primaryAction}" data-resource-operation-id="${escapeHtml(id)}" ${installable && !pending ? "" : "disabled"}>${pending ? "Procesando..." : primaryAction === "install" ? "Instalar" : "Actualizar"}</button>
        <button type="button" data-resource-operation="verify" data-resource-operation-id="${escapeHtml(id)}" ${installable && hasInstallations && !pending ? "" : "disabled"}>Verificar</button>
        <button type="button" class="danger-btn" data-resource-operation="uninstall" data-resource-operation-id="${escapeHtml(id)}" ${installable && hasInstallations && !pending ? "" : "disabled"}>Desinstalar</button>
      </div>
    </section>

    <section class="resource-detail-section resource-metadata-section"><details><summary>Resumen de metadatos</summary><dl class="resource-metadata">
      <div><dt>Clasificaci&oacute;n</dt><dd>${escapeHtml(String(taxonomy))}</dd></div>
      <div><dt>Origen</dt><dd>${escapeHtml(resourceFacet(item, "source")[0] || "-")}</dd></div>
      <div><dt>Licencia</dt><dd>${escapeHtml(item.license || item.metadata?.license || "-")}</dd></div>
      <div><dt>Version</dt><dd>${escapeHtml(item.version || item.installed_version || "-")}</dd></div>
      <div><dt>Estrategia</dt><dd>${escapeHtml(item.install_strategy || "none")}</dd></div>
      <div><dt>Rama</dt><dd>${escapeHtml(item.metadata?.default_branch || "-")}</dd></div>
      <div><dt>Actualizado</dt><dd>${escapeHtml(formatResourceTime(item.updated_at || item.last_updated))}</dd></div>
      <div><dt>Resumen</dt><dd>${escapeHtml(item.metadata?.summary_method || "manual")}</dd></div>
    </dl><button type="button" class="resource-reanalyze-btn" data-resource-reanalyze="${escapeHtml(id)}" ${repo ? "" : "disabled"}>Volver a analizar fuente</button></details></section>

    <section class="resource-detail-section resource-log-section"><details><summary>Historial de operaciones <span>${logs.length}</span></summary><div class="resource-log">${logs.length ? logs.slice(0, 12).map((entry) => {
      const logStatus = String(entry.status || entry.level || "info").toLowerCase();
      return `<article><i class="tone-${resourceTone(logStatus)}"></i><div><b>${escapeHtml(entry.action || entry.operation || entry.type || "Evento")}</b><span>${escapeHtml(entry.message || entry.detail || entry.summary || logStatus)}</span></div><time>${escapeHtml(formatResourceTime(entry.created_at || entry.timestamp || entry.time))}</time></article>`;
    }).join("") : `<p>Sin operaciones registradas.</p>`}</div></details></section>
  </article>`;
  const descriptionEditButton = target.querySelector("[data-resource-edit-description]");
  if (descriptionEditButton) {
    descriptionEditButton.textContent = "\u270e";
    descriptionEditButton.setAttribute("aria-label", "Editar descripci\u00f3n");
    descriptionEditButton.setAttribute("title", "Editar descripci\u00f3n");
    descriptionEditButton.setAttribute("aria-expanded", "false");
    descriptionEditButton.setAttribute("aria-controls", "resourceDescriptionEditor");
  }
  const descriptionSaveButton = target.querySelector("[data-resource-description-save]");
  if (descriptionSaveButton) descriptionSaveButton.textContent = "Guardar descripci\u00f3n";
  const descriptionEditor = target.querySelector("[data-resource-description-editor]");
  const descriptionInput = target.querySelector("[data-resource-description-input]");
  target.querySelector(".resource-detail-hero > .resource-edit-description")?.remove();
  if (descriptionEditor && descriptionInput) {
    descriptionEditor.id = "resourceDescriptionEditor";
    descriptionInput.id = "resourceDescriptionInput";
    if (!descriptionEditor.querySelector(".resource-description-editor-head")) {
      descriptionEditor.insertAdjacentHTML("afterbegin", `<div class="resource-description-editor-head"><b>Editar descripci\u00f3n</b><small>Corrige la finalidad para que los agentes encuentren este recurso con mayor precision.</small></div><label for="resourceDescriptionInput">Descripci\u00f3n</label>`);
    }
  }
}

async function saveResourceDescription(id, button) {
  const editor = button.closest("[data-resource-description-editor]");
  const input = editor?.querySelector("[data-resource-description-input]");
  if (!input) return;
  button.disabled = true;
  try {
    const updated = await api(`/resources/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ summary: input.value }) });
    state.resourceDetail = updated?.item || updated?.resource || updated;
    state.resources = state.resources.map((item) => resourceId(item) === id ? state.resourceDetail : item);
    toast("DescripciÃ³n actualizada.");
    renderResourceDetail(state.resourceDetail);
    renderResourceList();
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function reanalyzeResource(id, button) {
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = "Analizandoâ¦";
  try {
    const updated = await api(`/resources/${encodeURIComponent(id)}/reanalyze`, { method: "POST", body: JSON.stringify({ confirmed: true }) });
    state.resourceDetail = updated?.item || updated?.resource || updated;
    state.resources = state.resources.map((item) => resourceId(item) === id ? state.resourceDetail : item);
    toast("Fuente reanalizada y metadatos actualizados.");
    renderResourceDetail(state.resourceDetail);
    renderResourceList();
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = previous; }
}

export function renderResourceError(error) {
  const target = $("#resourceList");
  if (target) target.innerHTML = `<div class="insp-empty error"><b>No se pudo cargar el catálogo</b><span>${escapeHtml(error?.message || "Error desconocido")}</span><button type="button" class="ghost-btn" data-resource-retry>Reintentar</button></div>`;
  if ($("#resourceSyncState")) $("#resourceSyncState").textContent = "Error de sincronización";
}

export async function refreshResources(options = {}) {
  const resources = [];
  // Query each Composite leaf type independently. This also remains
  // compatible with Karajan processes started before full pagination was
  // introduced, where one global 500-row page could hide top-level artifacts
  // behind hundreds of indexed children.
  for (const kind of ["skill", "capability", "reference"]) {
    for (let offset = 0; ; offset += 500) {
      const payload = await api(`/resources?kind=${kind}&accepted_only=true&limit=500&offset=${offset}`);
      const page = resourceItems(payload);
      resources.push(...page);
      if (page.length < 500) break;
    }
  }
  state.resources = [...new Map(resources.map((item) => [resourceId(item), item])).values()];
  rebuildResourceIndex();
  const selectionExists = state.resources.some((item) => resourceId(item) === state.selectedResourceId);
  if (!selectionExists && state.resourceInspectorOpen) setResourceInspector(false, { restoreFocus: false });
  renderResourceFilters();
  await refreshResourceGroups();
  renderResourceList();
  renderResourceKpis();
  await loadValidityUi();
  if ($("#resourceSyncState")) $("#resourceSyncState").textContent = `Actualizado ${new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`;
  if (state.resourceInspectorOpen && selectionExists) await selectResource(state.selectedResourceId, { keepList: true, openInspector: false, keepFocus: true });
}

async function selectResource(id, options = {}) {
  state.selectedResourceId = String(id);
  if (!options.keepList) state.resourceInspectorTriggerId = state.selectedResourceId;
  const summary = state.resources.find((item) => resourceId(item) === state.selectedResourceId) || null;
  state.resourceDetail = summary;
  if (options.openInspector !== false) setResourceInspector(true, { focus: false });
  if (!options.keepList) renderResourceList();
  renderResourceDetail(summary);
  if (options.openInspector !== false && !options.keepFocus) requestAnimationFrame(() => $("#closeResourceInspector")?.focus({ preventScroll: true }));
  try {
    const payload = await api(`/resources/${encodeURIComponent(state.selectedResourceId)}`);
    state.resourceDetail = payload?.item || payload?.resource || payload;
    renderResourceDetail(state.resourceDetail);
  } catch (error) {
    if (!summary) renderResourceError(error);
  }
}

function setResourceModal(open) {
  const modal = $("#resourceModal");
  if (!modal) return;
  modal.hidden = !open;
  document.body.classList.toggle("modal-open", open);
  if (open) requestAnimationFrame(() => $("#resourceRepoUrl")?.focus());
}

function openResourceWizard(options = {}) {
  state.resourceWizard = { step: 1, mode: options.mode === "radar" ? "radar" : "catalog", repoUrl: options.repoUrl || "", analysis: null };
  renderResourceWizard();
  setResourceModal(true);
}

function resourceAnalysisObject(analysis) {
  return analysis?.preview || analysis?.resource || analysis?.candidate || analysis?.analysis || analysis || {};
}

function resourceAnalysisValue(analysis, key, fallback = "") {
  const candidate = resourceAnalysisObject(analysis);
  return candidate[key] ?? fallback;
}

function renderResourceWizard() {
  const body = $("#resourceModalBody");
  if (!body) return;
  const wizard = state.resourceWizard;
  $("#resourceModalStep").textContent = `Paso ${wizard.step} de 3`;
  if (wizard.step === 1) {
    body.innerHTML = `<form id="resourceAnalyzeForm" class="resource-wizard-form"><div class="resource-wizard-progress"><i class="active"></i><i></i><i></i></div><h3>Analizar referencia</h3><p>Elige dónde quieres guardar esta URL. Las referencias Radar son señales de inspiración; las de Catálogo quedan disponibles para tus agentes.</p><fieldset class="resource-mode-toggle"><legend>Destino</legend><label><input type="radio" name="resource_mode" value="catalog" ${wizard.mode !== "radar" ? "checked" : ""}/><span><b>Catálogo</b><small>Recurso consultable y clasificable</small></span></label><label><input type="radio" name="resource_mode" value="radar" ${wizard.mode === "radar" ? "checked" : ""}/><span><b>Radar</b><small>Señal externa para inspiración</small></span></label></fieldset><label>URL de referencia<input id="resourceRepoUrl" name="repo_url" type="text" inputmode="url" autocapitalize="off" spellcheck="false" required placeholder="https://www.threads.com/@midu.dev" value="${escapeHtml(wizard.repoUrl)}" /></label><div class="resource-wizard-actions"><button type="button" data-resource-wizard-cancel>Cancelar</button><button type="submit" class="primary">Analizar</button></div></form>`;
    return;
  }
  const analysis = wizard.analysis || {};
  const name = resourceAnalysisValue(analysis, "name", wizard.repoUrl.split("/").filter(Boolean).pop() || "");
  const description = resourceAnalysisValue(analysis, "summary", resourceAnalysisValue(analysis, "description", ""));
  const kind = resourceAnalysisValue(analysis, "kind", resourceAnalysisValue(analysis, "type", "skill"));
  const source = resourceAnalysisValue(analysis, "source", "github");
  const isWebReference = String(source).toLowerCase() !== "github";
  const runtimes = resourceValues(resourceAnalysisValue(analysis, "compatible_runtimes", resourceAnalysisValue(analysis, "runtime", resourceAnalysisValue(analysis, "runtimes", [])))).join(", ");
  const editor = `<label>Nombre<input name="name" required value="${escapeHtml(name)}" /></label><label>Descripción<textarea name="description" rows="3">${escapeHtml(description)}</textarea></label><div class="resource-form-grid"><label>Clasificación<input name="kind" value="${escapeHtml(kind)}" /></label><label>Fuente<input name="source" value="${escapeHtml(source)}" /></label></div>${isWebReference ? `<div class="resource-reference-note"><b>Referencia informativa</b><span>Se guardará para consulta e inspiración. No se instalará ni ejecutará nada.</span></div>` : `<label>Runtimes <small>separados por comas</small><input name="runtimes" value="${escapeHtml(runtimes)}" /></label>`}`;
  if (wizard.step === 2) {
    const candidate = resourceAnalysisObject(analysis);
    const warnings = resourceValues(analysis.warnings);
    body.innerHTML = `<form id="resourceEditForm" class="resource-wizard-form"><div class="resource-wizard-progress"><i class="done"></i><i class="active"></i><i></i></div><h3>Revisar metadatos</h3><p>${isWebReference ? "Confirma cómo quieres clasificar esta referencia." : "Edita lo detectado antes de preparar la instalación."}</p>${warnings.length ? `<div class="resource-analysis-warning"><b>Revisión recomendada</b>${warnings.map((warning) => `<span>${escapeHtml(warning)}</span>`).join("")}</div>` : ""}${editor}${isWebReference ? "" : `<div class="resource-analysis-matrix">${compatibilityCell(candidate, "claude", "Claude")}${compatibilityCell(candidate, "codex", "Codex")}</div>`}<div class="resource-wizard-actions"><button type="button" data-resource-wizard-back>Atrás</button><button type="submit" class="primary">Revisar alta</button></div></form>`;
    return;
  }
  const draft = wizard.draft || {};
  body.innerHTML = `<div class="resource-wizard-form"><div class="resource-wizard-progress"><i class="done"></i><i class="done"></i><i class="active"></i></div><h3>Confirmar alta</h3><p>Se registrará la referencia en ${wizard.mode === "radar" ? "Radar" : "el catálogo"}. No se instalará nada automáticamente.</p><dl class="resource-review"><div><dt>Destino</dt><dd>${wizard.mode === "radar" ? "Radar" : "Catálogo"}</dd></div><div><dt>Fuente</dt><dd>${escapeHtml(wizard.repoUrl)}</dd></div><div><dt>Nombre</dt><dd>${escapeHtml(draft.name)}</dd></div><div><dt>Clasificación</dt><dd>${escapeHtml(draft.kind || "—")}</dd></div></dl><div class="resource-wizard-actions"><button type="button" data-resource-wizard-back>Editar</button><button type="button" class="primary" data-resource-wizard-save>Guardar referencia</button></div></div>`;
}

async function analyzeResource(repoUrl, button) {
  const rawUrl = repoUrl.trim();
  const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  if (!/^https:\/\/[^\s/]+(?:\/[^\s]*)?$/i.test(normalizedUrl)) throw new Error("Introduce una URL HTTPS válida.");
  button.disabled = true;
  button.textContent = "Analizando…";
  try {
    state.resourceWizard.repoUrl = normalizedUrl.replace(/\/$/, "");
    const analysis = await api("/resources/analyze", { method: "POST", body: JSON.stringify({ repo_url: state.resourceWizard.repoUrl }) });
    if (analysis?.valid === false) throw new Error(resourceValues(analysis.warnings).join(" ") || "El repositorio no se puede registrar.");
    state.resourceWizard.analysis = analysis;
    state.resourceWizard.step = 2;
    renderResourceWizard();
  } finally {
    button.disabled = false;
  }
}

async function saveResourceWizard(button) {
  button.disabled = true;
  button.textContent = "Guardando…";
  try {
    const wizard = state.resourceWizard;
    const draft = state.resourceWizard.draft || {};
    const analyzed = resourceAnalysisObject(state.resourceWizard.analysis);
    if (wizard.mode === "radar") {
      await api("/resources/discovery/sources", {
        method: "POST",
        body: JSON.stringify({
          url: wizard.repoUrl,
          name: draft.name || analyzed.name || null,
          enabled: true,
        }),
      });
      setResourceModal(false);
      toast("Fuente añadida al Radar. Configura su conector para recibir publicaciones.");
      await refreshResourceDiscovery({ preserveSource: true, force: true });
      return;
    }
    const payload = {
      name: draft.name || analyzed.name,
      slug: analyzed.slug || String(draft.name || analyzed.name || "resource").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120),
      kind: draft.kind || analyzed.kind || analyzed.type,
      source: draft.source || analyzed.source || "github",
      summary: draft.description ?? analyzed.summary ?? analyzed.description ?? "",
      tags: resourceValues(analyzed.tags),
      requirements: analyzed.requirements || [],
      capabilities: analyzed.capabilities || [],
      compatible_runtimes: draft.runtimes || analyzed.compatible_runtimes || [],
      install_strategy: analyzed.install_strategy,
      metadata: { ...(analyzed.metadata || {}), inspiration_collection: "catalog" },
      repo_url: state.resourceWizard.repoUrl,
      analysis_token: state.resourceWizard.analysis?.analysis_token,
      confirmed: true,
    };
    Object.keys(payload).forEach((key) => payload[key] === undefined && delete payload[key]);
    const created = await api("/resources", { method: "POST", body: JSON.stringify(payload) });
    setResourceModal(false);
    toast("Recurso añadido a la biblioteca.");
    await refreshResources();
    const id = resourceId(created?.item || created?.resource || created);
    if (id) await selectResource(id);
  } finally {
    button.disabled = false;
  }
}

function selectedResourceTargets() {
  return $$('input[name="resource-target"]:checked', $("#resourceDetail")).map((input) => input.value);
}

function requestResourceOperation(id, action) {
  const targets = selectedResourceTargets();
  const destructive = action === "uninstall";
  state.resourceConfirm = { id, action, uiAction: action, targets };
  const title = action === "install" ? "Instalar recurso" : action === "verify" ? "Verificar recurso" : destructive ? "Desinstalar recurso" : "Actualizar recurso";
  $("#resourceConfirmTitle").textContent = title;
  $("#resourceConfirmCopy").textContent = destructive
    ? `Se desinstalará “${resourceLabel(state.resourceDetail)}” de ${targets.join(", ") || "todos los runtimes"}. El registro permanecerá en el historial.`
    : action === "verify"
      ? `Se comprobará la instalación de “${resourceLabel(state.resourceDetail)}” en ${targets.join(", ") || "sus destinos registrados"}.`
      : `${action === "install" ? "Se instalará" : "Se actualizará"} “${resourceLabel(state.resourceDetail)}” en ${targets.join(", ") || "todos los runtimes disponibles"}.`;
  $("#resourceConfirmAccept").textContent = destructive ? "Desinstalar" : action === "verify" ? "Verificar" : action === "install" ? "Instalar" : "Actualizar";
  $("#resourceConfirmAccept").classList.toggle("danger-confirm", destructive);
  $("#resourceConfirmModal").hidden = false;
  requestAnimationFrame(() => $("#resourceConfirmCancel")?.focus());
}

function closeResourceConfirm() {
  $("#resourceConfirmModal").hidden = true;
  state.resourceConfirm = null;
}

async function confirmResourceOperation(button) {
  const operation = state.resourceConfirm;
  if (!operation) return;
  const previousLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Procesando...";
  state.resourceOperationPending = { id: operation.id, action: operation.action };
  renderResourceDetail();
  try {
    const result = await api(`/resources/${encodeURIComponent(operation.id)}/operations`, { method: "POST", body: JSON.stringify({ action: operation.action, targets: operation.targets, confirmed: true }) });
    closeResourceConfirm();
    await selectResource(operation.id, { keepList: true, openInspector: false, keepFocus: true });
    if (result?.status !== "succeeded") {
      toast(`${result?.status === "denied" ? "Operacion denegada" : "La operacion ha fallado"}: ${result?.detail || "sin detalle"}`);
      return;
    }
    const labels = { uninstall: "Desinstalacion completada.", verify: "Verificacion completada.", install: "Instalacion completada.", update: "Actualizacion completada." };
    toast(labels[operation.uiAction] || "Operacion completada.");
  } finally {
    state.resourceOperationPending = null;
    button.disabled = false;
    button.textContent = previousLabel;
    renderResourceDetail();
  }
}

async function saveResourceVisibility(id, button) {
  const agentIds = $$('input[name="resource-agent"]:checked', $("#resourceDetail")).map((input) => input.value);
  button.disabled = true;
  try {
    const updated = await api(`/resources/${encodeURIComponent(id)}/visibility`, { method: "PUT", body: JSON.stringify({ agent_ids: agentIds }) });
    state.resourceDetail = updated?.item || updated?.resource || { ...state.resourceDetail, visible_agent_ids: agentIds };
    toast("Visibilidad actualizada.");
    renderResourceDetail(state.resourceDetail);
  } finally {
    button.disabled = false;
  }
}

async function reindexResourceChildren(id, button) {
  if (!id || !button) return;
  const previousLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Indexando...";
  try {
    const result = await api(`/resources/${encodeURIComponent(id)}/reindex`, {
      method: "POST",
      body: JSON.stringify({ confirmed: true }),
    });
    const indexed = Number(result?.indexed ?? result?.children_indexed ?? 0);
    toast(indexed ? `${indexed} elementos indexados.` : "Indexación completada sin elementos nuevos.");
    await refreshResources();
    await selectResource(id, { keepList: true, openInspector: false, keepFocus: true });
  } catch (error) {
    toast(`No se pudo indexar: ${error?.message || "error desconocido"}`);
  } finally {
    button.disabled = false;
    button.textContent = previousLabel;
  }
}

const INSPIRATION_SUBVIEWS = ["catalogo", "radar"];

export function setInspirationSubview(name) {
  const target = INSPIRATION_SUBVIEWS.includes(name) ? name : "catalogo";
  state.inspirationSubview = target;
  $$("#inspirationSubnav .insp-subtab").forEach((tab) => {
    const active = tab.dataset.inspSubview === target;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  INSPIRATION_SUBVIEWS.forEach((name2) => {
    const panel = document.getElementById(`subview-${name2}`);
    if (!panel) return;
    const active = name2 === target;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
  $("#resourceGroupSection")?.toggleAttribute("hidden", target !== "catalogo");
  $("#resourceRadarSection")?.toggleAttribute("hidden", target !== "radar");
}

const INSPIRATION_SIDEBAR_MIN = 220;

const INSPIRATION_SIDEBAR_MAX = 360;

function inspirationSidebarIsMobile() {
  return window.matchMedia("(max-width: 900px)").matches;
}

export function applyInspirationSidebarState() {
  const workspace = $("#resourceWorkbench");
  const splitter = $("#inspirationSidebarSplitter");
  const restore = $("#showInspirationSidebar");
  const scrim = $("#inspirationSidebarScrim");
  if (!workspace) return;
  const mobile = inspirationSidebarIsMobile();
  workspace.style.setProperty("--insp-sidebar-width", `${state.inspirationSidebarWidth}px`);
  workspace.classList.toggle("sidebar-hidden", !state.inspirationSidebarOpen);
  document.body.classList.toggle("insp-sidebar-mobile-open", mobile && state.inspirationSidebarOpen && state.activeView === "resources");
  if (splitter) {
    splitter.hidden = mobile || !state.inspirationSidebarOpen;
    splitter.setAttribute("aria-valuenow", String(state.inspirationSidebarWidth));
  }
  if (restore) restore.hidden = state.inspirationSidebarOpen;
  if (scrim) scrim.hidden = !(mobile && state.inspirationSidebarOpen && state.activeView === "resources");
}

function setInspirationSidebar(open, options = {}) {
  state.inspirationSidebarOpen = Boolean(open);
  localStorage.setItem("karajan-inspiration-sidebar-open", String(state.inspirationSidebarOpen));
  applyInspirationSidebarState();
  if (options.focus !== false) requestAnimationFrame(() => $(open ? "#hideInspirationSidebar" : "#showInspirationSidebar")?.focus({ preventScroll: true }));
}

function setInspirationSidebarWidth(width) {
  state.inspirationSidebarWidth = Math.min(INSPIRATION_SIDEBAR_MAX, Math.max(INSPIRATION_SIDEBAR_MIN, Math.round(width)));
  localStorage.setItem("karajan-inspiration-sidebar-width", String(state.inspirationSidebarWidth));
  applyInspirationSidebarState();
}

function initInspirationSidebar() {
  const splitter = $("#inspirationSidebarSplitter");
  if (inspirationSidebarIsMobile() && localStorage.getItem("karajan-inspiration-sidebar-open") === null) state.inspirationSidebarOpen = false;
  $("#hideInspirationSidebar")?.addEventListener("click", () => setInspirationSidebar(false));
  $("#showInspirationSidebar")?.addEventListener("click", () => setInspirationSidebar(true));
  $("#inspirationSidebarScrim")?.addEventListener("click", () => setInspirationSidebar(false));
  splitter?.addEventListener("pointerdown", (event) => {
    if (inspirationSidebarIsMobile() || event.button !== 0) return;
    state.resizingInspirationSidebar = true;
    splitter.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-inspiration-sidebar");
    event.preventDefault();
  });
  splitter?.addEventListener("pointermove", (event) => {
    if (!state.resizingInspirationSidebar) return;
    const left = $("#resourceWorkbench")?.getBoundingClientRect().left || 0;
    setInspirationSidebarWidth(event.clientX - left);
  });
  const stopResize = (event) => {
    if (!state.resizingInspirationSidebar) return;
    state.resizingInspirationSidebar = false;
    document.body.classList.remove("resizing-inspiration-sidebar");
    if (event?.pointerId !== undefined && splitter?.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
  };
  splitter?.addEventListener("pointerup", stopResize);
  splitter?.addEventListener("pointercancel", stopResize);
  splitter?.addEventListener("keydown", (event) => {
    const values = { ArrowLeft: state.inspirationSidebarWidth - 10, ArrowRight: state.inspirationSidebarWidth + 10, Home: INSPIRATION_SIDEBAR_MIN, End: INSPIRATION_SIDEBAR_MAX };
    if (!(event.key in values)) return;
    event.preventDefault();
    setInspirationSidebarWidth(values[event.key]);
  });
  window.addEventListener("resize", applyInspirationSidebarState);
  applyInspirationSidebarState();
}

function initInspirationEdgeAutoscroll() {
  const canvas = $("#resourceList");
  if (!canvas || canvas.dataset.edgeScrollBound) return;
  canvas.dataset.edgeScrollBound = "1";
  let direction = 0;
  let speed = 0;
  let frame = 0;
  const stop = () => {
    direction = 0;
    speed = 0;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
  const tick = () => {
    if (!direction || canvas.scrollWidth <= canvas.clientWidth) return stop();
    const before = canvas.scrollLeft;
    canvas.scrollLeft += direction * speed;
    if (canvas.scrollLeft === before) return stop();
    frame = requestAnimationFrame(tick);
  };
  canvas.addEventListener("pointermove", (event) => {
    if (canvas.classList.contains("panning")) return stop();
    if (event.pointerType && event.pointerType !== "mouse") return stop();
    if (!canvas.classList.contains("insp-resource-tree")) return stop();
    const rect = canvas.getBoundingClientRect();
    const zone = Math.min(110, Math.max(56, rect.width * 0.12));
    const x = event.clientX - rect.left;
    if (x < zone) {
      direction = -1;
      speed = Math.min(18, 4 + ((zone - x) / zone) * 14);
    } else if (x > rect.width - zone) {
      direction = 1;
      speed = Math.min(18, 4 + ((x - (rect.width - zone)) / zone) * 14);
    } else {
      return stop();
    }
    if (!frame) frame = requestAnimationFrame(tick);
  }, { passive: true });
  canvas.addEventListener("pointerleave", stop, { passive: true });

  let pan = null;
  canvas.addEventListener("pointerdown", (event) => {
    if (!canvas.classList.contains("insp-skill-tree") || event.button !== 0 || event.target.closest("button")) return;
    pan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop };
    canvas.setPointerCapture?.(event.pointerId);
    canvas.classList.add("panning");
    stop();
    event.preventDefault();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!pan || event.pointerId !== pan.id) return;
    canvas.scrollLeft = pan.left - (event.clientX - pan.x);
    canvas.scrollTop = pan.top - (event.clientY - pan.y);
  });
  const stopPan = (event) => {
    if (!pan || (event?.pointerId !== undefined && event.pointerId !== pan.id)) return;
    if (event?.pointerId !== undefined && canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    pan = null;
    canvas.classList.remove("panning");
  };
  canvas.addEventListener("pointerup", stopPan);
  canvas.addEventListener("pointercancel", stopPan);
  canvas.addEventListener("wheel", (event) => {
    if (!canvas.classList.contains("insp-skill-tree") || !event.ctrlKey) return;
    event.preventDefault();
    const inner = canvas.querySelector(".insp-constellation-canvas, .insp-skill-tree-canvas");
    if (!inner) return;
    const previous = Number(canvas.dataset.treeZoom || "1");
    const next = Math.min(1.8, Math.max(0.65, previous * (event.deltaY < 0 ? 1.1 : 0.9)));
    if (Math.abs(next - previous) < 0.001) return;
    const rect = canvas.getBoundingClientRect();
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    const worldX = (canvas.scrollLeft + cursorX) / previous;
    const worldY = (canvas.scrollTop + cursorY) / previous;
    canvas.dataset.treeZoom = next.toFixed(2);
    inner.style.zoom = String(next);
    requestAnimationFrame(() => {
      canvas.scrollLeft = Math.max(0, worldX * next - cursorX);
      canvas.scrollTop = Math.max(0, worldY * next - cursorY);
    });
  }, { passive: false });
  canvas.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.key === "0") {
      event.preventDefault();
      const inner = canvas.querySelector(".insp-constellation-canvas, .insp-skill-tree-canvas");
      if (inner) inner.style.zoom = "1";
      canvas.dataset.treeZoom = "1";
    }
  });
}

function validityPolicyDraft(form = $("#resourceCriteriaForm")) {
  if (!form) return null;
  const data = new FormData(form);
  return {
    stars_enabled: data.has("stars_enabled"),
    min_github_stars: Math.max(0, Math.min(100000000, Number(data.get("min_github_stars") || 0))),
    require_source_url: data.has("require_source_url"),
    require_detection_success: data.has("require_detection_success"),
    required_runtimes: data.getAll("required_runtimes").map(String),
    require_web_reference: data.has("require_web_reference"),
  };
}

function validityCountsMarkup(impact) {
  const states = impact?.states || {};
  return `<span><b>${Number(states.accepted || 0) + Number(states.accepted_override || 0)}</b> aceptados</span><span><b>${Number(states.pending_review || 0)}</b> pendientes</span><span><b>${Number(states.discarded || 0)}</b> descartados</span><span><b>${Number(impact?.manual_decisions_to_reset || 0)}</b> decisiones se reiniciarán</span>`;
}

function renderValidityPolicy() {
  const panel = $("#resourceCriteriaPanel");
  const policy = state.resourceValidityPolicy;
  if (!panel || !policy) return;
  const runtimeCount = resourceValues(policy.required_runtimes).length;
  const refreshRun = state.resourceRefreshRun;
  const refreshActive = ["queued", "running"].includes(refreshRun?.status);
  const refreshTotal = Number(refreshRun?.total || 0);
  const refreshProcessed = Number(refreshRun?.processed || 0);
  const refreshPercent = refreshActive && refreshTotal ? Math.min(100, Math.round((refreshProcessed / refreshTotal) * 100)) : 0;
  $("#resourceCriteriaSummary").innerHTML = `${policy.stars_enabled ? `>${Number(policy.min_github_stars).toLocaleString("es-ES")}` : "sin estrellas"} · ${runtimeCount} runtimes${refreshActive ? ` <i class="resource-refresh-loader" aria-hidden="true"></i><span class="resource-refresh-percent" aria-label="${refreshPercent}% del análisis completado">${refreshPercent}%</span>` : ""}`;
  panel.innerHTML = `<form id="resourceCriteriaForm" class="resource-criteria-form">
    <header><div><b>Artefactos válidos</b><small>Política global · versión ${Number(policy.version)}</small></div><button type="button" class="icon-btn" data-resource-criteria-close aria-label="Cerrar criterios">✕</button></header>
    <label class="criteria-row"><span><b>Estrellas de GitHub</b><small>Solo repositorios GitHub. Las referencias web están exentas.</small></span><input type="checkbox" name="stars_enabled" ${policy.stars_enabled ? "checked" : ""}></label>
    <label class="criteria-number"><span>Umbral mínimo</span><input type="number" name="min_github_stars" min="0" max="100000000" step="1000" value="${Number(policy.min_github_stars)}" ${policy.stars_enabled ? "" : "disabled"}></label>
    <label class="criteria-row"><span><b>Fuente HTTPS accesible</b><small>Debe existir y responder durante el análisis.</small></span><input type="checkbox" name="require_source_url" ${policy.require_source_url ? "checked" : ""}></label>
    <label class="criteria-row"><span><b>Detección satisfactoria</b><small>Las skills deben contener un SKILL.md.</small></span><input type="checkbox" name="require_detection_success" ${policy.require_detection_success ? "checked" : ""}></label>
    <fieldset><legend>Runtimes obligatorios · deben cumplirse todos</legend><label><input type="checkbox" name="required_runtimes" value="claude" ${policy.required_runtimes.includes("claude") ? "checked" : ""}> Claude</label><label><input type="checkbox" name="required_runtimes" value="codex" ${policy.required_runtimes.includes("codex") ? "checked" : ""}> ChatGPT / Codex</label></fieldset>
    <label class="criteria-row"><span><b>Referencia web</b><small>Exige una URL pública asociada al recurso.</small></span><input type="checkbox" name="require_web_reference" ${policy.require_web_reference ? "checked" : ""}></label>
    <div class="resource-criteria-impact" id="resourceCriteriaImpact" aria-live="polite">${validityCountsMarkup(state.resourceValidityImpact)}</div>
    <footer><button type="button" data-resource-criteria-defaults>Restaurar</button><button type="button" data-resource-criteria-revalidate>Revalidar ahora</button><button type="submit" class="primary">Guardar</button></footer>
  </form>`;
}

async function previewValidityPolicy() {
  const draft = validityPolicyDraft();
  if (!draft) return;
  state.resourceValidityImpact = await api("/resources/validity-policy/impact", { method: "POST", body: JSON.stringify(draft) });
  const target = $("#resourceCriteriaImpact");
  if (target) target.innerHTML = validityCountsMarkup(state.resourceValidityImpact);
}

async function loadValidityUi() {
  const policy = await api("/resources/validity-policy");
  state.resourceValidityPolicy = policy;
  state.resourceValidityImpact = await api("/resources/validity-policy/impact", {
    method: "POST",
    body: JSON.stringify({
      stars_enabled: policy.stars_enabled, min_github_stars: policy.min_github_stars,
      require_source_url: policy.require_source_url, require_detection_success: policy.require_detection_success,
      required_runtimes: policy.required_runtimes, require_web_reference: policy.require_web_reference,
    }),
  });
  $("#resourceReviewCount").textContent = String(state.resourceValidityImpact?.states?.pending_review || 0);
  renderValidityPolicy();
}

async function saveValidityPolicy(form) {
  const draft = validityPolicyDraft(form);
  const reset = Number(state.resourceValidityImpact?.manual_decisions_to_reset || 0);
  const acceptedOverrides = Number(state.resourceValidityImpact?.states?.accepted_override || 0);
  const discarded = Number(state.resourceValidityImpact?.states?.discarded || 0);
  const confirmReset = reset > 0
    ? window.confirm(`Cambiar la política reiniciará ${reset} decisiones humanas (${acceptedOverrides} aceptadas manualmente y ${discarded} descartadas). El historial se conservará. ¿Continuar?`)
    : true;
  if (!confirmReset) return;
  const result = await api("/resources/validity-policy", {
    method: "PUT",
    body: JSON.stringify({ ...draft, expected_version: state.resourceValidityPolicy.version, confirm_reset: reset > 0 }),
  });
  state.resourceValidityPolicy = result.policy;
  state.resourceValidityImpact = result.impact;
  toast("Política guardada y catálogo recalculado.");
  await refreshResources();
  await loadValidityUi();
}

function setAuxModal(id, open) {
  const modal = $(id);
  if (!modal) return;
  modal.hidden = !open;
  document.body.classList.toggle("modal-open", open || !$("#resourceReviewModal")?.hidden || !$("#resourceInventoryModal")?.hidden);
}

function renderReviewQueue() {
  const target = $("#resourceReviewBody");
  if (!target) return;
  const allItems = state.resourceReviewItems || [];
  const filter = state.resourceReviewFilter || "repositories";
  const items = allItems.filter((item) => {
    const validity = item?.metadata?.validity || {};
    if (validity.github_repository === true) return filter === "repositories";
    if (validity.github_repository === false) return filter === "web";
    const source = safeExternalUrl(validity.source_url || item.repo_url || item.source_url);
    return filter === (source && /(^|\\.)github\\.com$/i.test(new URL(source).hostname) ? "repositories" : "web");
  });
  const columnFilters = state.resourceReviewColumnFilters || (state.resourceReviewColumnFilters = { starsSort: "none", starsApprox: "", related: "all" });
  const relatedValue = (item) => { const taxonomy = item.metadata?.decision_taxonomy || {}; return [item.category, item.group, taxonomy.family, taxonomy.group, item.source, ...(item.tags || []), ...(item.capabilities || [])].filter(Boolean).join(" · ") || "Sin clasificar"; };
  const displayItems = items.filter((item) => {
    const validity = item?.metadata?.validity || {};
    const stars = Number.isFinite(Number(validity.github_stars)) ? Number(validity.github_stars) : null;
    const approximate = Number(columnFilters.starsApprox);
    const starsMatch = !Number.isFinite(approximate) || (stars !== null && Math.abs(stars - approximate) <= Math.max(10, approximate * 0.1));
    const relatedMatch = !columnFilters.related || columnFilters.related === "all" || relatedValue(item) === columnFilters.related;
    return starsMatch && relatedMatch;
  });
  const total = Number(state.resourceValidityImpact?.states?.pending_review || allItems.length);
  const selected = state.resourceReviewSelection || new Set();
  const ids = displayItems.map(resourceId);
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
  const sort = columnFilters.starsSort;
  if (sort === "asc" || sort === "desc") displayItems.sort((a, b) => { const av = Number(a?.metadata?.validity?.github_stars); const bv = Number(b?.metadata?.validity?.github_stars); const diff = (Number.isFinite(av) ? av : -1) - (Number.isFinite(bv) ? bv : -1); return sort === "asc" ? diff : -diff; });
  const rows = displayItems.map((item) => {
    const validity = item?.metadata?.validity || {};
    const source = safeExternalUrl(validity.source_url || item.repo_url || item.source_url);
    const rawStars = validity.github_stars;
    const stars = rawStars !== null && rawStars !== undefined && Number.isFinite(Number(rawStars)) ? Number(rawStars) : null;
    const starLabel = validity.github_repository === false ? "No aplica" : stars === null ? "No verificadas" : stars.toLocaleString("es-ES");
    const reason = (validity.reasons || []).join(" ") || "Requiere una decisión editorial.";
    const verificationError = item?.metadata?.source_verification_state === "rate_limited" || String(item?.metadata?.source_analysis_error || "").toLowerCase().includes("rate limit") ? " Verificación limitada temporalmente." : "";
    const id = resourceId(item);
    const related = relatedValue(item);
    let title = resourceLabel(item);
    try { const parts = source ? new URL(source).pathname.split("/").filter(Boolean) : []; if (parts.length >= 2 && new URL(source).hostname.toLowerCase() === "github.com") title = parts[0] + " / " + title; } catch (_) { /* source already sanitized */ }
    const titleCell = source ? "<a href=\"" + escapeHtml(source) + "\" target=\"_blank\" rel=\"noopener noreferrer\">" + escapeHtml(title) + "</a>" : "<span>" + escapeHtml(title) + "</span>";
    return "<tr data-review-resource=\"" + escapeHtml(id) + "\"><td class=\"review-select-col\"><input type=\"checkbox\" data-review-select=\"" + escapeHtml(id) + "\"" + (selected.has(id) ? " checked" : "") + " aria-label=\"Seleccionar " + escapeHtml(title) + "\"></td><td class=\"review-title\">" + titleCell + "<small>" + escapeHtml(source || "Referencia interna de Karajan") + "</small></td><td><strong class=\"resource-review-stars" + (stars === null ? " pending" : "") + " title=\"" + escapeHtml(stars === null && validity.github_repository !== false ? "Las estrellas aún no han podido verificarse" : "") + "\">" + escapeHtml(starLabel) + "</strong></td><td class=\"review-reason\">" + escapeHtml(reason + verificationError) + "</td><td class=\"review-related\" title=\"" + escapeHtml(related) + "\">" + escapeHtml(related) + "</td><td><button type=\"button\" class=\"primary\" data-resource-review-decision=\"accept\">Aceptar</button></td><td><button type=\"button\" data-resource-review-decision=\"discard\">Desechar</button></td></tr>";
  }).join("");
  const selectedCount = ids.filter((id) => selected.has(id)).length;
  $("#resourceReviewModal")?.querySelectorAll("[data-resource-review-bulk]").forEach((button) => {
    button.hidden = selectedCount === 0;
    button.disabled = selectedCount === 0;
  });
  const limit = total > allItems.length ? "<p class=\"resource-review-limit\">Mostrando " + allItems.length + " de " + total + " pendientes. Usa Revalidar para actualizar la cola completa.</p>" : "";
  const empty = "<div class=\"insp-empty\"><b>Cola al día</b><span>No hay artefactos pendientes en esta vista.</span></div>";
  const relatedOptions = [...new Set(items.map(relatedValue))].sort((a, b) => a.localeCompare(b, "es"));
  const starSelect = "<select data-review-column-filter=\"starsSort\" aria-label=\"Ordenar estrellas\"><option value=\"none\"" + (columnFilters.starsSort === "none" ? " selected" : "") + ">Orden</option><option value=\"desc\"" + (columnFilters.starsSort === "desc" ? " selected" : "") + ">Más</option><option value=\"asc\"" + (columnFilters.starsSort === "asc" ? " selected" : "") + ">Menos</option></select><input class=\"review-stars-approx\" type=\"number\" min=\"0\" step=\"1\" data-review-column-filter=\"starsApprox\" aria-label=\"Buscar estrellas aproximadas\" placeholder=\"≈ cantidad\" value=\"" + escapeHtml(columnFilters.starsApprox || "") + "\">";
  const relatedSelect = "<select data-review-column-filter=\"related\" aria-label=\"Filtrar por relación\"><option value=\"all\">Todos</option>" + relatedOptions.map((value) => "<option value=\"" + escapeHtml(value) + "\"" + (columnFilters.related === value ? " selected" : "") + ">" + escapeHtml(value.slice(0, 34)) + "</option>").join("") + "</select>";
  const table = "<div class=\"resource-review-table-wrap\"><table class=\"resource-review-table\"><thead><tr><th class=\"review-select-col\"><input type=\"checkbox\" data-review-select-all" + (allSelected ? " checked" : "") + " aria-label=\"Seleccionar todas las filas visibles\"></th><th>Título</th><th>Estrellas</th><th>Motivo</th><th>Relacionado con</th><th>Aceptar</th><th>Desechar</th></tr></thead><tbody>" + rows + "</tbody></table></div>";
  const toolbar = "<div class=\"resource-review-toolbar\"><span class=\"resource-review-selection-count\">" + selectedCount + " seleccionados · " + items.length + " para revisar</span><label class=\"resource-review-column-filter\"><span>Estrellas</span>" + starSelect + "</label><label class=\"resource-review-column-filter\"><span>Relacionado con</span>" + relatedSelect + "</label></div>";
  target.innerHTML = toolbar + limit + (displayItems.length ? table : empty);
}

async function openReviewQueue() {
  state.resourceReviewFilter = state.resourceReviewFilter || "repositories";
  state.resourceReviewSelection = new Set();
  $("#resourceReviewModal")?.querySelectorAll("[data-review-filter]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.reviewFilter === state.resourceReviewFilter)));
  const payload = await api("/resources/review?state=pending_review&limit=1000");
  state.resourceReviewItems = resourceItems(payload);
  renderReviewQueue();
  setAuxModal("#resourceReviewModal", true);
}

async function decideReviewResource(article, decision, button) {
  const id = article?.dataset.reviewResource;
  if (!id) return;
  const scrollTop = $("#resourceReviewBody .resource-review-table-wrap")?.scrollTop || 0;
  button.disabled = true;
  await api(`/resources/${encodeURIComponent(id)}/review`, { method: "POST", body: JSON.stringify({ decision }) });
  state.resourceReviewItems = state.resourceReviewItems.filter((item) => resourceId(item) !== id);
  state.resourceReviewSelection?.delete(id);
  renderReviewQueue();
  requestAnimationFrame(() => { const table = $("#resourceReviewBody .resource-review-table-wrap"); if (table) table.scrollTop = scrollTop; });
  const remaining = Math.max(0, Number(state.resourceValidityImpact?.states?.pending_review || 1) - 1);
  if (state.resourceValidityImpact?.states) state.resourceValidityImpact.states.pending_review = remaining;
  $("#resourceReviewCount").textContent = String(remaining);
  toast(decision === "accept" ? "Recurso aceptado manualmente." : "Recurso descartado.");
  await refreshResources();
}

async function decideSelectedReviewResources(decision) {
  const ids = [...(state.resourceReviewSelection || new Set())];
  if (!ids.length) return;
  const scrollTop = $("#resourceReviewBody .resource-review-table-wrap")?.scrollTop || 0;
  const results = await Promise.allSettled(ids.map((id) => api(`/resources/${encodeURIComponent(id)}/review`, { method: "POST", body: JSON.stringify({ decision }) })));
  const succeeded = ids.filter((_, index) => results[index].status === "fulfilled");
  if (!succeeded.length) throw new Error("No se pudo aplicar ninguna decisión.");
  const done = new Set(succeeded);
  state.resourceReviewItems = (state.resourceReviewItems || []).filter((item) => !done.has(resourceId(item)));
  state.resourceReviewSelection = new Set();
  renderReviewQueue();
  requestAnimationFrame(() => { const table = $("#resourceReviewBody .resource-review-table-wrap"); if (table) table.scrollTop = scrollTop; });
  if (state.resourceValidityImpact?.states) state.resourceValidityImpact.states.pending_review = Math.max(0, Number(state.resourceValidityImpact.states.pending_review || 0) - succeeded.length);
  $("#resourceReviewCount").textContent = String(state.resourceValidityImpact?.states?.pending_review || 0);
  toast(`${succeeded.length} recurso${succeeded.length === 1 ? "" : "s"} actualizado${succeeded.length === 1 ? "" : "s"}.`);
  await refreshResources();
  if (results.some((result) => result.status === "rejected")) toast("Algunas decisiones no pudieron aplicarse.");
}

function renderInventoryPreview(snapshot) {
  const target = $("#resourceInventoryBody");
  $("#resourceInventoryMeta").textContent = `${snapshot.total} filas · previsualización de ${snapshot.rows.length}`;
  const columns = ["name", "kind", "source", "stars", "category", "runtimes", "validity"];
  const labels = { name: "Nombre", kind: "Tipo", source: "Fuente", stars: "Estrellas", category: "Categoría", runtimes: "Compatibilidad", validity: "Estado" };
  target.innerHTML = `<div class="resource-inventory-table-wrap"><table><thead><tr>${columns.map((key) => `<th>${labels[key]}</th>`).join("")}</tr></thead><tbody>${snapshot.rows.map((row) => `<tr>${columns.map((key) => `<td>${escapeHtml(row[key] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div><footer><span>El archivo incluye las hojas Inventario y Política, también con pendientes y descartados.</span><a class="primary" href="${escapeHtml(apiUrl(snapshot.download_url))}" download="${escapeHtml(snapshot.filename)}">Descargar .xlsx</a></footer>`;
}

async function openInventoryPreview() {
  setAuxModal("#resourceInventoryModal", true);
  $("#resourceInventoryBody").innerHTML = `<div class="insp-empty"><b>Preparando inventario…</b><span>Se está congelando el snapshot para que vista previa y descarga coincidan.</span></div>`;
  const snapshot = await api("/resources/inventory", { method: "POST" });
  state.resourceInventorySnapshot = snapshot;
  renderInventoryPreview(snapshot);
}

export function initResourceLibraryControls() {
  initInspirationSidebar();
  initResourceInspectorResize();
  initInspirationEdgeAutoscroll();
  $("#addResourceBtn")?.addEventListener("click", openResourceWizard);
  $("#resourceCriteriaToggle")?.addEventListener("click", () => {
    const panel = $("#resourceCriteriaPanel");
    panel.hidden = !panel.hidden;
    $("#resourceCriteriaToggle").setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) requestAnimationFrame(() => panel.querySelector("input")?.focus());
  });
  $("#resourceCriteriaPanel")?.addEventListener("input", (event) => {
    if (event.target.name === "stars_enabled") {
      const threshold = $('#resourceCriteriaForm input[name="min_github_stars"]');
      if (threshold) threshold.disabled = !event.target.checked;
    }
    window.clearTimeout(state.resourceValidityPreviewTimer);
    state.resourceValidityPreviewTimer = window.setTimeout(() => previewValidityPolicy().catch((error) => toast(error.message)), 150);
  });
  $("#resourceCriteriaPanel")?.addEventListener("submit", (event) => {
    if (event.target.id !== "resourceCriteriaForm") return;
    event.preventDefault();
    saveValidityPolicy(event.target).catch((error) => toast(error.message));
  });
  $("#resourceCriteriaPanel")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-resource-criteria-close]")) {
      $("#resourceCriteriaPanel").hidden = true;
      $("#resourceCriteriaToggle").setAttribute("aria-expanded", "false");
    }
    if (event.target.closest("[data-resource-criteria-defaults]")) {
      state.resourceValidityPolicy = { ...state.resourceValidityPolicy, stars_enabled: true, min_github_stars: 10000, require_source_url: true, require_detection_success: true, required_runtimes: ["claude", "codex"], require_web_reference: true };
      renderValidityPolicy();
      previewValidityPolicy().catch((error) => toast(error.message));
    }
    const revalidate = event.target.closest("[data-resource-criteria-revalidate]");
    if (revalidate) {
      revalidate.disabled = true;
      api("/resources/validity-policy/revalidate", { method: "POST" })
        .then((run) => { state.resourceRefreshRun = run; renderValidityPolicy(); toast("Revalidación iniciada en segundo plano."); return pollResourceRefreshRun(run.run_id); })
        .catch((error) => { revalidate.disabled = false; toast(error.message); });
    }
  });
  $("#resourceReviewOpen")?.addEventListener("click", () => openReviewQueue().catch((error) => toast(error.message)));
  $("#resourceReviewModal")?.addEventListener("click", (event) => {
    if (event.target.id === "resourceReviewModal" || event.target.closest("[data-resource-review-close]")) return setAuxModal("#resourceReviewModal", false);
    const filter = event.target.closest("[data-review-filter]");
    if (filter) {
      state.resourceReviewFilter = filter.dataset.reviewFilter;
      $("#resourceReviewModal").querySelectorAll("[data-review-filter]").forEach((button) => button.setAttribute("aria-pressed", String(button === filter)));
      renderReviewQueue();
      return;
    }
    const bulk = event.target.closest("[data-resource-review-bulk]");
    if (bulk && !bulk.disabled) {
      bulk.disabled = true;
      decideSelectedReviewResources(bulk.dataset.resourceReviewBulk).catch((error) => { bulk.disabled = false; toast(error.message); });
      return;
    }
    const decision = event.target.closest("[data-resource-review-decision]");
    if (decision) decideReviewResource(decision.closest("[data-review-resource]"), decision.dataset.resourceReviewDecision, decision).catch((error) => { decision.disabled = false; toast(error.message); });
  });
  $("#resourceReviewModal")?.addEventListener("change", (event) => {
    const selection = state.resourceReviewSelection || (state.resourceReviewSelection = new Set());
    const columnFilter = event.target.closest("[data-review-column-filter]");
    if (columnFilter) {
      state.resourceReviewColumnFilters = state.resourceReviewColumnFilters || { stars: "all", related: "all" };
      state.resourceReviewColumnFilters[columnFilter.dataset.reviewColumnFilter] = columnFilter.value;
      renderReviewQueue();
      return;
    }
    const fieldFilter = event.target.closest("[data-review-field-filter]");
    if (fieldFilter) {
      state.resourceReviewFieldQuery = fieldFilter.value;
      renderReviewQueue();
      requestAnimationFrame(() => { const input = $("#resourceReviewBody")?.querySelector("[data-review-field-filter]"); if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } });
      return;
    }
    const selectAll = event.target.closest("[data-review-select-all]");
    if (selectAll) {
      $("#resourceReviewBody")?.querySelectorAll("[data-review-select]").forEach((checkbox) => selectAll.checked ? selection.add(checkbox.dataset.reviewSelect) : selection.delete(checkbox.dataset.reviewSelect));
      renderReviewQueue();
      return;
    }
    const checkbox = event.target.closest("[data-review-select]");
    if (!checkbox) return;
    if (checkbox.checked) selection.add(checkbox.dataset.reviewSelect); else selection.delete(checkbox.dataset.reviewSelect);
    renderReviewQueue();
  });
  $("#resourceReviewModal")?.addEventListener("input", (event) => {
    const columnFilter = event.target.closest("[data-review-column-filter]");
    if (columnFilter) {
      state.resourceReviewColumnFilters = state.resourceReviewColumnFilters || { starsSort: "none", starsApprox: "", related: "all" };
      state.resourceReviewColumnFilters[columnFilter.dataset.reviewColumnFilter] = columnFilter.value;
      renderReviewQueue();
      requestAnimationFrame(() => { const input = $("#resourceReviewBody")?.querySelector("[data-review-column-filter=\"starsApprox\"]"); if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } });
      return;
    }
    const fieldFilter = event.target.closest("[data-review-field-filter]");
    if (!fieldFilter) return;
    state.resourceReviewFieldQuery = fieldFilter.value;
    renderReviewQueue();
    requestAnimationFrame(() => { const input = $("#resourceReviewBody")?.querySelector("[data-review-field-filter]"); if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } });
  });
  $("#resourceInventoryOpen")?.addEventListener("click", () => openInventoryPreview().catch((error) => toast(error.message)));
  $("#resourceInventoryModal")?.addEventListener("click", (event) => {
    if (event.target.id === "resourceInventoryModal" || event.target.closest("[data-resource-inventory-close]")) setAuxModal("#resourceInventoryModal", false);
  });
  $("#closeResourceInspector")?.addEventListener("click", () => setResourceInspector(false));
  $("#resourceInspectorScrim")?.addEventListener("click", () => setResourceInspector(false));
  $("#inspirationSubnav")?.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-insp-subview]");
    if (tab) setInspirationSubview(tab.dataset.inspSubview);
  });
  $("#toggleResourceFilters")?.addEventListener("click", (event) => {
    const panel = $("#resourceFiltersPanel");
    if (!panel) return;
    panel.hidden = !panel.hidden;
    event.currentTarget.setAttribute("aria-expanded", String(!panel.hidden));
  });
  $("#resourceGroupTree")?.addEventListener("click", (event) => {
    const group = event.target.closest("[data-resource-group-filter]");
    if (!group) return;
    state.resourceGroupFilter = String(group.dataset.resourceGroupFilter || "");
    renderResourceGroupTree();
    renderResourceList();
    if (inspirationSidebarIsMobile()) setInspirationSidebar(false);
  });
  $("#openResourceGroupManager")?.addEventListener("click", () => setResourceGroupManager(true));
  $("#closeResourceGroupManager")?.addEventListener("click", () => setResourceGroupManager(false));
  $("#resourceGroupManagerScrim")?.addEventListener("click", () => setResourceGroupManager(false));
  $("#resourceGroupManagerBody")?.addEventListener("click", (event) => {
    const edit = event.target.closest("[data-resource-group-edit]");
    if (edit) return setResourceGroupManager(true, edit.dataset.resourceGroupEdit);
    if (event.target.closest("[data-resource-group-new]")) {
      state.editingResourceGroupId = "";
      renderResourceGroupManager();
      return requestAnimationFrame(() => $('#resourceGroupForm input[name="name"]')?.focus());
    }
    const remove = event.target.closest("[data-resource-group-delete]");
    if (remove) deleteResourceGroup(remove.dataset.resourceGroupDelete).catch((error) => toast(error.message));
  });
  $("#resourceGroupManagerBody")?.addEventListener("submit", (event) => {
    if (event.target.id !== "resourceGroupForm") return;
    event.preventDefault();
    saveResourceGroup(event.target).catch((error) => toast(error.message));
  });
  $("#toggleResourceSources")?.addEventListener("click", (event) => {
    const panel = $("#resourceSourcesPanel");
    if (!panel) return;
    panel.hidden = !panel.hidden;
    event.currentTarget.setAttribute("aria-expanded", String(!panel.hidden));
  });
  $("#resourceModalClose")?.addEventListener("click", () => setResourceModal(false));
  $("#resourceModal")?.addEventListener("click", (event) => { if (event.target.id === "resourceModal") setResourceModal(false); });
  $("#resourceConfirmCancel")?.addEventListener("click", closeResourceConfirm);
  $("#resourceConfirmAccept")?.addEventListener("click", (event) => confirmResourceOperation(event.currentTarget).catch((error) => toast(error.message)));
  $("#clearResourceFilters")?.addEventListener("click", () => {
    window.clearTimeout(state.resourceSearchTimer);
    state.resourceFilters = { query: "", kind: "", status: "", runtime: "", agent: "", source: "", structure: "" };
    $("#resourceSearch").value = "";
    renderResourceFilters();
    renderResourceList();
  });
  $("#resourceDiscoverySourceSelect")?.addEventListener("change", (event) => {
    state.resourceDiscoverySource = event.target.value;
    refreshResourceDiscovery({ preserveSource: true }).catch((error) => renderResourceDiscoveryUnavailable(error));
  });
  $("#saveResourceDiscoverySources")?.addEventListener("click", (event) => {
    saveResourceDiscoverySources(event.currentTarget).catch((error) => toast(error.message));
  });
  $("#saveResourceRefreshSettings")?.addEventListener("click", (event) => {
    saveResourceRefreshSettings(event.currentTarget).catch((error) => toast(error.message));
  });
  $("#runResourceRefresh")?.addEventListener("click", (event) => {
    runResourceRefresh(event.currentTarget).catch((error) => toast(error.message));
  });
  $("#resourceDiscoverySources")?.addEventListener("click", (event) => {
    const connect = event.target.closest("[data-discovery-source-connect]");
    if (connect) toast(`${connect.dataset.discoverySourceConnect === "threads" ? "Threads" : "Esta fuente"} requiere credenciales. Configúralas en el entorno antes de conectarla.`);
  });
  $("#view-resources")?.addEventListener("input", (event) => {
    if (event.target.id === "resourceSearch") {
      state.resourceFilters.query = event.target.value;
      window.clearTimeout(state.resourceSearchTimer);
      state.resourceSearchTimer = window.setTimeout(() => renderResourceList(), 150);
    }
  });
  $("#view-resources")?.addEventListener("keydown", (event) => {
    if (event.target.id !== "resourceSearch" || event.key !== "Enter") return;
    event.preventDefault();
    state.resourceFilters.query = event.target.value;
    window.clearTimeout(state.resourceSearchTimer);
    renderResourceList();
    if (state.resourceDisplayMode === "tree") {
      requestAnimationFrame(() => focusResourceSearchTarget());
    }
  });
  $("#view-resources")?.addEventListener("change", (event) => {
    const map = { resourceKindFilter: "kind", resourceStatusFilter: "status", resourceRuntimeFilter: "runtime", resourceAgentFilter: "agent", resourceSourceFilter: "source", resourceStructureFilter: "structure" };
    if (map[event.target.id]) {
      state.resourceFilters[map[event.target.id]] = event.target.value;
      renderResourceList();
    }
  });
  $("#view-resources")?.addEventListener("click", (event) => {
    const display = event.target.closest("[data-resource-display]");
    if (display) return setResourceDisplayMode(display.dataset.resourceDisplay);
    const treeFocus = event.target.closest("[data-resource-tree-focus]");
    if (treeFocus) return focusResourceTree(treeFocus.dataset.resourceTreeFocus);
    const radarAdd = event.target.closest("[data-radar-add-url]");
    if (radarAdd) {
      event.preventDefault();
      event.stopPropagation();
      return openResourceWizard({ mode: "catalog", repoUrl: radarAdd.dataset.radarAddUrl || "" });
    }
    const row = event.target.closest("[data-resource-id]");
    if (row) return void selectResource(row.dataset.resourceId);
    const agentSelection = event.target.closest("[data-resource-agent-select]");
    if (agentSelection) {
      const checked = agentSelection.dataset.resourceAgentSelect === "all";
      $$("input[name=\"resource-agent\"]", $("#resourceDetail")).forEach((input) => { input.checked = checked; });
      return;
    }
    if (event.target.closest("[data-resource-open-wizard]")) return openResourceWizard();
    if (event.target.closest("[data-resource-retry]")) return void refreshResources().catch(renderResourceError);
    const visibility = event.target.closest("[data-resource-save-visibility]");
    if (visibility) return void saveResourceVisibility(visibility.dataset.resourceSaveVisibility, visibility).catch((error) => toast(error.message));
    const reindex = event.target.closest("[data-resource-reindex]");
    if (reindex) return void reindexResourceChildren(reindex.dataset.resourceReindex, reindex);
    const operation = event.target.closest("[data-resource-operation]");
    if (operation) requestResourceOperation(operation.dataset.resourceOperationId, operation.dataset.resourceOperation);
  });
  $("#resourceModalBody")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-resource-wizard-cancel]")) setResourceModal(false);
    if (event.target.closest("[data-resource-wizard-back]")) {
      state.resourceWizard.step = Math.max(1, state.resourceWizard.step - 1);
      renderResourceWizard();
    }
    const save = event.target.closest("[data-resource-wizard-save]");
    if (save) saveResourceWizard(save).catch((error) => toast(error.message));
  });
  $("#resourceDetail")?.addEventListener("click", (event) => {
    const edit = event.target.closest("[data-resource-edit-description]");
    if (edit) {
      const editor = $("[data-resource-description-editor]", $("#resourceDetail"));
      const summary = $(".resource-summary-row", $("#resourceDetail"));
      if (summary) summary.hidden = true;
      if (editor) { editor.hidden = false; edit.setAttribute("aria-expanded", "true"); editor.querySelector("textarea")?.focus(); }
      return;
    }
    if (event.target.closest("[data-resource-description-cancel]")) {
      const editor = $("[data-resource-description-editor]", $("#resourceDetail"));
      const summary = $(".resource-summary-row", $("#resourceDetail"));
      const trigger = $("[data-resource-edit-description]", $("#resourceDetail"));
      if (editor) editor.hidden = true;
      if (summary) summary.hidden = false;
      if (trigger) trigger.setAttribute("aria-expanded", "false");
      return;
    }
    const saveDescription = event.target.closest("[data-resource-description-save]");
    if (saveDescription) saveResourceDescription(saveDescription.dataset.resourceDescriptionSave, saveDescription);
    const reanalyze = event.target.closest("[data-resource-reanalyze]");
    if (reanalyze) reanalyzeResource(reanalyze.dataset.resourceReanalyze, reanalyze);
  });
  $("#resourceModalBody")?.addEventListener("change", (event) => {
    if (event.target.matches('input[name="resource_mode"]')) {
      state.resourceWizard.mode = event.target.value === "radar" ? "radar" : "catalog";
      renderResourceWizard();
    }
  });
  $("#resourceModalBody")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.target.id === "resourceAnalyzeForm") {
      analyzeResource(new FormData(event.target).get("repo_url"), event.submitter).catch((error) => { toast(error.message); event.submitter.disabled = false; event.submitter.textContent = "Analizar"; });
    } else if (event.target.id === "resourceEditForm") {
      const form = Object.fromEntries(new FormData(event.target));
      state.resourceWizard.draft = { ...form, runtimes: String(form.runtimes || "").split(",").map((value) => value.trim()).filter(Boolean) };
      state.resourceWizard.step = 3;
      renderResourceWizard();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && state.activeView === "resources" && !event.metaKey && !event.ctrlKey && !/INPUT|TEXTAREA|SELECT/.test(event.target?.tagName || "")) {
      event.preventDefault();
      $("#resourceSearch")?.focus();
    }
    if (event.key === "Escape") {
      if (!$("#resourceReviewModal")?.hidden) setAuxModal("#resourceReviewModal", false);
      else if (!$("#resourceInventoryModal")?.hidden) setAuxModal("#resourceInventoryModal", false);
      else if (!$("#resourceCriteriaPanel")?.hidden) { $("#resourceCriteriaPanel").hidden = true; $("#resourceCriteriaToggle").setAttribute("aria-expanded", "false"); }
      else if (!$("#resourceConfirmModal")?.hidden) closeResourceConfirm();
      else if (!$("#resourceModal")?.hidden) setResourceModal(false);
      else if (state.resourceGroupManagerOpen) setResourceGroupManager(false);
      else if (state.resourceInspectorOpen) setResourceInspector(false);
      else if (inspirationSidebarIsMobile() && state.inspirationSidebarOpen) setInspirationSidebar(false);
    }
  });
}
