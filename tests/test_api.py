from pathlib import Path

from fastapi.testclient import TestClient

from app import main
from app.database import TaskStore
from app.models import Backend, KarajanConfig
from app.routing_layout import RoutingLayoutStore


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
