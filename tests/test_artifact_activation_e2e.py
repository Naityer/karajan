from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app import delegation, main
from app.database import TaskStore
from app.models import Backend, KarajanConfig, ResourceItem, ResourceKind
from app.providers.base import ModelProvider, ProviderRun
from app.providers.registry import Resolution
from app.resource_activation import attach_resource_recommendations
from app.resource_intelligence import ResourceRankingEngine
from app.resource_library import ResourceStore
from app.router import classify_prompt
from app.routing_layout import RoutingLayoutStore


class _CapturingProvider(ModelProvider):
    backend = Backend.CLI

    def __init__(self) -> None:
        self.instructions: list[str] = []

    def run(self, instruction: str, model_id: str, timeout_s: int) -> ProviderRun:
        self.instructions.append(instruction)
        return ProviderRun(output="hecho", model_used=model_id, latency_ms=1)


def _repo_analyzer() -> ResourceItem:
    return ResourceItem(
        slug="repo-analyzer",
        name="repo-analyzer",
        kind=ResourceKind.SKILL,
        source="test",
        summary="Analiza repositorios, codigo, dependencias y riesgos de mantenimiento.",
        capabilities=["repository-audit", "code-review", "dependency-analysis"],
        tags=["repository-audit", "code-review"],
        source_url="https://example.test/repo-analyzer",
    )


def _client(monkeypatch, tmp_path: Path, resource_store: ResourceStore) -> TestClient:
    monkeypatch.setenv("KARAJAN_REQUIRE_ATLAS_TOKEN", "0")
    monkeypatch.delenv("KARAJAN_TOKEN", raising=False)
    monkeypatch.setattr(main, "store", TaskStore(tmp_path / "tasks.db"))
    monkeypatch.setattr(main, "layout_store", RoutingLayoutStore(tmp_path / "routing.json"))
    monkeypatch.setattr(main, "resource_store", resource_store)
    monkeypatch.setattr(main, "resource_ranking_engine", ResourceRankingEngine())
    main.active_config = KarajanConfig(backend=Backend.CLI)
    main.active_config.orchestration.require_human_review_gate = False
    return TestClient(main.app)


def test_exact_parent_name_remains_recommended_alongside_indexed_children(tmp_path: Path) -> None:
    store = ResourceStore(tmp_path / "resources.db")
    parent = store.upsert(ResourceItem(
        slug="directory",
        name="Directory",
        kind=ResourceKind.REFERENCE,
        source="test",
        summary="Directorio principal de recursos para desarrolladores.",
        source_url="https://example.test/",
    ))
    child = store.upsert(ResourceItem(
        slug="directory--maps",
        name="Directory",
        kind=ResourceKind.CAPABILITY,
        source="test",
        summary="Entrada indexada del directorio para mapas.",
        source_url="https://example.test/maps",
        parent_resource_id=parent.id,
    ))

    classification = attach_resource_recommendations(
        classify_prompt("Directory"),
        store,
        ResourceRankingEngine(),
        limit=5,
    )

    slugs = [resource.slug for resource in classification.recommended_resources]
    assert parent.slug in slugs
    assert child.slug in slugs


def test_classify_delegate_resource_activation_and_skill_analytics(monkeypatch, tmp_path: Path) -> None:
    resource_store = ResourceStore(tmp_path / "resources.db")
    resource_store.upsert(_repo_analyzer())
    client = _client(monkeypatch, tmp_path, resource_store)
    provider = _CapturingProvider()
    monkeypatch.setattr(
        delegation,
        "resolve",
        lambda tier, config: Resolution(provider, Backend.CLI, tier.value, "verified-agent"),
    )

    prompt = "Audita este repositorio: analiza el codigo y las dependencias."
    classified = client.post("/classify-task", json={"prompt": prompt})
    assert classified.status_code == 200
    task = classified.json()
    classification = task["classification"]
    assert classification["recommended_resources"][0]["slug"] == "repo-analyzer"
    assert classification["subtasks"][0]["recommended_skill"] == "repo-analyzer"
    assert task["prompt"] == prompt

    before = client.get("/analytics/skills?days=0").json()
    repo_before = next(row for row in before["skills"] if row["name"] == "repo-analyzer")
    assert repo_before["recommended_tasks"] == 1
    assert repo_before["executions"] == 0

    delegated = client.post("/delegate-task", json={"task_id": task["task_id"]})
    assert delegated.status_code == 200
    assert "Contexto de recursos recomendados para la delegacion" in provider.instructions[0]
    assert "repo-analyzer (skill, primary)" in provider.instructions[0]

    after = client.get("/analytics/skills?days=0").json()
    repo_after = next(row for row in after["skills"] if row["name"] == "repo-analyzer")
    assert repo_after["recommended_tasks"] == 1
    assert repo_after["executions"] == 1
    assert repo_after["successes"] == 1
    assert repo_after["agents"] == {"verified-agent": 1}


def test_agent_tools_path_receives_resource_context_without_persisting_prompt(monkeypatch, tmp_path: Path) -> None:
    resource_store = ResourceStore(tmp_path / "resources.db")
    resource_store.upsert(_repo_analyzer())
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    provider = _CapturingProvider()
    client = _client(monkeypatch, tmp_path, resource_store)
    monkeypatch.setattr(
        delegation,
        "resolve",
        lambda tier, config: Resolution(provider, Backend.CLI, tier.value, "verified-agent"),
    )
    main.active_config.agent_tools.enabled = True
    main.active_config.agent_tools.profile = "readonly"
    main.active_config.agent_tools.default_workspace_root = str(workspace)

    prompt = "Audita este repositorio y revisa sus dependencias."
    task = client.post("/classify-task", json={"prompt": prompt}).json()
    delegated = client.post("/delegate-task", json={"task_id": task["task_id"]})

    assert delegated.status_code == 200
    assert "Contexto de recursos recomendados para la delegacion" in provider.instructions[0]
    assert main.store.get_task(task["task_id"]).prompt == prompt


def test_no_match_prompt_attaches_no_misleading_resources(monkeypatch, tmp_path: Path) -> None:
    resource_store = ResourceStore(tmp_path / "resources.db")
    resource_store.upsert(_repo_analyzer())
    client = _client(monkeypatch, tmp_path, resource_store)

    response = client.post("/classify-task", json={"prompt": "Organiza mi lista de compra semanal."})

    assert response.status_code == 200
    assert response.json()["classification"]["recommended_resources"] == []
