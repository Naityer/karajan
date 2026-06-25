from pathlib import Path

from fastapi.testclient import TestClient

from app import main
from app.database import TaskStore
from app.delegation import delegate, estimate_task_cost
from app.models import Backend, KarajanConfig, OrchestrationConfig
from app.router import classify_prompt

CRITICAL_INGEST = {
    "original_prompt": "Audita seguridad antes de ejecutar proveedores reales con coste.",
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


def _api_client(tmp_path: Path, config: KarajanConfig | None = None) -> TestClient:
    main.store = TaskStore(tmp_path / "controls.db")
    main.active_config = config or KarajanConfig(backend=Backend.SIMULATED)
    return TestClient(main.app)


# --- P0.1: human review gate is now PRE-execution -----------------------------


def test_human_review_gate_withholds_execution_until_approved(tmp_path: Path) -> None:
    client = _api_client(tmp_path)
    task = client.post("/ingest", json=CRITICAL_INGEST).json()

    delegated = client.post("/delegate-task", json={"task_id": task["task_id"]}).json()
    assert delegated["status"] == "delegated"
    # Nothing ran: no subtasks executed and no cost incurred before sign-off.
    assert delegated["delegation"]["executions"] == []
    assert delegated["delegation"]["total_estimated_cost_usd"] == 0.0
    decisions = client.get(f"/tasks/{task['task_id']}/decisions").json()
    assert any(d["decision"] == "human_review_gate=blocked" for d in decisions)

    approved = client.post(f"/tasks/{task['task_id']}/approve-review").json()
    assert approved["status"] == "completed"
    # Execution only happens after approval.
    assert approved["delegation"]["executions"]
    decisions = client.get(f"/tasks/{task['task_id']}/decisions").json()
    assert any(d["decision"] == "human_review_gate=approved" for d in decisions)


def test_approve_review_rejects_non_critical_task(tmp_path: Path) -> None:
    client = _api_client(tmp_path)
    task = client.post("/classify-task", json={"prompt": "Renombra una variable trivial."}).json()
    assert task["classification"]["requires_human_review"] is False
    res = client.post(f"/tasks/{task['task_id']}/approve-review")
    assert res.status_code == 400


# --- P0.3: per-task cost cap (pure delegation engine) -------------------------


def test_estimate_task_cost_matches_cost_table() -> None:
    config = KarajanConfig()
    classification = classify_prompt("Corrige un bug en una API y valida con tests.")
    expected = sum(
        config.cost_table.get(s.recommended_model.value, 0.0) * s.complexity
        for s in classification.subtasks
    )
    assert estimate_task_cost(classification, config) == round(expected, 5)


def test_cost_cap_blocks_before_execution() -> None:
    classification = classify_prompt("Corrige un bug en una API y valida con tests.")
    cap = estimate_task_cost(classification, KarajanConfig()) / 2
    config = KarajanConfig(orchestration=OrchestrationConfig(max_cost_per_task_usd=cap))

    result, decisions = delegate(classification, config)
    assert result.status.value == "delegated"
    assert result.executions == []
    assert any(d.decision.startswith("cost_gate=blocked") for d in decisions)


def test_cost_cap_allows_when_under_budget() -> None:
    classification = classify_prompt("Corrige un bug en una API y valida con tests.")
    cap = estimate_task_cost(classification, KarajanConfig()) * 2 + 1
    config = KarajanConfig(orchestration=OrchestrationConfig(max_cost_per_task_usd=cap))

    result, _ = delegate(classification, config)
    assert result.status.value in {"completed", "failed"}
    assert result.executions


# --- P0.3: daily budget cap (API layer with shared state) ---------------------


def test_daily_budget_blocks_delegation(tmp_path: Path) -> None:
    config = KarajanConfig(
        backend=Backend.SIMULATED,
        orchestration=OrchestrationConfig(max_daily_cost_usd=0.00001),
    )
    client = _api_client(tmp_path, config)
    task = client.post("/classify-task", json={"prompt": "Implementa un endpoint y valida."}).json()

    res = client.post("/delegate-task", json={"task_id": task["task_id"]})
    assert res.status_code == 409
    decisions = client.get(f"/tasks/{task['task_id']}/decisions").json()
    assert any(d["decision"].startswith("daily_budget=blocked") for d in decisions)


# --- P0.2: token auth on mutations --------------------------------------------


def test_mutations_require_token_when_configured(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("KARAJAN_TOKEN", "s3cret")
    client = _api_client(tmp_path)

    unauth = client.post("/classify-task", json={"prompt": "hola"})
    assert unauth.status_code == 401

    auth = client.post(
        "/classify-task",
        json={"prompt": "hola"},
        headers={"X-KARAJAN-Token": "s3cret"},
    )
    assert auth.status_code == 200


def test_reads_stay_open_with_token_set(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("KARAJAN_TOKEN", "s3cret")
    client = _api_client(tmp_path)
    assert client.get("/metrics").status_code == 200
    assert client.get("/tasks").status_code == 200
