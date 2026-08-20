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
