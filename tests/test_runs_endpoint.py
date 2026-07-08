from pathlib import Path

from fastapi.testclient import TestClient

from app import main
from app.database import TaskStore
from app.models import Backend, KarajanConfig
from app.routing_layout import RoutingLayoutStore


def test_task_runs_endpoint_returns_recorded_runs(tmp_path: Path) -> None:
    """A delegated task exposes its stable Fase-1 `runs` rows via GET /tasks/{id}/runs."""
    main.store = TaskStore(tmp_path / "runs.db")
    main.layout_store = RoutingLayoutStore(tmp_path / "routing_layout.json")
    main.active_config = KarajanConfig(backend=Backend.SIMULATED)
    client = TestClient(main.app)

    task = client.post(
        "/classify-task",
        json={"prompt": "Desarrolla un router de IA con API, SQLite y panel."},
    ).json()
    task_id = task["task_id"]

    delegated = client.post("/delegate-task", json={"task_id": task_id}).json()
    assert delegated["delegation"]["executions"], "delegation should have executions"

    response = client.get(f"/tasks/{task_id}/runs")
    assert response.status_code == 200
    runs = response.json()
    assert isinstance(runs, list)
    assert len(runs) >= 1

    first = runs[0]
    # The trace-critical fields the Tareas drill-down renders.
    for key in ("run_index", "provider_name", "model_id", "backend", "status", "latency_ms"):
        assert key in first
    # run_index is monotonic and ordered.
    assert [r["run_index"] for r in runs] == sorted(r["run_index"] for r in runs)


def test_task_runs_endpoint_empty_for_unknown_task(tmp_path: Path) -> None:
    """An unknown / undelegated task returns an empty list, not an error."""
    main.store = TaskStore(tmp_path / "runs_empty.db")
    main.layout_store = RoutingLayoutStore(tmp_path / "routing_layout.json")
    main.active_config = KarajanConfig(backend=Backend.SIMULATED)
    client = TestClient(main.app)

    response = client.get("/tasks/tsk_does_not_exist/runs")
    assert response.status_code == 200
    assert response.json() == []
