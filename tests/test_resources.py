from __future__ import annotations

import subprocess
from pathlib import Path

import httpx

from app.github_resources import GitHubResourceAnalyzer, validate_github_repository_url
from app.modules.inspiration.api import _github_resource_parts
from app.models import ResourceCreateRequest, ResourceItem, ResourceKind, ResourceOperationRequest, SkillInfo
from app.naityer_resources import NaityerAdapter
from app.nested_resources import ItsFreeAdapter, TooolsDesignAdapter
from app.resource_installer import SkillRepositoryManager
from app.resource_library import ResourceStore, seed_resource_library


def _item(store: ResourceStore, **updates) -> ResourceItem:
    values = {
        "slug": "example-skill",
        "name": "Example Skill",
        "kind": ResourceKind.SKILL,
        "source": "test",
        "repo_url": "https://github.com/example/example-skill",
        "summary": "Example searchable resource",
        "tags": ["Python", "python"],
        "capabilities": ["Testing"],
        "compatible_runtimes": ["codex", "claude"],
        "install_strategy": "github_skill",
    }
    values.update(updates)
    return store.upsert(ResourceItem(**values))


def test_resource_store_crud_search_visibility_and_audit(tmp_path) -> None:
    store = ResourceStore(tmp_path / "resources.db")
    item = _item(store)

    assert store.get(item.id).slug == "example-skill"
    assert store.search("searchable python")[0].id == item.id
    visible = store.set_visibility(item.id, ["agent-b", "agent-a", "agent-a"])
    assert visible.visible_agent_ids == ["agent-a", "agent-b"]

    operation = store.record_operation(
        resource_id=item.id, action="verify", status="succeeded", targets=["codex"]
    )
    assert store.list_operations(item.id)[0].operation_id == operation.operation_id


def test_search_falls_back_when_fts_is_unavailable(tmp_path) -> None:
    store = ResourceStore(tmp_path / "resources.db")
    item = _item(store)
    store._fts_available = False
    assert store.search("Example")[0].id == item.id


def test_complete_catalog_is_not_truncated_by_component_page_limit(tmp_path) -> None:
    store = ResourceStore(tmp_path / "resources.db")
    for index in range(505):
        store.upsert(ResourceItem(
            slug=f"item-{index:03d}", name=f"Item {index:03d}",
            kind=ResourceKind.REFERENCE, source="test",
        ))

    assert len(store.list_resources(limit=500)) == 500
    assert len(store.list_all_resources()) == 505


def test_create_rejects_duplicate_kind_and_slug(tmp_path) -> None:
    store = ResourceStore(tmp_path / "resources.db")
    request = ResourceCreateRequest(
        slug="same", name="Same", kind=ResourceKind.REFERENCE, source="manual"
    )
    store.create(request)
    try:
        store.create(request)
    except ValueError as exc:
        assert "already exists" in str(exc)
    else:
        raise AssertionError("duplicate resource was accepted")


def test_seed_is_idempotent_and_includes_all_resource_kinds(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(
        "app.skills_catalog.list_skills",
        lambda: [
            SkillInfo(
                name="seed-skill", description="Seeded skill", installed=False,
                recommended=False, applies_to=["codex"], repo_url="https://github.com/acme/seed-skill",
            )
        ],
    )
    installers = tmp_path / "installers"
    installers.mkdir()
    (installers / "sample.ps1").write_text("@{ Key = 'sample' }", encoding="utf-8")
    (installers / "README.md").write_text(
        "| Componente | Repositorio | Finalidad |\n"
        "| --- | --- | --- |\n"
        "| Sample | [acme/sample](https://github.com/acme/sample) | Sample capability. |\n",
        encoding="utf-8",
    )
    store = ResourceStore(tmp_path / "resources.db")

    seed_resource_library(store, installers)
    seed_resource_library(store, installers)

    resources = store.list_resources(limit=50)
    assert len(resources) == 27
    assert {item.kind for item in resources} == {
        ResourceKind.SKILL, ResourceKind.CAPABILITY, ResourceKind.REFERENCE,
    }
    assert store.get_by_slug("sample", ResourceKind.CAPABILITY).repo_url == "https://github.com/acme/sample"
    assert store.get_by_slug("circle-project-management", ResourceKind.REFERENCE).repo_url == "https://github.com/ln-dev7/circle"
    assert store.get_by_slug("refactoring-guru", ResourceKind.REFERENCE).source_url == "https://refactoring.guru/design-patterns/catalog"
    assert store.get_by_slug("toools-design", ResourceKind.REFERENCE).source_url == "https://www.toools.design/"
    assert store.get_by_slug("gradient-studio", ResourceKind.REFERENCE).source_url == "https://gradientsaas.blogspot.com/"
    assert store.get_by_slug("refactoring-guru", ResourceKind.REFERENCE).metadata["taxonomy"]["category"] == "software-architecture"
    assert any(group.name == "Documentos y ofimática" for group in store.list_groups())


def test_seed_adds_new_schema_metadata_without_erasing_analyzed_values(tmp_path) -> None:
    store = ResourceStore(tmp_path / "resources.db")
    analyzed = ResourceItem(
        slug="refactoring-guru", name="Analyzed name", kind=ResourceKind.REFERENCE,
        source="curated", source_url="https://refactoring.guru/design-patterns/catalog",
        summary="Analyzed summary", metadata={
            "source_analyzed_at": "2026-08-11T00:00:00+00:00",
            "intelligence": {"capabilities": ["design-pattern-reference"]},
        },
    )
    store.upsert(analyzed)

    seed_resource_library(store, tmp_path / "missing-installers")

    refreshed = store.get_by_slug("refactoring-guru", ResourceKind.REFERENCE)
    assert refreshed.name == "Analyzed name"
    assert refreshed.metadata["intelligence"]["capabilities"] == ["design-pattern-reference"]
    assert refreshed.metadata["source_role"] == "collection"
    assert refreshed.metadata["acceptance_example"] is True


def test_github_url_validation_rejects_unsafe_or_non_root_urls() -> None:
    parsed = validate_github_repository_url("https://github.com/openai/example.git")
    assert parsed.canonical_url == "https://github.com/openai/example"
    for value in (
        "http://github.com/openai/example",
        "https://evil.test/openai/example",
        "https://user:pass@github.com/openai/example",
        "https://github.com/openai/example/tree/main",
        "https://github.com/openai/example?tab=readme",
    ):
        try:
            validate_github_repository_url(value)
        except ValueError:
            pass
        else:
            raise AssertionError(f"unsafe URL accepted: {value}")


def test_github_internal_component_resolves_to_repository_root() -> None:
    assert _github_resource_parts(
        "https://github.com/affaan-m/ECC/blob/main/docs/ja-JP/skills/agent-introspection-debugging/SKILL.md"
    ) == (
        "https://github.com/affaan-m/ECC",
        "https://github.com/affaan-m/ECC/blob/main/docs/ja-JP/skills/agent-introspection-debugging/SKILL.md",
        True,
    )


def test_github_analysis_reads_metadata_without_repository_execution(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "raw.githubusercontent.com":
            return httpx.Response(404)
        if "/git/trees/" in request.url.path:
            return httpx.Response(200, json={"tree": [{"path": "skills/demo/SKILL.md", "type": "blob"}]})
        return httpx.Response(200, json={
            "name": "demo", "description": "A demo skill", "default_branch": "main",
            "topics": ["agents"], "license": {"spdx_id": "MIT"}, "stargazers_count": 12_345,
        })

    client = httpx.Client(transport=httpx.MockTransport(handler))
    analyzer = GitHubResourceAnalyzer(client)
    result = analyzer.analyze("https://github.com/acme/demo")

    assert result.valid
    assert result.skill_paths == ["skills/demo/SKILL.md"]
    assert result.preview and result.preview.install_strategy == "github_skill"
    assert result.preview.metadata["github_stars"] == 12_345
    store = ResourceStore(tmp_path / "resources.db")
    persisted = analyzer.persist_preview(store, result)
    assert persisted.repo_url == "https://github.com/acme/demo"


def test_github_analysis_never_turns_missing_stars_into_zero() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "/git/trees/" in request.url.path:
            return httpx.Response(200, json={"tree": []})
        return httpx.Response(200, json={"name": "demo", "default_branch": "main"})

    analyzer = GitHubResourceAnalyzer(httpx.Client(transport=httpx.MockTransport(handler)))
    result = analyzer.analyze("https://github.com/acme/demo")

    assert result.valid and result.preview
    assert result.preview.metadata["github_stars"] is None


def test_github_analysis_returns_controlled_not_found_result() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"message": "Not Found"})

    analyzer = GitHubResourceAnalyzer(httpx.Client(transport=httpx.MockTransport(handler)))
    result = analyzer.analyze("https://github.com/acme/missing")

    assert not result.valid
    assert result.preview is None
    assert result.warnings == ["GitHub metadata could not be read: GitHub repository or branch not found (404)"]


def test_github_analysis_summarizes_readme_with_fallback_metadata() -> None:
    readme = "# Demo\n\nDemo ayuda a crear agentes reproducibles. Requiere Python 3.12."

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "raw.githubusercontent.com":
            return httpx.Response(200, text=readme)
        if "/git/trees/" in request.url.path:
            return httpx.Response(200, json={"tree": [{"path": "README.md", "type": "blob"}]})
        return httpx.Response(200, json={"name": "demo", "default_branch": "main"})

    analyzer = GitHubResourceAnalyzer(httpx.Client(transport=httpx.MockTransport(handler)))
    result = analyzer.analyze("https://github.com/acme/demo")

    assert "agentes reproducibles" in result.summary
    assert result.metadata["summary_method"] == "readme_fallback"
    assert result.metadata["readme_excerpt"].startswith("# Demo")


def test_github_analysis_extracts_detailed_signals_from_tree_and_manifests() -> None:
    package = '{"dependencies":{"react":"^19","playwright":"^1"}}'
    readme = "Accessible data visualization dashboard with charts and a CLI."

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "raw.githubusercontent.com":
            return httpx.Response(200, text=package if request.url.path.endswith("/package.json") else readme)
        if "/git/trees/" in request.url.path:
            return httpx.Response(200, json={"tree": [
                {"path": "README.md", "type": "blob"},
                {"path": "package.json", "type": "blob"},
                {"path": "src/App.tsx", "type": "blob"},
            ]})
        return httpx.Response(200, json={
            "name": "charts", "description": "Chart components", "default_branch": "main",
            "topics": ["visualization"], "language": "TypeScript",
        })

    analyzer = GitHubResourceAnalyzer(httpx.Client(transport=httpx.MockTransport(handler)))
    result = analyzer.analyze("https://github.com/acme/charts")

    assert result.valid and result.preview
    intelligence = result.preview.metadata["intelligence"]
    assert "data-visualization" in intelligence["capabilities"]
    assert "react" in intelligence["frameworks"]
    assert "typescript" in intelligence["languages"]
    assert result.preview.metadata["manifests_inspected"] == ["package.json"]


def test_itsfree_follows_bounded_same_host_redirects_and_skips_external_links() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/es/":
            return httpx.Response(307, headers={"location": "/es"})
        if request.url.path == "/es":
            return httpx.Response(200, text=(
                '<html><a href="https://external.example/tool">external</a>'
                '<a href="/es/tools/demo">demo</a></html>'
            ))
        if request.url.path == "/es/tools/demo":
            return httpx.Response(200, text=(
                '<html><title>Demo tool</title><meta name="description" '
                'content="A tool for accessible dashboards"></html>'
            ))
        return httpx.Response(404)

    adapter = ItsFreeAdapter(httpx.Client(transport=httpx.MockTransport(handler)))
    parent = ResourceItem(
        slug="itsfree",
        name="itsfree",
        kind=ResourceKind.REFERENCE,
        source="web",
        source_url="https://itsfree.dev/es/",
    )

    children = adapter.discover(parent)

    assert len(children) == 1
    assert children[0].name == "Demo tool"
    assert children[0].parent_resource_id == parent.id


def test_sparse_itsfree_child_receives_fallback_intelligence() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/es":
            return httpx.Response(200, text='<html><a href="/es/tools/plain">plain</a></html>')
        if request.url.path == "/es/tools/plain":
            return httpx.Response(200, text="<html><title>Plain Thing</title><p>Unclear sparse text.</p></html>")
        return httpx.Response(404)

    adapter = ItsFreeAdapter(httpx.Client(transport=httpx.MockTransport(handler)))
    parent = ResourceItem(
        slug="itsfree", name="itsfree", kind=ResourceKind.REFERENCE,
        source="web", source_url="https://itsfree.dev/es",
    )

    child = adapter.discover(parent)[0]
    intelligence = child.metadata["intelligence"]

    assert child.capabilities == ["developer-resource"]
    assert child.tags == ["developer-resource", "itsfree"]
    assert intelligence["evidence"] == [{
        "field": "capability",
        "value": "developer-resource",
        "source": "Plain Thing",
        "matched": "developer-resource",
        "url": "https://itsfree.dev/es/tools/plain",
        "method": "itsfree-html",
    }]
    assert child.metadata["agent_resource"]["capabilities"] == ["developer-resource"]


def test_sparse_toools_external_link_receives_fallback_intelligence() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text='<html><a href="https://example.com/plain">Plain Link</a></html>')

    adapter = TooolsDesignAdapter(httpx.Client(transport=httpx.MockTransport(handler)))
    parent = ResourceItem(
        slug="toools-design", name="toools.design", kind=ResourceKind.REFERENCE,
        source="web", source_url="https://www.toools.design/",
    )

    child = adapter.discover(parent)[0]
    intelligence = child.metadata["intelligence"]

    assert child.capabilities == ["design-reference"]
    assert child.tags == ["design-resource", "toools-design"]
    assert intelligence["evidence"] == [{
        "field": "capability",
        "value": "design-reference",
        "source": "Plain Link",
        "matched": "design-reference",
        "url": "https://example.com/plain",
        "method": "toools-directory",
    }]
    assert child.metadata["agent_resource"]["capabilities"] == ["design-reference"]


def test_skill_install_verify_and_uninstall_are_audited(tmp_path) -> None:
    store = ResourceStore(tmp_path / "resources.db")
    item = _item(store)
    checkout = tmp_path / "checkout" / "example-skill"
    checkout.mkdir(parents=True)
    (checkout / "SKILL.md").write_text("# Example", encoding="utf-8")
    (checkout / "notes.md").write_text("safe data", encoding="utf-8")
    roots = {"claude": tmp_path / "claude", "codex": tmp_path / "codex"}
    manager = SkillRepositoryManager(store, target_roots=roots)

    installed = manager.install_from_directory(item, checkout.parent, targets=["claude", "codex"])
    assert installed.status == "succeeded"
    current = store.get(item.id)
    assert len(current.installations) == 2
    assert (roots["claude"] / "example-skill" / "SKILL.md").is_file()
    assert manager.verify(current, targets=["claude", "codex"]).status == "succeeded"

    removed = manager.uninstall(store.get(item.id), targets=["claude", "codex"])
    assert removed.status == "succeeded"
    assert not (roots["claude"] / "example-skill").exists()
    assert store.get(item.id).installations == []
    assert [op.action for op in store.list_operations(item.id)] == ["uninstall", "verify", "install"]


def test_skill_install_rolls_back_when_a_target_collides(tmp_path) -> None:
    store = ResourceStore(tmp_path / "resources.db")
    item = _item(store)
    checkout = tmp_path / "checkout" / "example-skill"
    checkout.mkdir(parents=True)
    (checkout / "SKILL.md").write_text("# New", encoding="utf-8")
    roots = {"claude": tmp_path / "claude", "codex": tmp_path / "codex"}
    collision = roots["codex"] / "example-skill"
    collision.mkdir(parents=True)
    (collision / "SKILL.md").write_text("# Existing", encoding="utf-8")
    manager = SkillRepositoryManager(store, target_roots=roots)

    result = manager.install_from_directory(item, checkout.parent, targets=["claude", "codex"])

    assert result.status == "failed"
    assert not (roots["claude"] / "example-skill").exists()
    assert (collision / "SKILL.md").read_text(encoding="utf-8") == "# Existing"


def test_skill_update_replaces_managed_copy_atomically(tmp_path) -> None:
    store = ResourceStore(tmp_path / "resources.db")
    item = _item(store)
    checkout = tmp_path / "checkout" / "example-skill"
    checkout.mkdir(parents=True)
    manifest = checkout / "SKILL.md"
    manifest.write_text("# Version 1", encoding="utf-8")
    roots = {"codex": tmp_path / "codex"}
    manager = SkillRepositoryManager(store, target_roots=roots)
    assert manager.install_from_directory(item, checkout.parent, targets=["codex"]).status == "succeeded"

    manifest.write_text("# Version 2", encoding="utf-8")
    result = manager.install_from_directory(
        store.get(item.id),
        checkout.parent,
        targets=["codex"],
        replace_existing=True,
        operation_action="update",
    )

    assert result.status == "succeeded"
    assert (roots["codex"] / "example-skill" / "SKILL.md").read_text(encoding="utf-8") == "# Version 2"
    assert not list(roots["codex"].glob(".karajan-backup-*"))


def test_uninstall_refuses_modified_managed_skill(tmp_path) -> None:
    store = ResourceStore(tmp_path / "resources.db")
    item = _item(store)
    checkout = tmp_path / "checkout" / "example-skill"
    checkout.mkdir(parents=True)
    (checkout / "SKILL.md").write_text("# Original", encoding="utf-8")
    roots = {"codex": tmp_path / "codex"}
    manager = SkillRepositoryManager(store, target_roots=roots)
    assert manager.install_from_directory(item, checkout.parent, targets=["codex"]).status == "succeeded"
    installed = roots["codex"] / "example-skill" / "SKILL.md"
    installed.write_text("# Operator changes", encoding="utf-8")

    result = manager.uninstall(store.get(item.id), targets=["codex"])

    assert result.status == "failed"
    assert installed.read_text(encoding="utf-8") == "# Operator changes"
    assert store.get(item.id).status == "installed"


def test_uninstall_restores_skill_when_audit_write_fails(monkeypatch, tmp_path) -> None:
    store = ResourceStore(tmp_path / "resources.db")
    item = _item(store)
    checkout = tmp_path / "checkout" / "example-skill"
    checkout.mkdir(parents=True)
    (checkout / "SKILL.md").write_text("# Original", encoding="utf-8")
    roots = {"codex": tmp_path / "codex"}
    manager = SkillRepositoryManager(store, target_roots=roots)
    assert manager.install_from_directory(item, checkout.parent, targets=["codex"]).status == "succeeded"
    original_record = store.record_operation
    calls = 0

    def flaky_record(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError("audit unavailable")
        return original_record(**kwargs)

    monkeypatch.setattr(store, "record_operation", flaky_record)
    result = manager.uninstall(store.get(item.id), targets=["codex"])

    assert result.status == "failed"
    assert (roots["codex"] / "example-skill" / "SKILL.md").is_file()
    assert store.get(item.id).status == "installed"


def test_mutating_operation_requires_confirmation(tmp_path) -> None:
    store = ResourceStore(tmp_path / "resources.db")
    item = _item(store)
    manager = SkillRepositoryManager(store, target_roots={"codex": tmp_path / "codex"})
    result = manager.operate(
        item, ResourceOperationRequest(action="uninstall", targets=["codex"], confirmed=False)
    )
    assert result.status == "denied"


def test_naityer_is_allowlisted_preflighted_and_audited(monkeypatch, tmp_path) -> None:
    root = tmp_path / "naityer"
    (root / "scripts" / "installers" / "complementos_ia").mkdir(parents=True)
    (root / "config").mkdir()
    (root / "scripts" / "Invoke-Setup.ps1").write_text("# launcher", encoding="utf-8")
    (root / "scripts" / "installers" / "complementos_ia" / "dspy.ps1").write_text("@{}", encoding="utf-8")
    (root / "config" / "setup.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr("app.naityer_resources.shutil.which", lambda command: f"C:/bin/{command}")
    calls = []

    def runner(argv, **kwargs):
        calls.append((argv, kwargs))
        return subprocess.CompletedProcess(argv, 0, stdout="ok", stderr="")

    store = ResourceStore(tmp_path / "resources.db")
    adapter = NaityerAdapter(store, root=root, runner=runner, require_admin=False)

    assert not adapter.preflight("not_allowed").allowed
    assert adapter.execute("dspy", "install", confirmed=False).status == "denied"
    result = adapter.execute("dspy", "install", confirmed=True)
    assert result.status == "succeeded"
    assert calls[0][0][-2:] == ["-Only", "dspy"]
    assert calls[0][1]["shell"] is False


def test_naityer_redacts_secrets_from_audit_log(monkeypatch, tmp_path) -> None:
    root = tmp_path / "naityer"
    installers = root / "scripts" / "installers" / "complementos_ia"
    installers.mkdir(parents=True)
    (root / "config").mkdir()
    (root / "scripts" / "Invoke-Setup.ps1").write_text("# launcher", encoding="utf-8")
    (installers / "dspy.ps1").write_text("@{}", encoding="utf-8")
    (root / "config" / "setup.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr("app.naityer_resources.shutil.which", lambda command: f"C:/bin/{command}")

    def runner(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 0, stdout="API_KEY=very-secret Authorization: Bearer abc123", stderr="")

    store = ResourceStore(tmp_path / "resources.db")
    result = NaityerAdapter(store, root=root, runner=runner, require_admin=False).execute("dspy", "install", confirmed=True)
    assert "very-secret" not in result.detail
    assert "abc123" not in result.detail
    assert result.detail.count("[REDACTED]") == 2
