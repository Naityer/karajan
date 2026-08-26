from pathlib import Path


class _ConcatenatedSource:
    """Como un `Path`, pero concatena varios (ver test_resource_library_ui.py).

    `app.js` (nota "Plan de mejora", §18) se partió en
    `dashboard/static/src/modules/*.js`; estos tests comprueban comportamiento
    del dashboard, no la ubicación de un fichero concreto.
    """

    def __init__(self, *paths: Path) -> None:
        self._paths = paths

    def read_text(self, encoding: str = "utf-8") -> str:
        return "\n\n".join(p.read_text(encoding=encoding) for p in self._paths)


APP_JS = _ConcatenatedSource(*sorted(Path("dashboard/static/src/modules").glob("*.js")))
STYLES_CSS = Path("dashboard/static/styles.css")
INDEX_HTML = Path("dashboard/static/index.html")


def test_decision_drawer_exposes_searchable_catalog_actions() -> None:
    source = APP_JS.read_text(encoding="utf-8")

    assert "decisionCatalogQuery" in source
    assert "data-decision-catalog-search" in source
    assert "data-decision-agent-add" in source
    assert "data-decision-agent-remove" in source
    assert "decision-agent-action" in source
    assert "if (!query) return activeProviders.has(provider.name)" in source
    assert 'activeArchitectureProviderNames().has("openclaw")' not in source
    assert 'provider.name !== "openclaw"' in source
    assert "openclaw-drawer-card" in source


def test_decision_agent_buttons_are_small_round_controls() -> None:
    source = STYLES_CSS.read_text(encoding="utf-8")

    assert "flex: 0 0 22px" in source
    assert "width: 22px" in source
    assert "height: 22px" in source
    assert "border-radius: 999px" in source
    assert "position: absolute" in source
    assert "top: 8px" in source
    assert "right: 8px" in source
    action_block = source.split(".decision-agent-action {", 1)[1].split("}", 1)[0]
    assert "border: 0" in action_block
    assert "background: transparent" in action_block


def test_decision_roles_and_levels_are_removable() -> None:
    source = APP_JS.read_text(encoding="utf-8")

    assert "role-tag-remove" in source
    assert "data-remove-role" in source
    assert "removeRoleTag(entity" in source
    assert "occupied ? \"disabled\"" not in source


def test_decision_canvas_profile_controls_are_accessible_and_inline() -> None:
    html = INDEX_HTML.read_text(encoding="utf-8")
    css = STYLES_CSS.read_text(encoding="utf-8")

    assert 'aria-label="Perfil de lienzo activo"' in html
    assert 'id="canvasProfileSelect"' in html
    assert 'id="setDefaultCanvasProfile"' in html
    assert 'aria-pressed="false"' in html
    assert 'aria-haspopup="dialog"' in html
    assert 'role="dialog" aria-label="Opciones del perfil"' in html
    assert 'id="renameCanvasProfile" role="menuitem"' in html
    assert 'id="canvasProfileName"' in html
    assert 'id="saveCanvasProfileName"' in html
    assert 'id="cancelCanvasProfileName"' in html
    assert 'id="duplicateCanvasProfile"' in html
    assert 'id="deleteCanvasProfile"' in html
    assert 'id="activateSimpleCanvasPreset"' in html
    assert ".profile-menu-panel :is(input, button):focus-visible" in css


def test_decision_profile_menu_uses_progressive_inline_rename() -> None:
    html = INDEX_HTML.read_text(encoding="utf-8")
    source = APP_JS.read_text(encoding="utf-8")

    assert '>Renombrar</button>' in html
    assert '>Duplicar</button>' in html
    assert '<span class="profile-menu-action-label">Eliminar</span>' in html
    assert '>Crear perfil simple</button>' in html
    assert 'id="profileRenameEditor" hidden' in html
    assert 'if (event.key === "Enter")' in source
    assert 'else if (event.key === "Escape")' in source
    assert 'setProfileMenuOpen(false)' in source


def test_decision_canvas_profiles_preserve_active_projection_and_preset() -> None:
    source = APP_JS.read_text(encoding="utf-8")

    assert 'CURRENT_CANVAS_PROFILE_NAME = "Esquema actual"' in source
    assert 'SIMPLE_CANVAS_PRESET_NAME = "Qwen · Claude + ChatGPT"' in source
    assert "snapshotActiveCanvasProfile()" in source
    assert 'button.textContent = "Confirmar"' in source
    assert "button?.dataset.confirmDelete !== state.activeCanvasProfileId" in source
    assert 'scheduleRoutingSave(`Perfil activo:' in source
    assert 'scheduleRoutingSave("Perfil duplicado.' in source
    assert 'scheduleRoutingSave(`Perfil eliminado:' in source
    assert 'scheduleRoutingSave("Preset Qwen' in source
    assert "active_profile_id: state.activeCanvasProfileId" in source
    assert "default_profile_id: state.defaultCanvasProfileId" in source
    assert "profiles: state.canvasProfiles" in source
    assert 'provider: "ollama-qwen"' in source
    assert 'capabilities: ["Planner", "Router"]' in source
    assert 'provider: "claude-cli"' in source
    assert 'provider: "codex"' in source
    assert 'levels: ["level_1_simple", "level_2_moderate", "level_3_intermediate"]' in source
    assert 'levels: ["level_4_complex", "level_5_critical"]' in source
    rename_block = source.split("export function renameActiveCanvasProfile", 1)[1].split(
        "export function duplicateActiveCanvasProfile", 1
    )[0]
    assert "persistEntityState()" in rename_block


def test_decision_profiles_center_content_and_keep_default_separate() -> None:
    source = APP_JS.read_text(encoding="utf-8")

    assert "export function centerDiagramOnContent()" in source
    assert 'nodes = $$("#diagramLayer .node")' in source
    assert "requestAnimationFrame(() => centerDiagramOnContent())" in source
    assert "export function setActiveCanvasProfileAsDefault()" in source
    assert "state.defaultCanvasProfileId = profile.id" in source
    assert "layout.default_profile_id" in source
    assert "state.activeCanvasProfileId ? layout.active_profile_id : defaultId" in source
    assert 'profile.id === state.defaultCanvasProfileId ? " · predeterminado"' in source
    assert "removed.id === state.defaultCanvasProfileId" in source
