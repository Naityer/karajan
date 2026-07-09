"""Fase 3 — DuckDB analytics layer over the Fase-1 SQLite schema.

Covers: each aggregate function returns sane, JSON-serializable data against a
freshly-populated store (cost-by-day, latency percentiles via PERCENTILE_CONT,
success-rate-by-task-type, runs-over-time, provider leaderboard, the assembled
dashboard), the READ_ONLY attach never mutates the SQLite file, and
`AnalyticsUnavailable` is raised when duckdb is mocked absent.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

import pytest

from app.analytics import duckdb_ops
from app.database import TaskStore
from app.models import (
    ClassificationResult,
    ComplexityLevel,
    CriteriaScores,
    RecommendedModel,
    Subtask,
)


def _classification(task_id: str, prompt: str, intent: str) -> ClassificationResult:
    return ClassificationResult(
        task_id=task_id,
        original_prompt=prompt,
        domain=["backend"],
        intent=intent,
        criteria=CriteriaScores(
            ambiguity=1, context_required=1, reasoning_depth=1,
            autonomy_required=1, operational_risk=1, validation_difficulty=1,
        ),
        complexity_score=2.0,
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


def _populate(tmp_path):
    store = TaskStore(db_path=tmp_path / "analytics.db")
    now = datetime.now(timezone.utc).isoformat()
    specs = [
        ("tsk_1", "implement_feature", "provider-a", 100, 0.001, "completed", None),
        ("tsk_2", "implement_feature", "provider-a", 300, 0.003, "completed", None),
        ("tsk_3", "classify_and_plan", "provider-b", 50, 0.0005, "completed", None),
        ("tsk_4", "classify_and_plan", "provider-b", 5000, 0.002, "failed", "boom"),
    ]
    for task_id, intent, provider, latency, cost, status, error in specs:
        store.save_classification(_classification(task_id, f"prompt {task_id}", intent))
        store.record_run(
            task_id=task_id, provider_name=provider, routing_entity_id=None,
            routing_entity_name_snapshot=None, model_id="m", backend="simulated",
            status=status, started_at=now, completed_at=now, latency_ms=latency,
            input_tokens=10, output_tokens=20, estimated_cost_usd=cost, error=error,
        )
    return store


def test_provider_leaderboard(tmp_path):
    store = _populate(tmp_path)
    rows = duckdb_ops.provider_leaderboard(db_path=store.db_path)
    by_provider = {r["provider_name"]: r for r in rows}
    assert by_provider["provider-a"]["run_count"] == 2
    assert by_provider["provider-a"]["error_count"] == 0
    assert by_provider["provider-b"]["error_count"] == 1
    assert by_provider["provider-b"]["error_rate"] == 0.5


def test_latency_percentiles(tmp_path):
    store = _populate(tmp_path)
    rows = duckdb_ops.latency_percentiles(db_path=store.db_path)
    a = next(r for r in rows if r["provider_name"] == "provider-a")
    # p50 of {100, 300} == 200
    assert a["p50_latency_ms"] == 200.0
    assert a["p99_latency_ms"] >= a["p50_latency_ms"]
    filtered = duckdb_ops.latency_percentiles(provider_name="provider-a", db_path=store.db_path)
    assert len(filtered) == 1 and filtered[0]["provider_name"] == "provider-a"


def test_success_rate_by_task_type(tmp_path):
    store = _populate(tmp_path)
    rows = duckdb_ops.success_rate_by_task_type(db_path=store.db_path)
    by_type = {r["task_type"]: r for r in rows}
    assert by_type["implement_feature"]["success_rate"] == 1.0
    assert by_type["classify_and_plan"]["success_rate"] == 0.5


def test_cost_by_provider_by_day(tmp_path):
    store = _populate(tmp_path)
    rows = duckdb_ops.cost_by_provider_by_day(days=30, db_path=store.db_path)
    assert rows, "expected at least one (day, provider) bucket"
    assert all("day" in r and "provider_name" in r and "total_cost" in r for r in rows)


def test_runs_over_time(tmp_path):
    store = _populate(tmp_path)
    rows = duckdb_ops.runs_over_time(bucket="day", db_path=store.db_path)
    assert sum(r["run_count"] for r in rows) == 4
    with pytest.raises(ValueError):
        duckdb_ops.runs_over_time(bucket="fortnight", db_path=store.db_path)


def test_agent_task_matrix(tmp_path):
    store = _populate(tmp_path)
    rows = duckdb_ops.agent_task_matrix(db_path=store.db_path)
    by_combo = {(r["provider_name"], r["task_type"]): r for r in rows}
    impl = by_combo[("provider-a", "implement_feature")]
    assert impl["run_count"] == 2
    assert impl["success_rate"] == 1.0
    assert impl["error_count"] == 0
    assert impl["avg_latency_ms"] == 200.0  # (100 + 300) / 2
    cls = by_combo[("provider-b", "classify_and_plan")]
    assert cls["run_count"] == 2
    assert cls["success_rate"] == 0.5
    assert cls["error_count"] == 1


def test_agent_task_flow(tmp_path):
    store = _populate(tmp_path)
    rows = duckdb_ops.agent_task_flow(db_path=store.db_path)
    by_key = {(r["task_type"], r["provider_name"], r["status"]): r["run_count"] for r in rows}
    assert by_key[("implement_feature", "provider-a", "completed")] == 2
    assert by_key[("classify_and_plan", "provider-b", "completed")] == 1
    assert by_key[("classify_and_plan", "provider-b", "failed")] == 1
    # Summing a provider's flow rows must match its matrix volume (consistency).
    assert sum(v for (_, p, _), v in by_key.items() if p == "provider-b") == 2


def test_dashboard_assembles_all_sections(tmp_path):
    store = _populate(tmp_path)
    payload = duckdb_ops.dashboard(db_path=store.db_path)
    assert payload["available"] is True
    for key in (
        "cost_by_provider_by_day", "latency_percentiles",
        "success_rate_by_task_type", "runs_over_time", "provider_leaderboard",
        "agent_task_matrix", "agent_task_flow",
    ):
        assert key in payload


def test_readonly_attach_does_not_corrupt_db(tmp_path):
    store = _populate(tmp_path)
    duckdb_ops.dashboard(db_path=store.db_path)
    # A normal write path must still succeed after the analytics read...
    store.save_classification(_classification("tsk_after", "prompt after", "implement_feature"))
    with sqlite3.connect(store.db_path) as conn:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_analytics_unavailable_when_duckdb_absent(tmp_path, monkeypatch):
    store = _populate(tmp_path)
    monkeypatch.setattr(duckdb_ops, "DUCKDB_AVAILABLE", False)
    with pytest.raises(duckdb_ops.AnalyticsUnavailable):
        duckdb_ops.provider_leaderboard(db_path=store.db_path)
    with pytest.raises(duckdb_ops.AnalyticsUnavailable):
        duckdb_ops.dashboard(db_path=store.db_path)
