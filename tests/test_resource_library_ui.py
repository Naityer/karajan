from pathlib import Path


INDEX_HTML = Path("dashboard/static/index.html")
APP_JS = Path("dashboard/static/app.js")
STYLES_CSS = Path("dashboard/static/styles.css")

# The Inspiration styles live in a single trailing layer. Earlier revisions kept
# three stacked layers that redeclared the same selectors and overrode each
# other by source order; pinning the marker here keeps that from creeping back.
INSPIRATION_CSS_MARKER = "/* ── Inspiration ──"


def _inspiration_css() -> str:
    css = STYLES_CSS.read_text(encoding="utf-8")
    assert css.count(INSPIRATION_CSS_MARKER) == 1, "Inspiration CSS must stay a single layer"
    return css.split(INSPIRATION_CSS_MARKER, 1)[1]


def test_resource_library_is_between_agents_and_configuration() -> None:
    source = INDEX_HTML.read_text(encoding="utf-8")

    agents = source.index('data-view="agents"')
    resources = source.index('data-view="resources"')
    configuration = source.index('data-view="flow"')

    assert agents < resources < configuration
    assert 'data-view="resources">Inspiration</button>' in source
    assert '<section class="view" id="view-resources">' in source
    assert "<h1>Inspiration</h1>" not in source
    assert 'id="view-resources"' in source
    assert 'id="resourceSearch"' in source
    assert 'id="resourceDetail"' in source
    assert 'id="resourceDiscoveryFeed"' in source


def test_resource_library_uses_expected_api_contract() -> None:
    source = APP_JS.read_text(encoding="utf-8")

    assert 'for (const kind of ["skill", "capability", "reference"])' in source
    assert 'api(`/resources?kind=${kind}&limit=500&offset=${offset}`)' in source
    assert 'api("/resources/analyze"' in source
    assert 'const normalizedUrl' in source
    assert 'https://${rawUrl}' in source
    assert 'type="text" inputmode="url"' in source
    assert 'type="url"' not in source[source.find('id="resourceRepoUrl"'):source.find('id="resourceRepoUrl"') + 220]


def test_repository_refresh_controls_are_exposed_and_wired() -> None:
    html = INDEX_HTML.read_text(encoding="utf-8")
    script = APP_JS.read_text(encoding="utf-8")
    source = script
    assert 'id="resourceRefreshSection"' in html
    assert 'id="resourceRefreshDays"' in html
    assert 'id="radarRefreshMinutes"' in html
    resources_view = html[html.index('id="view-resources"'):html.index('id="view-flow"')]
    configuration_view = html[html.index('id="view-flow"'):]
    assert 'id="resourceRefreshSection"' not in resources_view
    assert 'id="resourceRefreshSection"' in configuration_view
    assert 'Frecuencias de actualizaci&oacute;n' in configuration_view
    assert '"/resources/refresh/settings"' in script
    assert '"/resources/refresh/run"' in script
    assert "radar_interval_minutes" in script
    assert 'api("/resources", { method: "POST"' in source
    assert '/operations`' in source
    assert '/visibility`' in source
    assert 'confirmed: true' in source
    assert 'visible_agent_ids' in source
    assert 'compatible_runtimes' in source
    assert 'analysis?.preview' in source
    assert 'state.resourceConfirm = { id, action, uiAction: action, targets }' in source


def test_resource_library_has_filters_shortcut_and_confirmations() -> None:
    html = INDEX_HTML.read_text(encoding="utf-8")
    js = APP_JS.read_text(encoding="utf-8")

    for filter_id in (
        "resourceKindFilter",
        "resourceStatusFilter",
        "resourceRuntimeFilter",
        "resourceAgentFilter",
        "resourceSourceFilter",
        "resourceStructureFilter",
    ):
        assert f'id="{filter_id}"' in html

    assert "<span>Contenido</span>" in html
    assert 'event.key === "/"' in js
    assert 'role="alertdialog"' in html
    assert 'primaryAction = hasInstallations || status === "installed" || status === "partial"' in js
    assert 'data-resource-operation="${primaryAction}"' in js
    assert 'data-resource-operation="verify"' in js
    assert 'data-resource-operation="uninstall"' in js


def test_resource_library_supports_live_updates_and_reduced_motion() -> None:
    js = APP_JS.read_text(encoding="utf-8")
    inspiration_css = _inspiration_css()

    assert 'startsWith("resource_")' in js
    assert 'refreshResources({ preserveSelection: true })' in js
    assert ".insp-shell" in inspiration_css
    assert "@media (max-width: 900px)" in inspiration_css
    assert "@media (prefers-reduced-motion: reduce)" in inspiration_css


def test_inspiration_uses_a_dense_sidebar_without_an_outer_panel() -> None:
    html = INDEX_HTML.read_text(encoding="utf-8")
    inspiration_css = _inspiration_css()

    assert "resource-library-shell" not in html
    assert "resource-library-shell" not in inspiration_css
    assert 'class="insp-workspace" id="resourceWorkbench"' in html
    assert 'class="insp-sidebar" aria-label="Explorar recursos"' in html
    assert "<h2>Explorar</h2>" in html
    sidebar = html.split('<aside class="insp-sidebar" aria-label="Explorar recursos">', 1)[1].split("</aside>", 1)[0]
    assert 'id="addResourceBtn">Nueva referencia</button>' in sidebar
    assert sidebar.index('id="resourceSearch"') < sidebar.index('id="resourceKpis"') < sidebar.index('id="addResourceBtn"')
    assert "Resource catalog" not in html
    assert "Repositorios, skills y herramientas disponibles para Claude y Codex." not in html
    assert 'id="resourceKpis"' in html
    assert 'id="toggleResourceFilters"' in html
    assert 'id="resourceFiltersPanel"' in html
    assert ".insp-workspace" in inspiration_css
    assert "grid-template-columns: var(--insp-sidebar-width) 7px minmax(0, 1fr)" in inspiration_css
    assert "#view-resources .insp-main { height: 100%; overflow-y: auto; }" in inspiration_css
    assert "#view-resources .insp-shell { height: 100%; }" in inspiration_css
    assert ".insp-workspace.sidebar-hidden .insp-main { grid-column: 1 / -1; width: 100%; padding-left: 0; }" in inspiration_css
    assert ".insp-workspace.sidebar-hidden .insp-sidebar { display: none;" in inspiration_css


def test_inspiration_groups_cards_and_exposes_discovery_hooks() -> None:
    html = INDEX_HTML.read_text(encoding="utf-8")
    js = APP_JS.read_text(encoding="utf-8")
    inspiration_css = _inspiration_css()

    for hook in (
        "resourceDiscoverySourceSelect",
        "resourceDiscoverySources",
        "saveResourceDiscoverySources",
        "resourceDiscoveryFeed",
        "resourceDiscoveryState",
    ):
        assert f'id="{hook}"' in html

    assert 'const RESOURCE_DOMAIN_ROOTS = [' in js
    assert 'class="insp-card' in js
    assert 'api("/resources/discovery/sources")' in js
    assert 'api("/resources/discovery/sources", { method: "PUT"' in js
    assert 'JSON.stringify({ source_ids: enabledSourceIds })' in js
    assert "selected_source_ids" in js
    assert 'api("/resources/discovery/feed")' in js
    assert 'api("/resources/discovery/sources", {' in js
    assert "savedRadarItems" not in js
    assert 'wizard.mode === "radar"' in js
    assert "radarSignalIsCatalogued" in js
    assert 'id: "threads", name: "Threads", connected: false' in js
    assert "Requiere credenciales" in js
    assert ".insp-card-grid" in inspiration_css
    assert ".insp-signal-grid" in inspiration_css
    assert "linear-gradient" not in inspiration_css


def test_resource_inspector_and_group_manager_drawers_are_isolated() -> None:
    html = INDEX_HTML.read_text(encoding="utf-8")
    css = _inspiration_css()

    assert 'id="resourceInspector"' in html
    assert 'id="resourceGroupManager"' in html
    assert "body.insp-drawer-open #resourceInspector" in css
    assert "body.insp-drawer-open #resourceInspectorScrim" in css
    assert "body.resource-group-manager-open #resourceGroupManager" in css
    assert "body.insp-drawer-open .insp-drawer {" not in css
    assert "body.insp-drawer-open .insp-drawer-scrim {" not in css
    assert "#resourceInspector .resource-detail-head { display: grid" in css


def test_resource_detail_exposes_intelligence_agents_and_real_operation_results() -> None:
    js = APP_JS.read_text(encoding="utf-8")
    css = _inspiration_css()

    assert "function resourceIntelligence(item)" in js
    assert "function resourceNestedComponents(item)" in js
    assert 'resource-capability-block' in js
    assert 'resource-component-list' in js
    assert 'data-resource-agent-select="all"' in js
    assert 'data-resource-agent-select="none"' in js
    assert 'result?.status !== "succeeded"' in js
    assert 'state.resourceOperationPending = { id: operation.id, action: operation.action }' in js
    assert 'installable && hasInstallations && !pending' in js
    assert ".resource-detail-v2" in css
    assert ".resource-runtime-list" in css
    assert ".resource-agent-toolbar" in css
    assert "@media (min-width: 901px)" in css
    assert "body.insp-drawer-open #resourceInspectorScrim" in css
    assert "background: transparent" in css


def test_catalog_switches_between_gallery_list_and_visual_tree_views() -> None:
    html = INDEX_HTML.read_text(encoding="utf-8")
    js = APP_JS.read_text(encoding="utf-8")
    css = _inspiration_css()

    assert 'id="resourceDisplaySwitch" role="group"' in html
    assert 'data-resource-display="gallery" aria-pressed="true">Galería' in html
    assert 'data-resource-display="list" aria-pressed="false">Lista' in html
    assert 'data-resource-display="tree" aria-pressed="false">Árbol' in html
    assert 'id="resourceTreeNav"' in html
    assert 'app.js?v=ui-15' in html
    assert 'localStorage.getItem("karajan-inspiration-display-v2")' in js
    assert 'localStorage.setItem("karajan-inspiration-display-v2", state.resourceDisplayMode)' in js
    assert 'if (state.resourceDisplayMode === "list") renderResourceListView(target, items)' in js
    assert 'else if (state.resourceDisplayMode === "tree") {' in js
    assert 'renderResourceSkillTree(target, treeItems)' in js
    assert 'if (resourceList?.classList.contains("insp-resource-tree") || resourceList?.classList.contains("insp-skill-tree"))' in js
    assert "function initInspirationEdgeAutoscroll()" in js
    assert "canvas.scrollLeft += direction * speed" in js
    assert 'canvas.addEventListener("pointerleave", stop' in js
    assert 'canvas.classList.contains("insp-skill-tree")' in js
    assert 'canvas.classList.add("panning")' in js
    assert 'if (!canvas.classList.contains("insp-resource-tree")) return stop();' in js
    assert 'class="insp-tree-family' in js
    assert 'class="insp-tree-resource' in js
    assert 'class="insp-constellation-canvas composite-tree"' in js
    assert 'class="insp-constellation-lines"' in js
    assert 'class="insp-constellation-node resource' in js
    assert "function renderResourceTreeNavigation(roots)" in js
    assert "function focusResourceTree(rootId)" in js
    assert 'if (state.resourceDisplayMode !== "tree") renderResourceTreeNavigation([]);' in js
    assert "data-resource-tree-root" in js
    assert "insp-tree-nav-pill" in js
    assert "Bosque de familias, grupos funcionales, artefactos y componentes" in js
    assert 'target.setAttribute("role", "tree")' in js
    assert ".insp-display-switch" in css
    assert ".insp-resource-tree" in css
    assert ".insp-skill-tree-canvas" in css
    assert ".insp-skill-branches::before" in css
    assert ".insp-tree-family-content" in css
    assert ".insp-resource-tree > .insp-tree-family > .insp-tree-family-content" in css
    assert "border-left: 0" in css
    assert "overflow-x: auto" in css
    assert "flex: 1 0 260px" in css
    assert "gap: 18px" in css
    assert "padding: 0 16px 24px" in css
    assert ".insp-resource-tree .insp-tree-branch { display: none; }" in css
    assert "font-size: 15px" in css
    assert "min-height: 36px" in css
    assert "margin-bottom: 18px" in css
    assert "font-size: 17px" in css
    assert "@media (max-width: 1180px)" in css
    assert "scroll-padding: 28px" in css
    assert "min-height: max(560px, calc(100vh - 170px))" in css
    assert "min-height: 760px" in css
    assert "touch-action: none" in css
    assert "cursor: grabbing" in css
    assert "height: calc(100% - 48px)" in css
    assert "width: 420px" in css
    assert "gap: 36px 58px" in css
    assert ".insp-skill-branch.direction-left" in css
    assert ".insp-skill-branch.direction-bottom" in css
    assert "width: 940px" in css
    assert "height: calc(100dvh - 158px)" in css
    assert "min-height: 1320px" in css
    assert "width: 1080px" in css
    assert "gap: 260px" in css
    assert ".insp-skill-lane {" in css
    assert ".insp-constellation-canvas" in css
    assert ".insp-constellation-edge.bridge" in css
    assert ".insp-constellation-node.root" in css
    assert "stroke-dasharray: 4 11" in css
    assert "border: 0" in css


def test_sidebar_search_is_a_single_responsive_control() -> None:
    css = _inspiration_css()

    assert ".insp-sidebar-search .insp-search:focus-within" in css
    assert ".insp-sidebar-search .insp-search input" in css
    assert "padding: 0 31px 0 29px" in css
    assert ".insp-sidebar-search .insp-search-ico," in css
    assert "position: absolute" in css


def test_inspiration_workspace_has_responsive_outer_spacing() -> None:
    css = _inspiration_css()

    assert "padding: clamp(12px, 1.6vw, 22px)" in css
    assert "#view-resources { overflow: auto; padding: 10px; }" in css


def test_catalog_reflects_editorial_taxonomy_and_refreshes_after_group_edits() -> None:
    js = APP_JS.read_text(encoding="utf-8")

    assert 'const RESOURCE_DOMAIN_ROOTS = [' in js
    assert '"rgrp_domain_development", "Desarrollo de software"' in js
    assert '"rgrp_domain_agents", "Agentes y automatización"' in js
    assert 'item?.metadata?.decision_taxonomy' in js
    assert 'state.resourceGroupView = buildResourceGroupView(state.resourceGroups)' in js
    assert 'resourceArtifactIdsForGroup(group.id).length' in js
    assert js.count("await refreshResourceGroups();\n  renderResourceList();") >= 2


def test_catalog_uses_composite_library_artifact_child_hierarchy() -> None:
    js = APP_JS.read_text(encoding="utf-8")
    css = _inspiration_css()

    assert "function resourceArtifact(item)" in js
    assert "function resourceArtifacts(items = state.resources || [])" in js
    assert "function filteredResourceArtifacts(options = {})" in js
    assert "const items = filteredResourceArtifacts();" in js
    assert "const total = resourceArtifacts().length;" in js
    assert "function buildCompositeTree(items)" in js
    assert 'class="insp-constellation-node root family-root' in js
    assert 'class="insp-constellation-node subgroup classification' in js
    assert 'class="insp-constellation-node subgroup artifact' in js
    assert "Bosque Composite" in js
    assert "familias, grupos funcionales, artefactos y componentes" in js
    assert 'class="resource-components-disclosure"' in js
    assert "componentCount" in js
    assert 'return "Galería indexable"' in js
    assert "componentTotal" in js
    assert "artefactos · ${componentTotal} componentes" in js
    assert 'api(`/resources?kind=${kind}&limit=500&offset=${offset}`)' in js
    assert ".resource-components-disclosure > summary" in css


def test_inspiration_sidebar_resource_structure_filter_is_wired() -> None:
    html = INDEX_HTML.read_text(encoding="utf-8")
    js = APP_JS.read_text(encoding="utf-8")

    assert 'id="resourceStructureFilter"><option value="">Todos</option>' in html
    assert 'resourceFilters: { query: "", kind: "", status: "", runtime: "", agent: "", source: "", structure: "" }' in js
    assert 'state.resourceFilters = { query: "", kind: "", status: "", runtime: "", agent: "", source: "", structure: "" }' in js
    assert '["kind", "status", "runtime", "agent", "source", "structure"]' in js
    assert 'fillResourceFilter("#resourceStructureFilter", "structure", "Todos los contenidos")' in js
    assert 'resourceStructureFilter: "structure"' in js


def test_inspiration_resource_structure_facet_uses_parent_and_child_relationships() -> None:
    js = APP_JS.read_text(encoding="utf-8")

    structure = js[js.index('if (key === "structure")'):js.index('return [];', js.index('if (key === "structure")'))]
    assert 'parent_resource_id || item?.parent_id' in structure
    assert 'return ["component"]' in structure
    assert 'resourceSupportsNestedIndex(item)' in structure
    assert 'return ["gallery"]' in structure
    assert 'resourceChildren(item).length' in structure
    assert 'return ["composite"]' in structure
    assert 'return ["standalone"]' in structure


def test_inspiration_filter_options_are_artifact_derived_counted_and_translated() -> None:
    js = APP_JS.read_text(encoding="utf-8")

    fill_filter = js[js.index("function fillResourceFilter"):js.index("function renderResourceFilters")]
    assert "resourceArtifacts().forEach((item) => {" in fill_filter
    assert "resourceFacet(item, key)" in fill_filter
    assert "counts.set(value, (counts.get(value) || 0) + 1)" in fill_filter
    assert 'localeCompare(resourceFacetLabel(key, b), "es")' in fill_filter
    assert '${escapeHtml(resourceFacetLabel(key, value))} (${counts.get(value)})' in fill_filter

    assert "function resourceFacetLabel(key, value)" in js
    assert 'skill: "Skill", capability: "Habilidad", reference: "Referencia"' in js
    assert 'return resourceStatusLabel(normalized)' in js
    assert 'gallery: "Galería indexable", composite: "Con elementos", standalone: "Individual", component: "Componente"' in js
    assert 'claude: "Claude", codex: "Codex"' in js
    assert 'if (key === "agent") return entityLabel(raw)' in js
    assert 'github: "GitHub", local: "Local", naityer: "Naityer"' in js


def test_inspiration_kpis_render_exactly_six_metrics_in_order() -> None:
    js = APP_JS.read_text(encoding="utf-8")
    css = _inspiration_css()

    kpis = js[js.index("function renderResourceKpis"):js.index("function resourceArtifactRole")]
    assert 'const available = all.filter((item) => resourceStatus(item) === "available").length' in kpis
    assert 'const galleries = all.filter((item) => resourceArtifactRole(item) === "Galería indexable").length' in kpis
    expected = '<span><b>${all.length}</b> artefactos</span><span><b>${components}</b> componentes</span><span><b>${installed}</b> instalados</span><span><b>${available}</b> disponibles</span><span><b>${galleries}</b> galerías</span><span><b>${signals}</b> señales</span>'
    assert expected in kpis
    assert 'grid-template-columns: repeat(3, minmax(0, 1fr))' in css
    assert "overflow-wrap: anywhere" in css


def test_inspiration_list_resource_rows_keep_compact_fact_hierarchy() -> None:
    js = APP_JS.read_text(encoding="utf-8")
    css = _inspiration_css()

    row = js[js.index("function resourceTreeItem(item)"):js.index("function resourceArtifactGroupId", js.index("function resourceTreeItem(item)"))]
    list_css = css[css.index("/* Lista: jerarquía tipográfica"):css.index("/* Encabezado del catálogo")]

    assert '<span class="insp-tree-kind" aria-hidden="true">' in row
    assert 'const childCount = resourceLineage(item).childCount' in row
    assert 'const childLabel = `${childCount} ${childCount === 1 ? "elemento" : "elementos"}`' in row
    assert '<span class="insp-tree-resource-copy"><span class="insp-tree-resource-primary"><b>${escapeHtml(resourceLabel(item))}</b><span class="insp-tree-element-count">${escapeHtml(childLabel)}</span></span><span class="insp-tree-resource-secondary"><span class="insp-tree-role">${escapeHtml(resourceArtifactRole(item))}</span>${resourceStatusPill(status)}</span></span>' in row
    assert "<small>" not in row
    assert "insp-tree-meta" not in row
    assert row.index('class="insp-tree-kind"') < row.index('class="insp-tree-resource-copy"') < row.index('class="insp-tree-resource-primary"') < row.index('class="insp-tree-resource-secondary"') < row.index("${resourceStatusPill(status)}")

    assert "grid-template-columns: 23px minmax(0, 1fr) auto" in css
    assert "grid-template-columns: 28px minmax(0, 1fr)" in css
    assert "min-height: 48px" in css
    assert "padding: 6px 7px" in css
    assert "#view-resources .insp-resource-tree .insp-tree-resource-primary," in css
    assert "#view-resources .insp-resource-tree .insp-tree-resource-secondary" in css
    assert "justify-content: space-between" in css
    assert "gap: 10px" in css
    assert "#view-resources .insp-resource-tree .insp-tree-element-count," in css
    assert "font: 600 8.5px/1.2 var(--mono)" in css
    assert "white-space: nowrap" in css
    assert "#view-resources .insp-resource-tree .insp-tree-resource .insp-pill" in css
    assert "font-size: 9px" in css
    assert "#view-resources .insp-resource-tree .insp-tree-resource-facts .insp-tree-role" not in list_css


def test_inspiration_subnav_splits_catalog_from_radar() -> None:
    html = INDEX_HTML.read_text(encoding="utf-8")
    js = APP_JS.read_text(encoding="utf-8")

    catalog = html.index('id="subview-catalogo"')
    radar = html.index('id="subview-radar"')
    inspector = html.index('id="resourceInspector"')
    assert catalog < radar < inspector

    assert 'role="tablist"' in html
    assert 'data-insp-subview="catalogo"' in html
    assert 'data-insp-subview="radar"' in html
    assert 'const INSPIRATION_SUBVIEWS = ["catalogo", "radar"]' in js
    assert 'tab.setAttribute("aria-selected", String(active))' in js
    assert "setInspirationSubview(state.inspirationSubview)" in js


def test_catalog_sidebar_contains_search_filters_groups_and_radar_access() -> None:
    html = INDEX_HTML.read_text(encoding="utf-8")
    css = _inspiration_css()

    sidebar = html.index('class="insp-sidebar"')
    search = html.index('id="resourceSearch"')
    filters = html.index('id="resourceFiltersPanel"')
    groups = html.index('id="resourceGroupTree"')
    radar_access = html.index('class="insp-sidebar-section insp-radar-access"')
    main = html.index('class="insp-main"')
    resources = html.index('id="resourceList"')
    assert sidebar < search < filters < groups < radar_access < main < resources
    assert "insp-filter-panel" in css
    assert ".resource-group-tree" in css


def test_resource_groups_use_the_final_backend_contract_and_unique_assignments() -> None:
    html = INDEX_HTML.read_text(encoding="utf-8")
    js = APP_JS.read_text(encoding="utf-8")

    assert 'id="resourceGroupManager" aria-label="Gestionar grupos" aria-hidden="true" inert' in html
    assert 'api("/resource-groups")' in js
    assert '`/resource-groups/${encodeURIComponent(state.editingResourceGroupId)}`' in js
    assert '`/resource-groups/${encodeURIComponent(id)}?${query}`' in js
    assert 'new URLSearchParams({ confirmed: "true" })' in js
    assert 'query.set("move_to_id", moveToId)' in js
    assert 'JSON.stringify({ assignments })' in js
    assert 'group_id: groupId, resource_ids: resourceIds' not in js
    assert 'label: "Sin clasificar"' in js
    assert "resourceGroupDepth(group)" in js
    assert '!isResourceGroupDescendant(group.id, state.editingResourceGroupId)' in js
    assert 'window.confirm("¿Eliminar este grupo?' in js


def test_inspiration_sidebar_is_hideable_resizable_and_mobile_overlay() -> None:
    html = INDEX_HTML.read_text(encoding="utf-8")
    js = APP_JS.read_text(encoding="utf-8")
    css = _inspiration_css()

    assert 'id="hideInspirationSidebar"' in html
    assert 'id="showInspirationSidebar"' in html
    assert 'id="inspirationSidebarSplitter" role="separator"' in html
    assert 'aria-valuemin="220" aria-valuemax="360"' in html
    assert 'id="inspirationSidebarScrim"' in html
    assert 'localStorage.setItem("karajan-inspiration-sidebar-width"' in js
    assert 'ArrowLeft: state.inspirationSidebarWidth - 10' in js
    assert 'ArrowRight: state.inspirationSidebarWidth + 10' in js
    assert 'splitter.setPointerCapture(event.pointerId)' in js
    assert 'window.matchMedia("(max-width: 900px)")' in js
    assert "body.insp-sidebar-mobile-open .insp-sidebar" in css
    assert "cursor: col-resize" in css


def test_inspiration_detail_is_an_overlay_drawer_and_starts_closed() -> None:
    html = INDEX_HTML.read_text(encoding="utf-8")
    js = APP_JS.read_text(encoding="utf-8")
    inspiration_css = _inspiration_css()

    assert 'id="resourceInspector" aria-label="Inspector de recurso" aria-hidden="true" inert' in html
    assert 'id="closeResourceInspector" aria-label="Cerrar inspector"' in html
    assert 'id="resourceInspectorScrim"' in html
    assert 'id="resourceInspectorSplitter" role="separator"' in html
    assert 'aria-controls="resourceInspector"' in js
    assert 'aria-expanded="${selected}"' in js
    assert 'setResourceInspector(true, { focus: false })' in js
    assert 'setResourceInspector(false)' in js
    assert 'else if (state.resourceInspectorOpen) setResourceInspector(false)' in js
    assert 'inspector.inert = !state.resourceInspectorOpen' in js
    assert 'document.body.classList.toggle("insp-drawer-open"' in js
    assert 'localStorage.getItem("karajan-inspiration-inspector-width")' in js
    assert 'localStorage.setItem("karajan-inspiration-inspector-width"' in js
    assert "function initResourceInspectorResize()" in js
    assert "setResourceInspectorWidth(window.innerWidth - event.clientX)" in js
    assert 'resourceId(state.resources[0])' not in js

    # Overlay, not a grid column: the catalogue must not reflow when it opens.
    assert ".insp-drawer {" in inspiration_css
    assert "position: fixed" in inspiration_css
    assert "transform: translateX(100%)" in inspiration_css
    assert "body.insp-drawer-open #resourceInspector" in inspiration_css
    assert ".insp-inspector-splitter" in inspiration_css
    assert "width: min(var(--insp-inspector-width, 420px)" in inspiration_css


def test_configuration_shows_durable_full_catalog_refresh_progress() -> None:
    html = INDEX_HTML.read_text(encoding="utf-8")
    js = APP_JS.read_text(encoding="utf-8")
    css = _inspiration_css()

    assert 'id="resourceRefreshProgress"' in html
    assert 'id="resourceRefreshProgressBar"' in html
    assert "Reanalizar cat&aacute;logo completo" in html
    assert "/resources/refresh/runs/" in js
    assert '"resource_refresh_progress"' in js
    assert '["queued", "running"].includes(run?.status)' in js
    assert ".config-refresh-progress[hidden]" in css
