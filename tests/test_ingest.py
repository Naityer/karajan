from pathlib import Path

from fastapi.testclient import TestClient

from app import main
from app.database import TaskStore


def _client(tmp_path: Path) -> TestClient:
    main.store = TaskStore(tmp_path / "ingest.db")
    return TestClient(main.app)


def test_ingest_reconciles_and_persists(tmp_path: Path) -> None:
    client = _client(tmp_path)
    body = {
        "original_prompt": "Revisa el pipeline y corrige el report",
        "domain": ["devops", "programming"],
        "intent": "diagnose_and_fix",
        "criteria": {
            "ambiguity": 5,
            "context_required": 4,
            "reasoning_depth": 3,
            "autonomy_required": 2,
            "operational_risk": 1,
            "validation_difficulty": 0,
        },
    }
    res = client.post("/ingest", json=body)
    assert res.status_code == 200
    task = res.json()
    # Score is recomputed deterministically (5*.2+4*.2+3*.2+2*.15+1*.15 = 2.85).
    assert task["classification"]["complexity_score"] == 2.85
    assert task["classification"]["classified_by"] == "model:/karajan"
    assert task["classification"]["subtasks"]  # synthesized when omitted

    assert client.get("/metrics").json()["total_tasks"] == 1
    decisions = client.get(f"/tasks/{task['task_id']}/decisions").json()
    assert any(d["phase"] == "classify" for d in decisions)


def test_append_decision(tmp_path: Path) -> None:
    client = _client(tmp_path)
    body = {
        "original_prompt": "tarea",
        "criteria": {k: 1 for k in [
            "ambiguity", "context_required", "reasoning_depth",
            "autonomy_required", "operational_risk", "validation_difficulty",
        ]},
    }
    task_id = client.post("/ingest", json=body).json()["task_id"]
    res = client.post(
        f"/tasks/{task_id}/decisions",
        json={"task_id": task_id, "phase": "delegate", "decision": "sub_001->claude", "reason": "ok"},
    )
    assert res.status_code == 200
    decisions = client.get(f"/tasks/{task_id}/decisions").json()
    assert any(d["decision"] == "sub_001->claude" for d in decisions)


def test_append_decision_unknown_task(tmp_path: Path) -> None:
    client = _client(tmp_path)
    res = client.post("/tasks/nope/decisions", json={"task_id": "nope", "phase": "x", "decision": "y"})
    assert res.status_code == 404
