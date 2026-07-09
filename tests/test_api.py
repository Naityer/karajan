from pathlib import Path

from fastapi.testclient import TestClient

from app.analysis import audit as graph_audit
from app.analysis import scanner as graph_scanner
from app import config as config_module
from app import main
from app.database import TaskStore
from app.graph_store import GraphStore
from app.models import Backend, KarajanConfig, RepoConfig
from app.providers.base import ModelProvider, ProviderRun
from app.providers.registry import Resolution
from app.routing_layout import RoutingLayoutStore


class _FakeFixerProvider(ModelProvider):
    backend = Backend.SIMULATED

    def __init__(self, content: str) -> None:
        self.content = content
        self.instructions: list[str] = []

    def run(self, instruction: str, model_id: str, timeout_s: int) -> ProviderRun:
        self.instructions.append(instruction)
        return ProviderRun(
            output=f"```file path=problem.py\n{self.content}\n```",
            model_used=model_id,
            latency_ms=1,
        )


def test_api_classify_delegate_list_and_metrics(tmp_path: Path) -> None:
    main.store = TaskStore(tmp_path / "api.db")
    main.layout_store = RoutingLayoutStore(tmp_path / "routing_layout.json")
    main.active_config = KarajanConfig(backend=Backend.SIMULATED)
    client = TestClient(main.app)

    response = client.post("/classify-task", json={"prompt": "Desarrolla un router de IA con API, SQLite y panel."})
    assert response.status_code == 200
    task = response.json()
    assert task["classification"]["complexity_score"] >= 0

    response = client.post("/delegate-task", json={"task_id": task["task_id"]})
    assert response.status_code == 200
    delegated = response.json()
    assert delegated["delegation"]["executions"]

    response = client.get("/tasks")
    assert response.status_code == 200
    assert len(response.json()) == 1

    response = client.get(f"/tasks/{task['task_id']}")
    assert response.status_code == 200
    assert response.json()["task_id"] == task["task_id"]

    response = client.get("/metrics")
    assert response.status_code == 200
    assert response.json()["total_tasks"] == 1


def test_routing_layout_roundtrip(tmp_path: Path) -> None:
    main.layout_store = RoutingLayoutStore(tmp_path / "routing_layout.json")
    client = TestClient(main.app)
    payload = {
        "entities": [
            {
                "id": "entity-parent",
                "name": "Padre",
                "role": "parent",
                "provider": "openai",
                "levels": ["level_4_complex"],
                "skills": ["security-review"],
                "x": 10,
                "y": 20,
            }
        ],
        "zoom": 1.1,
        "drawer_width": 360,
    }

    response = client.put("/routing-layout", json=payload)
    assert response.status_code == 200
    assert response.json()["entities"][0]["provider"] == "openai"

    response = client.get("/routing-layout")
    assert response.status_code == 200
    assert response.json()["drawer_width"] == 360


def test_graph_fix_all_delegates_full_report_to_fixer_and_reaudits(tmp_path: Path, monkeypatch) -> None:
    source = "def problem(x):\n" + "\n".join(f"    x += {i}" for i in range(160)) + "\n    return x\n"
    fixed = "def problem(x):\n    return x\n"
    (tmp_path / "problem.py").write_text(source, encoding="utf-8")
    main.graph_store = GraphStore(tmp_path / "graph.db")
    repo = main.graph_store.add_repo(RepoConfig(name="repo", root_path=str(tmp_path)))
    graph_scanner.scan_repo(repo, main.graph_store)
    audit_result = graph_audit.run_audit(repo.id, main.graph_store, include_llm=False)
    finding_ids = [finding.id for finding in audit_result.findings]
    assert finding_ids

    fixer = _FakeFixerProvider(fixed)
    monkeypatch.setattr(
        main,
        "_fixer_resolution",
        lambda _repo: Resolution(fixer, Backend.SIMULATED, "fake-fixer", "fake"),
    )
    client = TestClient(main.app)

    response = client.post(
        f"/repos/{repo.id}/findings/fix",
        json={
            "finding_id": finding_ids[0],
            "finding_ids": finding_ids,
            "mode": "full_report",
            "apply": True,
            "report": "REPORTE COMPLETO PARA FIXEADOR\nlong_function en problem.py",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["attempted_count"] == len(finding_ids)
    assert body["provider"] == "fake"
    assert "REPORTE COMPLETO" in fixer.instructions[0]
    assert (tmp_path / "problem.py").read_text(encoding="utf-8") == fixed
    assert len(main.graph_store.list_findings(repo.id)) < len(finding_ids)


def test_routing_layout_recovers_from_corrupt_primary(tmp_path: Path) -> None:
    path = tmp_path / "routing_layout.json"
    backup = tmp_path / "routing_layout.json.bak"
    backup.write_text(
        '{"entities":[{"id":"entity-parent","name":"Backup Agent","role":"parent"}],"zoom":1,"drawer_width":320}',
        encoding="utf-8",
    )
    path.write_bytes(b"\x00\x00\x00")

    store = RoutingLayoutStore(path)
    layout = store.load()

    assert layout.entities[0].name == "Backup Agent"


def test_routing_layout_atomic_save_keeps_backup(tmp_path: Path) -> None:
    path = tmp_path / "routing_layout.json"
    store = RoutingLayoutStore(path)
    first = {
        "entities": [{"id": "entity-parent", "name": "First", "role": "parent"}],
        "zoom": 1,
        "drawer_width": 320,
    }
    second = {
        "entities": [{"id": "entity-parent", "name": "Second", "role": "parent"}],
        "zoom": 1.1,
        "drawer_width": 360,
    }

    main.layout_store = store
    client = TestClient(main.app)
    assert client.put("/routing-layout", json=first).status_code == 200
    assert client.put("/routing-layout", json=second).status_code == 200

    assert store.load().entities[0].name == "Second"
    assert store.backup_path.exists()


def test_routing_layout_can_add_catalog_provider_to_decision_map(tmp_path: Path) -> None:
    main.layout_store = RoutingLayoutStore(tmp_path / "routing_layout.json")
    client = TestClient(main.app)

    response = client.post("/routing-layout/catalog/ollama-ornith")

    assert response.status_code == 200
    layout = response.json()
    ornith = next(entity for entity in layout["entities"] if entity["provider"] == "ollama-ornith")
    assert ornith["id"] == "entity-provider-ollama-ornith"
    assert ornith["name"] == "Ornith (local)"
    assert ornith["role"] == "child"
    assert ornith["role_tags"] == ["worker", "l2"]
    assert ornith["levels"] == ["level_3_intermediate", "level_4_complex", "level_5_critical"]


def test_routing_layout_catalog_add_is_idempotent(tmp_path: Path) -> None:
    main.layout_store = RoutingLayoutStore(tmp_path / "routing_layout.json")
    client = TestClient(main.app)

    assert client.post("/routing-layout/catalog/ollama-ornith").status_code == 200
    response = client.post("/routing-layout/catalog/ollama-ornith")

    assert response.status_code == 200
    entities = [entity for entity in response.json()["entities"] if entity["provider"] == "ollama-ornith"]
    assert len(entities) == 1


def test_routing_layout_can_remove_catalog_provider_from_decision_map(tmp_path: Path) -> None:
    main.layout_store = RoutingLayoutStore(tmp_path / "routing_layout.json")
    client = TestClient(main.app)
    client.put(
        "/routing-layout",
        json={
            "entities": [
                {"id": "entity-provider-ollama-ornith", "role": "child", "provider": "ollama-ornith"},
                {"id": "entity-agent-claude", "role": "parent", "provider": "claude-cli"},
            ]
        },
    )

    response = client.delete("/routing-layout/catalog/ollama-ornith")

    assert response.status_code == 200
    providers = {entity["provider"] for entity in response.json()["entities"]}
    assert "ollama-ornith" not in providers
    assert "claude-cli" in providers


def test_approve_human_review(tmp_path: Path) -> None:
    main.store = TaskStore(tmp_path / "api.db")
    main.active_config = KarajanConfig(backend=Backend.SIMULATED)
    client = TestClient(main.app)
    payload = {
        "original_prompt": "Audita seguridad antes de ejecutar proveedores reales.",
        "domain": ["security"],
        "intent": "security_review",
        "criteria": {
            "ambiguity": 4,
            "context_required": 4,
            "reasoning_depth": 4,
            "autonomy_required": 4,
            "operational_risk": 5,
            "validation_difficulty": 4,
        },
        "recommended_skills": ["security-review"],
        "requires_human_review": True,
    }
    task = client.post("/ingest", json=payload).json()
    delegated = client.post("/delegate-task", json={"task_id": task["task_id"]}).json()
    assert delegated["status"] == "delegated"

    response = client.post(f"/tasks/{task['task_id']}/approve-review")
    assert response.status_code == 200
    assert response.json()["status"] == "completed"


def test_apply_queue_config_enables_queue_dispatch_and_fills_hierarchy(tmp_path: Path, monkeypatch) -> None:
    main.layout_store = RoutingLayoutStore(tmp_path / "routing_layout.json")
    main.active_config = KarajanConfig(backend=Backend.SIMULATED)
    # apply_queue_config() calls config_module.save_runtime_config(), which
    # defaults to the real data/active_config.json — redirect it so the test
    # never writes to the operator's actual runtime config.
    monkeypatch.setattr(config_module, "RUNTIME_CONFIG_PATH", tmp_path / "active_config.json")
    client = TestClient(main.app)

    # Starting layout only has the two root entities — everything else is "missing".
    client.put(
        "/routing-layout",
        json={
            "entities": [
                {"id": "entity-agent-claude", "role": "parent", "role_tags": ["parent"], "provider": "claude-cli", "tier": 0},
                {"id": "entity-backup-codex", "role": "backup", "role_tags": ["backup"], "provider": "codex", "tier": 0},
            ]
        },
    )

    response = client.post("/setup/apply-queue-config")
    assert response.status_code == 200
    result = response.json()
    assert result["ok"] is True
    assert "+" in result["restored"][0]

    config = client.get("/config").json()
    assert config["orchestration"]["dispatch_mode"] == "queue"
    assert config["orchestration"]["enable_validator_loop"] is True

    layout = client.get("/routing-layout").json()
    ids = {entity["id"] for entity in layout["entities"]}
    assert {"entity-worker-glm", "entity-worker-kimi", "entity-worker-ornith", "entity-validator-cheap"} <= ids

    # Idempotent: applying again doesn't error and doesn't duplicate entities.
    response2 = client.post("/setup/apply-queue-config")
    assert response2.status_code == 200
    layout2 = client.get("/routing-layout").json()
    assert len(layout2["entities"]) == len(layout["entities"])
