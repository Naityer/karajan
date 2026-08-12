from pathlib import Path
import threading
import time

import pytest

from app.models import AnalyzeResult, ResourceCreateRequest, ResourceKind, ResourceRefreshSettingsUpdate, ResourceUpdateRequest
from app.resource_library import ResourceStore
from app.resource_refresh import ResourceRefreshCoordinator
from app.local_resources import LocalResourceAnalyzer


class FakeAnalyzer:
    def __init__(self) -> None:
        self.calls = 0

    def analyze(self, repo_url: str) -> AnalyzeResult:
        self.calls += 1
        preview = ResourceCreateRequest(
            slug="ecc",
            name="ECC",
            kind=ResourceKind.SKILL,
            source="github",
            repo_url=repo_url,
            summary="Resumen actualizado desde el repositorio.",
            tags=["agents", "skills"],
            capabilities=["agent-rules", "security"],
            compatible_runtimes=["claude", "codex"],
            install_strategy="github_skill",
            metadata={
                "source_revision": "commit-2",
                "skill_paths": ["skills/a/SKILL.md", "skills/b/SKILL.md"],
                "intelligence": {"use_cases": ["agent configuration"]},
            },
        )
        return AnalyzeResult(valid=True, repo_url=repo_url, preview=preview, skill_paths=preview.metadata["skill_paths"])


def _legacy_resource(store: ResourceStore):
    return store.create(ResourceCreateRequest(
        slug="legacy-ecc",
        name="Ecc",
        kind=ResourceKind.CAPABILITY,
        source="naityer",
        repo_url="https://github.com/affaan-m/ECC",
        summary="Ficha antigua.",
        capabilities=["ecc"],
    ))


def test_due_refresh_enriches_legacy_repository_and_detects_components(tmp_path: Path):
    store = ResourceStore(tmp_path / "resources.db")
    item = _legacy_resource(store)
    analyzer = FakeAnalyzer()
    coordinator = ResourceRefreshCoordinator(store, analyzer)

    result = coordinator.run_due()
    refreshed = store.get(item.id)

    assert result == {"running": False, "analyzed": 1, "updated": 1, "failed": 0}
    assert refreshed.metadata["skill_paths"] == ["skills/a/SKILL.md", "skills/b/SKILL.md"]
    assert refreshed.metadata["source_revision"] == "commit-2"
    assert refreshed.metadata["source_analysis_trigger"] == "scheduled"
    assert refreshed.capabilities == ["agent-rules", "security"]
    assert refreshed.compatible_runtimes == ["claude", "codex"]
    assert refreshed.install_strategy == "github_skill"


def test_editorial_summary_survives_automatic_reanalysis(tmp_path: Path):
    store = ResourceStore(tmp_path / "resources.db")
    item = _legacy_resource(store)
    edited = store.update_resource(item.id, ResourceUpdateRequest(summary="Descripcion corregida por el operador."))
    coordinator = ResourceRefreshCoordinator(store, FakeAnalyzer())

    refreshed = coordinator.refresh_item(edited, trigger="scheduled")

    assert refreshed.summary == "Descripcion corregida por el operador."
    assert refreshed.metadata["summary_edited"] is True
    assert len(refreshed.metadata["skill_paths"]) == 2


def test_lightweight_seed_cannot_erase_analyzed_components(tmp_path: Path):
    store = ResourceStore(tmp_path / "resources.db")
    item = _legacy_resource(store)
    enriched = ResourceRefreshCoordinator(store, FakeAnalyzer()).refresh_item(item, trigger="scheduled")

    store.upsert(item)
    after_seed = store.get(enriched.id)

    assert after_seed.metadata["source_revision"] == "commit-2"
    assert len(after_seed.metadata["skill_paths"]) == 2
    assert after_seed.capabilities == ["agent-rules", "security"]


def test_refresh_cadence_is_persistent_and_configurable(tmp_path: Path):
    store = ResourceStore(tmp_path / "resources.db")
    coordinator = ResourceRefreshCoordinator(store, FakeAnalyzer())
    settings = ResourceRefreshSettingsUpdate(
        repository_enabled=False,
        repository_interval_days=14,
        radar_interval_minutes=180,
    )

    coordinator.update_settings(settings)
    restored = ResourceRefreshCoordinator(store, FakeAnalyzer()).status()

    assert restored["repository_enabled"] is False
    assert restored["repository_interval_days"] == 14
    assert restored["radar_interval_minutes"] == 180
    assert coordinator.run_due()["disabled"] is True


class CatalogAnalyzer:
    def __init__(self, *, fail_on: str = "", paths: list[str] | None = None) -> None:
        self.calls: list[str] = []
        self.fail_on = fail_on
        self.paths = paths if paths is not None else []

    def analyze(self, repo_url: str) -> AnalyzeResult:
        self.calls.append(repo_url)
        if self.fail_on and self.fail_on in repo_url:
            raise RuntimeError("source unavailable")
        slug = repo_url.rstrip("/").rsplit("/", 1)[-1].casefold()
        metadata = {"source_revision": f"revision-{slug}", "skill_paths": list(self.paths)}
        preview = ResourceCreateRequest(
            slug=slug,
            name=slug.title(),
            kind=ResourceKind.CAPABILITY,
            source="github",
            repo_url=repo_url,
            summary=f"Metadata for {slug}.",
            tags=["analyzed"],
            capabilities=["catalog-analysis"],
            metadata=metadata,
        )
        return AnalyzeResult(valid=True, repo_url=repo_url, preview=preview, skill_paths=list(self.paths))


def _github_resource(store: ResourceStore, index: int):
    return store.create(ResourceCreateRequest(
        slug=f"repo-{index}",
        name=f"Repo {index}",
        kind=ResourceKind.CAPABILITY,
        source="github",
        repo_url=f"https://github.com/example/repo-{index}",
        summary="Legacy metadata.",
    ))


def _wait_for_run(coordinator: ResourceRefreshCoordinator, run_id: str, timeout: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        run = coordinator.job_status(run_id)
        if run and run["status"] not in {"queued", "running"}:
            return run
        time.sleep(0.01)
    raise AssertionError("resource refresh job did not finish")


def test_full_refresh_processes_catalog_beyond_previous_twelve_item_limit(tmp_path: Path):
    store = ResourceStore(tmp_path / "resources.db")
    for index in range(27):
        _github_resource(store, index)
    analyzer = CatalogAnalyzer()
    events: list[tuple[str, dict]] = []
    coordinator = ResourceRefreshCoordinator(
        store,
        analyzer,
        publish=lambda event, **payload: events.append((event, payload)),
    )

    started = coordinator.start_full_refresh(force=True)
    completed = _wait_for_run(coordinator, started["run_id"])

    assert completed["status"] == "completed"
    assert completed["total"] == 27
    assert completed["processed"] == 27
    assert completed["pending"] == 0
    assert completed["updated"] == 27
    assert len(analyzer.calls) == 27
    assert any(event == "resource_refresh_progress" and payload["processed"] == 27 for event, payload in events)


def test_full_refresh_isolates_failures_and_preserves_manual_summary(tmp_path: Path):
    store = ResourceStore(tmp_path / "resources.db")
    first = _github_resource(store, 1)
    failed = _github_resource(store, 2)
    third = _github_resource(store, 3)
    store.update_resource(first.id, ResourceUpdateRequest(summary="Descripción editorial que debe sobrevivir."))
    coordinator = ResourceRefreshCoordinator(store, CatalogAnalyzer(fail_on="repo-2"))

    started = coordinator.start_full_refresh(force=True)
    completed = _wait_for_run(coordinator, started["run_id"])

    assert completed["processed"] == 3
    assert completed["updated"] == 2
    assert completed["failed"] == 1
    assert completed["status"] == "completed_with_errors"
    assert completed["failures"][0]["resource_id"] == failed.id
    assert store.get(first.id).summary == "Descripción editorial que debe sobrevivir."
    assert store.get(third.id).metadata["source_revision"] == "revision-repo-3"


def test_full_refresh_rejects_a_second_global_job(tmp_path: Path):
    entered = threading.Event()
    release = threading.Event()

    class BlockingAnalyzer(CatalogAnalyzer):
        def analyze(self, repo_url: str) -> AnalyzeResult:
            entered.set()
            release.wait(2)
            return super().analyze(repo_url)

    store = ResourceStore(tmp_path / "resources.db")
    _github_resource(store, 1)
    coordinator = ResourceRefreshCoordinator(store, BlockingAnalyzer())
    started = coordinator.start_full_refresh(force=True)
    assert entered.wait(1)

    with pytest.raises(RuntimeError, match="already running"):
        coordinator.start_full_refresh(force=True)

    release.set()
    assert _wait_for_run(coordinator, started["run_id"])["status"] == "completed"


def test_github_children_are_idempotent_and_missing_children_become_inactive(tmp_path: Path):
    store = ResourceStore(tmp_path / "resources.db")
    parent = _github_resource(store, 1)
    analyzer = CatalogAnalyzer(paths=["skills/a/SKILL.md", "skills/b/SKILL.md"])
    coordinator = ResourceRefreshCoordinator(store, analyzer)

    _, first_count = coordinator.refresh_catalog_item(parent, trigger="manual")
    first_children = store.list_children(parent.id)
    _, second_count = coordinator.refresh_catalog_item(store.get(parent.id), trigger="manual")
    second_children = store.list_children(parent.id)

    assert first_count == second_count == 2
    assert {child.id for child in first_children} == {child.id for child in second_children}

    analyzer.paths = ["skills/a/SKILL.md"]
    coordinator.refresh_catalog_item(store.get(parent.id), trigger="manual")
    all_children = store.list_children(parent.id, include_inactive=True)
    assert len(all_children) == 2
    assert sum(child.index_status == "inactive" for child in all_children) == 1


def test_local_analyzer_reads_skill_metadata_without_executing_files(tmp_path: Path):
    skill_dir = tmp_path / "skills" / "local-tool"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\ndescription: Audita repositorios y detecta riesgos.\n---\n# Local tool\n",
        encoding="utf-8",
    )
    store = ResourceStore(tmp_path / "resources.db")
    item = store.create(ResourceCreateRequest(
        slug="local-tool",
        name="Local tool",
        kind=ResourceKind.SKILL,
        source="local",
        summary="Ficha editorial.",
    ))

    result = LocalResourceAnalyzer(project_root=tmp_path).analyze(item)

    assert result.valid is True
    assert result.preview is not None
    assert result.preview.metadata["source_analysis_method"] == "local-files"
    assert result.preview.metadata["source_files"][0].endswith("SKILL.md")
    assert "Audita repositorios" in result.preview.summary
