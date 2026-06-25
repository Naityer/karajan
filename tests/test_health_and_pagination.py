"""`/health` probe and `/tasks` pagination."""

from pathlib import Path

from fastapi.testclient import TestClient

from app import main
from app.database import TaskStore
from app.models import Backend, KarajanConfig


def _client(tmp_path: Path) -> TestClient:
    main.store = TaskStore(tmp_path / "health.db")
    main.active_config = KarajanConfig(backend=Backend.SIMULATED)
    return TestClient(main.app)


def test_health_reports_ok_and_profile(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("KARAJAN_TOKEN", raising=False)
    client = _client(tmp_path)
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["db_ok"] is True
    assert body["backend"] == "simulated"
    assert body["auth_enabled"] is False
    assert body["total_tasks"] == 0


def test_health_reflects_auth_enabled(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("KARAJAN_TOKEN", "s3cret")
    client = _client(tmp_path)
    assert client.get("/health").json()["auth_enabled"] is True


def test_tasks_pagination(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("KARAJAN_TOKEN", raising=False)
    client = _client(tmp_path)
    for i in range(5):
        client.post("/classify-task", json={"prompt": f"Tarea numero {i} de prueba."})

    assert len(client.get("/tasks").json()) == 5
    assert len(client.get("/tasks", params={"limit": 2}).json()) == 2

    page1 = client.get("/tasks", params={"limit": 2, "offset": 0}).json()
    page2 = client.get("/tasks", params={"limit": 2, "offset": 2}).json()
    assert {t["task_id"] for t in page1}.isdisjoint({t["task_id"] for t in page2})

    assert client.get("/tasks", params={"limit": 0}).status_code == 422  # below ge=1


def test_health_total_tasks_tracks_inserts(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("KARAJAN_TOKEN", raising=False)
    client = _client(tmp_path)
    client.post("/classify-task", json={"prompt": "Una tarea cualquiera."})
    assert client.get("/health").json()["total_tasks"] == 1
