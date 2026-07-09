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
    assert "aider" not in cli
    codex = catalog.get_provider("codex")
    assert codex.cli_command == "codex exec {model}"


def test_install_skill_already_installed(monkeypatch, tmp_path) -> None:
    (tmp_path / "ponytail").mkdir()
    monkeypatch.setattr(skills_catalog, "SKILLS_DIR", tmp_path)
    result = skills_catalog.install_skill("ponytail")
    assert result.ok
    assert "ya está instalada" in result.detail


def test_install_skill_unknown_name(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(skills_catalog, "SKILLS_DIR", tmp_path)
    result = skills_catalog.install_skill("not-a-real-skill")
    assert not result.ok


def test_install_skill_without_repo_url(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(skills_catalog, "SKILLS_DIR", tmp_path)
    # `security-review` is a built-in skill with no repo_url — nothing to fetch.
    result = skills_catalog.install_skill("security-review")
    assert not result.ok


def test_install_skill_local_source_copies_skill_and_command(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(skills_catalog, "SKILLS_DIR", tmp_path / "skills")
    monkeypatch.setattr(skills_catalog, "COMMANDS_DIR", tmp_path / "commands")
    result = skills_catalog.install_skill("karajan")
    assert result.ok
    assert (tmp_path / "skills" / "karajan" / "SKILL.md").is_file()
    assert (tmp_path / "commands" / "karajan.md").is_file()


def test_karajan_local_skill_in_catalog() -> None:
    by_name = {s.name: s for s in skills_catalog.list_skills()}
    assert "karajan" in by_name
    assert "task-router" in by_name


def test_token_budget_for_known_and_unknown_provider() -> None:
    assert catalog.token_budget_for("claude-cli") > 0
    assert catalog.token_budget_for("ollama-qwen") == 0
