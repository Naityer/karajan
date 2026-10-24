"""Fase 4 — XGBoost predictive analytics.

Covers: feature-engineering shape, the 200-run minimum-sample gate correctly
refusing training on too little data, the anomaly heuristic in isolation, and
(on an explicitly SYNTHETIC >=200-row fixture, isolated in tmp_path — never the
real production DB) that the actual training/persistence/prediction/
feature-importance code path works mechanically end to end.
"""

from __future__ import annotations

import random
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app import main
from app.analytics import ml
from app.database import TaskStore
from app.models import (
    ClassificationResult,
    ComplexityLevel,
    CriteriaScores,
    RecommendedModel,
    Subtask,
)

xgboost = pytest.importorskip("xgboost", reason="xgboost is an optional extra")


def _classification(task_id: str, prompt: str, intent: str, domain: str, score: float) -> ClassificationResult:
    return ClassificationResult(
        task_id=task_id,
        original_prompt=prompt,
        domain=[domain],
        intent=intent,
        criteria=CriteriaScores(
            ambiguity=score, context_required=score, reasoning_depth=score,
            autonomy_required=score, operational_risk=score, validation_difficulty=score,
        ),
        complexity_score=score,
        complexity_level=ComplexityLevel.LEVEL_2_MODERATE,
        recommended_strategy="direct",
        recommended_model=RecommendedModel.CHEAP_MODEL,
        subtasks=[Subtask(
            id="sub_1", name="Do", complexity=2,
            recommended_model=RecommendedModel.CHEAP_MODEL, validation="ok",
        )],
        requires_human_review=False,
        reason="fixture",
        validation_plan="run tests",
        classified_by="heuristic",
    )


def _populate_small(tmp_path) -> TaskStore:
    """Five real-shaped rows — nowhere near the 200-run gate."""
    store = TaskStore(db_path=tmp_path / "small.db")
    now = datetime.now(timezone.utc).isoformat()
    for i in range(5):
        task_id = f"tsk_small_{i}"
        store.save_classification(_classification(task_id, f"prompt {i}", "implement_feature", "backend", 2.0))
        store.record_run(
            task_id=task_id, provider_name="ollama-qwen", routing_entity_id=None,
            routing_entity_name_snapshot=None, model_id="qwen2.5:7b", backend="cli",
            status="completed", started_at=now, completed_at=now, latency_ms=1000,
            input_tokens=50, output_tokens=100, estimated_cost_usd=0.001, error=None,
        )
    return store


# SYNTHETIC fixture, deliberately labeled as such: 220 rows with randomized-but-
# bounded features so both outcome classes exist and the regressors have real
# variance to fit against. This is the ONLY place synthetic data stands in for
# real usage — it proves the training code path works mechanically; it is never
# presented as a real-world accuracy/quality claim, and it is written to an
# isolated tmp_path DB, never the real production data/task_logs.db.
_INTENTS = ("implement_feature", "diagnose_and_fix", "classify_and_plan")
_DOMAINS = ("backend", "frontend", "security")
_PROVIDERS = ("ollama-qwen", "claude-cli", "codex")


def _populate_synthetic_large(tmp_path, n: int = 220) -> TaskStore:
    store = TaskStore(db_path=tmp_path / "large_synthetic.db")
    now = datetime.now(timezone.utc).isoformat()
    rng = random.Random(1234)  # deterministic fixture
    for i in range(n):
        task_id = f"tsk_syn_{i}"
        score = rng.uniform(0.5, 4.5)
        intent = rng.choice(_INTENTS)
        domain = rng.choice(_DOMAINS)
        provider = rng.choice(_PROVIDERS)
        store.save_classification(_classification(task_id, f"synthetic prompt {i} " * rng.randint(1, 8), intent, domain, score))
        failed = rng.random() < 0.15
        latency = max(50.0, rng.gauss(2000 + score * 500, 400))
        cost = max(0.0001, rng.gauss(0.001 + score * 0.002, 0.0005))
        store.record_run(
            task_id=task_id, provider_name=provider, routing_entity_id=None,
            routing_entity_name_snapshot=None, model_id="m", backend="cli",
            status="failed" if failed else "completed",
            started_at=now, completed_at=now,
            latency_ms=int(latency), input_tokens=50, output_tokens=100,
            estimated_cost_usd=round(cost, 5), error="synthetic failure" if failed else None,
        )
    return store


def test_build_feature_frame_shape(tmp_path):
    store = _populate_small(tmp_path)
    frame = ml.build_feature_frame(db_path=store.db_path)
    assert len(frame) == 5
    row = frame[0]
    for key in (
        "ambiguity", "context_required", "reasoning_depth", "autonomy_required",
        "operational_risk", "validation_difficulty", "complexity_score",
        "prompt_length", "subtask_count", "task_type", "domain", "intent",
        "provider_name", "model_id", "backend", "success", "cost", "latency",
    ):
        assert key in row, f"missing feature key: {key}"


def test_training_readiness_below_gate(tmp_path):
    store = _populate_small(tmp_path)
    readiness = ml.training_readiness(db_path=store.db_path)
    assert readiness["samples"] == 5
    assert readiness["min_required"] == 200
    assert readiness["meets_gate"] is False
    assert readiness["trained"] is False


def test_train_all_refuses_below_gate(tmp_path):
    store = _populate_small(tmp_path)
    with pytest.raises(ml.NotEnoughData) as exc_info:
        ml.train_all(db_path=store.db_path)
    # carries the same structured payload the API layer echoes as a 409 detail
    assert exc_info.value.readiness["samples"] == 5
    assert exc_info.value.readiness["meets_gate"] is False


def test_predict_without_trained_model_raises(tmp_path):
    store = _populate_small(tmp_path)
    with pytest.raises(ml.ModelNotTrained):
        ml.predict({"task_type": "implement_feature"}, db_path=store.db_path)


def test_flag_anomaly_heuristic():
    # within 3 sigma -> not anomalous
    assert ml.flag_anomaly(105.0, reference_mean=100.0, reference_std=10.0) is False
    # far outside 3 sigma -> anomalous
    assert ml.flag_anomaly(500.0, reference_mean=100.0, reference_std=10.0) is True
    # degenerate (zero variance) reference can never flag an anomaly
    assert ml.flag_anomaly(999.0, reference_mean=100.0, reference_std=0.0) is False


def test_train_predict_persist_end_to_end_on_synthetic_fixture(tmp_path):
    """The mechanical path (train -> persist -> load -> predict -> importances)
    proven against an explicitly SYNTHETIC >=200-row fixture — see the module
    docstring. Metrics are reported but not asserted to any accuracy bar; this
    test proves the pipeline runs and produces a usable, loadable model, not
    that the model is good (220 random synthetic rows carry no real signal)."""
    store = _populate_synthetic_large(tmp_path, n=220)
    readiness = ml.training_readiness(db_path=store.db_path)
    assert readiness["meets_gate"] is True
    assert readiness["samples"] >= 200

    summary = ml.train_all(db_path=store.db_path)
    assert summary["samples"] >= 200
    assert "cost" in summary["metrics"] and "latency" in summary["metrics"]
    for kind in ("cost", "latency"):
        assert summary["metrics"][kind]["rmse"] >= 0.0

    # model bundle persisted -> now trained
    readiness_after = ml.training_readiness(db_path=store.db_path)
    assert readiness_after["trained"] is True

    # prediction round-trip on a fresh draft profile
    result = ml.predict(
        {
            "ambiguity": 2.0, "context_required": 2.0, "reasoning_depth": 2.0,
            "autonomy_required": 2.0, "operational_risk": 2.0, "validation_difficulty": 2.0,
            "complexity_score": 2.5, "prompt_length": 120.0, "subtask_count": 1.0,
            "task_type": "implement_feature", "domain": "backend", "intent": "implement_feature",
            "provider_name": "ollama-qwen", "model_id": "m", "backend": "cli",
        },
        db_path=store.db_path,
    )
    assert result["predicted_cost_usd"] is not None
    assert result["predicted_latency_ms"] is not None
    assert isinstance(result["is_anomaly"], bool)
    assert isinstance(result["top_features"], list)

    importances = ml.feature_importances("cost", db_path=store.db_path)
    assert importances and all("feature" in row and "importance" in row for row in importances)

    # detect_anomalies runs without error over the same fixture
    flagged = ml.detect_anomalies(db_path=store.db_path)
    assert isinstance(flagged, list)


def test_predictions_status_endpoint_reflects_real_state():
    """Read-only endpoint check against the shared dev app — safe (no writes)."""
    client = TestClient(main.app)
    resp = client.get("/analytics/predictions/status")
    assert resp.status_code == 200
    body = resp.json()
    assert "trained" in body and "samples" in body and "min_required" in body


def test_predict_task_503_when_untrained():
    """The shared dev DB has no trained model bundle yet (Fase 4 was just
    added) — this documents the expected 503 "not trained" contract. If a
    model bundle is later trained in this environment, this assertion would
    need updating; that's an accepted coupling already used elsewhere in this
    test suite (see test_analytics_duckdb.py writing through the real store)."""
    client = TestClient(main.app)
    status = client.get("/analytics/predictions/status").json()
    if status.get("trained"):
        pytest.skip("a model bundle already exists in this environment")
    resp = client.post(
        "/predict/task",
        json={
            "intent": "implement_feature",
            "criteria": {
                "ambiguity": 2, "context_required": 2, "reasoning_depth": 2,
                "autonomy_required": 2, "operational_risk": 2, "validation_difficulty": 2,
            },
            "complexity_score": 2.0,
        },
    )
    assert resp.status_code == 503
    assert resp.json()["detail"]["error"] == "not trained"
