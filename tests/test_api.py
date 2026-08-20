from pathlib import Path

from fastapi.testclient import TestClient

from app import config as config_module
from app import main
from app.modules.tasks import api as tasks_api
from app.database import TaskStore
from app.models import Backend, KarajanConfig
from app.providers.base import ModelProvider, ProviderRun
from app.providers.registry import Resolution
from app.routing_layout import RoutingLayoutStore


class _FakeFixerProvider(ModelProvider):
    backend = Backend.CLI

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


def test_api_classify_delegate_list_and_metrics(karajan_install, tmp_path: Path) -> None:
    karajan_install.set_config(KarajanConfig(backend=Backend.CLI))
    client = karajan_install.client

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


def test_routing_layout_roundtrip(karajan_install, tmp_path: Path) -> None:
    client = karajan_install.client
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


def test_routing_layout_atomic_save_keeps_backup(karajan_install, tmp_path: Path) -> None:
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

    karajan_install.runtime.routing = store
    client = karajan_install.client
    assert client.put("/routing-layout", json=first).status_code == 200
    assert client.put("/routing-layout", json=second).status_code == 200

    assert store.load().entities[0].name == "Second"
    assert store.backup_path.exists()


def test_routing_layout_can_add_catalog_provider_to_decision_map(karajan_install, tmp_path: Path) -> None:
    client = karajan_install.client

    response = client.post("/routing-layout/catalog/ollama-ornith")

    assert response.status_code == 200
    layout = response.json()
    ornith = next(entity for entity in layout["entities"] if entity["provider"] == "ollama-ornith")
    assert ornith["id"] == "entity-provider-ollama-ornith"
    assert ornith["name"] == "Ornith (local)"
    assert ornith["role"] == "child"
    assert ornith["role_tags"] == ["worker", "l2"]
    assert ornith["levels"] == ["level_3_intermediate", "level_4_complex", "level_5_critical"]


def test_routing_layout_catalog_add_is_idempotent(karajan_install, tmp_path: Path) -> None:
    client = karajan_install.client

    assert client.post("/routing-layout/catalog/ollama-ornith").status_code == 200
    response = client.post("/routing-layout/catalog/ollama-ornith")

    assert response.status_code == 200
    entities = [entity for entity in response.json()["entities"] if entity["provider"] == "ollama-ornith"]
    assert len(entities) == 1


def test_routing_layout_can_remove_catalog_provider_from_decision_map(karajan_install, tmp_path: Path) -> None:
    client = karajan_install.client
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


def test_approve_human_review(karajan_install, tmp_path: Path) -> None:
    karajan_install.set_config(KarajanConfig(backend=Backend.CLI))
    client = karajan_install.client
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


def test_apply_queue_config_enables_queue_dispatch_and_fills_hierarchy(karajan_install, tmp_path: Path, monkeypatch) -> None:
    karajan_install.set_config(KarajanConfig(backend=Backend.CLI))
    # apply_queue_config() calls config_module.save_runtime_config(), which
    # defaults to the real data/active_config.json — redirect it so the test
    # never writes to the operator's actual runtime config.
    monkeypatch.setattr(config_module, "RUNTIME_CONFIG_PATH", tmp_path / "active_config.json")
    client = karajan_install.client

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


def _classify(client: TestClient) -> str:
    response = client.post("/classify-task", json={"prompt": "Escribe un script pequeño de utilidad."})
    assert response.status_code == 200
    return response.json()["task_id"]


def test_delegate_task_force_provider_bypasses_routing(karajan_install, tmp_path: Path, monkeypatch) -> None:
    karajan_install.set_config(KarajanConfig(backend=Backend.CLI))
    client = karajan_install.client
    task_id = _classify(client)

    fake = _FakeFixerProvider("output forzado")
    monkeypatch.setattr(
        tasks_api, "resolve_by_name", lambda name, tier: Resolution(fake, Backend.CLI, "fake-model", name)
    )

    response = client.post("/delegate-task", json={"task_id": task_id, "force_provider": "claude-cli"})
    assert response.status_code == 200
    executions = response.json()["delegation"]["executions"]
    assert executions
    assert all(execution["model_used"] == "fake-model" for execution in executions)


def test_delegate_task_force_entity_id_bypasses_routing(karajan_install, tmp_path: Path, monkeypatch) -> None:
    karajan_install.set_config(KarajanConfig(backend=Backend.CLI))
    client = karajan_install.client
    task_id = _classify(client)

    client.put(
        "/routing-layout",
        json={"entities": [{"id": "entity-forced", "role": "worker", "provider": "claude-cli", "tier": 1}]},
    )

    fake = _FakeFixerProvider("output forzado por entidad")
    monkeypatch.setattr(
        tasks_api, "resolve_entity", lambda entity, tier: Resolution(fake, Backend.CLI, "fake-model-entity", entity.id)
    )

    response = client.post("/delegate-task", json={"task_id": task_id, "force_entity_id": "entity-forced"})
    assert response.status_code == 200
    executions = response.json()["delegation"]["executions"]
    assert executions
    assert all(execution["model_used"] == "fake-model-entity" for execution in executions)


def test_delegate_task_force_unknown_entity_returns_404(karajan_install, tmp_path: Path) -> None:
    karajan_install.set_config(KarajanConfig(backend=Backend.CLI))
    client = karajan_install.client
    task_id = _classify(client)

    response = client.post("/delegate-task", json={"task_id": task_id, "force_entity_id": "does-not-exist"})
    assert response.status_code == 404


def test_delegate_task_force_unknown_provider_returns_422(karajan_install, tmp_path: Path) -> None:
    karajan_install.set_config(KarajanConfig(backend=Backend.CLI))
    client = karajan_install.client
    task_id = _classify(client)

    response = client.post("/delegate-task", json={"task_id": task_id, "force_provider": "no-such-provider"})
    assert response.status_code == 422


def test_delegate_task_force_both_fields_returns_400(karajan_install, tmp_path: Path) -> None:
    karajan_install.set_config(KarajanConfig(backend=Backend.CLI))
    client = karajan_install.client
    task_id = _classify(client)

    response = client.post(
        "/delegate-task",
        json={"task_id": task_id, "force_provider": "claude-cli", "force_entity_id": "entity-forced"},
    )
    assert response.status_code == 400


def test_delegate_task_force_with_queue_dispatch_returns_400(karajan_install, tmp_path: Path) -> None:
    config = KarajanConfig(backend=Backend.CLI)
    config.orchestration.dispatch_mode = "queue"
    karajan_install.set_config(config)
    client = karajan_install.client
    task_id = _classify(client)

    response = client.post("/delegate-task", json={"task_id": task_id, "force_provider": "claude-cli"})
    assert response.status_code == 400


def test_delegate_task_without_force_fields_is_unchanged(karajan_install, tmp_path: Path) -> None:
    karajan_install.set_config(KarajanConfig(backend=Backend.CLI))
    client = karajan_install.client
    task_id = _classify(client)

    response = client.post("/delegate-task", json={"task_id": task_id})
    assert response.status_code == 200
    assert response.json()["delegation"]["executions"]
