from pathlib import Path

from fastapi.testclient import TestClient

from app import main
from app.database import TaskStore


def test_api_classify_delegate_list_and_metrics(tmp_path: Path) -> None:
    main.store = TaskStore(tmp_path / "api.db")
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
