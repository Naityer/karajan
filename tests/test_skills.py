from app import catalog, skills_catalog
from app.models import Backend


def test_skill_catalog_has_claude_defaults() -> None:
    names = {s.name for s in skills_catalog.list_skills()}
    assert {"repo-analyzer", "security-review", "ponytail"} <= names


def test_installed_skills_are_recommended(monkeypatch, tmp_path) -> None:
    (tmp_path / "ponytail").mkdir()
    monkeypatch.setattr(skills_catalog, "SKILLS_DIR", tmp_path)
    by_name = {s.name: s for s in skills_catalog.list_skills()}
    assert by_name["ponytail"].installed and by_name["ponytail"].recommended
    assert not by_name["repo-analyzer"].installed
    assert by_name["repo-analyzer"].install_command


def test_codex_in_catalog() -> None:
    cli = {p.name for p in catalog.providers_for_backend(Backend.CLI)}
    assert "codex" in cli
    codex = catalog.get_provider("codex")
    assert codex.cli_command == "codex exec {model}"
