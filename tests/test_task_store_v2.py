"""Fase 1 — Task/Run/Project schema, stable agent attribution, migration.

Covers: migration row-count parity against a hand-built legacy DB (with one
deliberately malformed row, to prove the corruption-tolerant backfill really
skips-and-continues instead of crashing), a cost/latency spot-check of the
migrated `runs` against the original `delegation_json`, `record_run`/
`agent_performance` round-trips, `run_index` monotonicity, and a real
classify->delegate dual-write integration check.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

from app.database import TaskStore, _denorm_values
from app.delegation import delegate
from app.models import (
    Backend,
    ClassificationResult,
    ComplexityLevel,
    CriteriaScores,
    DelegationResult,
    RecommendedModel,
    Subtask,
    SubtaskExecution,
    TaskStatus,
)
from app.router import classify_prompt


def _classification(task_id: str) -> ClassificationResult:
    return ClassificationResult(
        task_id=task_id,
        original_prompt="Corrige un bug en una API y valida con tests.",
        domain=["backend"],
        intent="bug_fix",
        criteria=CriteriaScores(
            ambiguity=1, context_required=1, reasoning_depth=1,
            autonomy_required=1, operational_risk=1, validation_difficulty=1,
        ),
        complexity_score=2.0,
        complexity_level=ComplexityLevel.LEVEL_2_MODERATE,
        recommended_strategy="direct",
        recommended_model=RecommendedModel.CHEAP_MODEL,
        subtasks=[
            Subtask(
                id="sub_1", name="Fix", complexity=2,
                recommended_model=RecommendedModel.CHEAP_MODEL, validation="tests pass",
            ),
        ],
        requires_human_review=False,
        reason="test fixture",
        validation_plan="run tests",
        classified_by="heuristic",
    )


def _delegation(task_id: str) -> DelegationResult:
    executions = [
        SubtaskExecution(
            subtask_id="sub_1", status=TaskStatus.COMPLETED, backend=Backend.SIMULATED,
            model_used="provider-alpha", latency_ms=100, estimated_cost_usd=0.001,
            output="ok", input_tokens=10, output_tokens=20,
        ),
        SubtaskExecution(
            subtask_id="sub_2", status=TaskStatus.COMPLETED, backend=Backend.SIMULATED,
            model_used="provider-beta", latency_ms=250, estimated_cost_usd=0.002,
            output="ok", input_tokens=15, output_tokens=25,
        ),
    ]
    return DelegationResult(
        task_id=task_id,
        status=TaskStatus.COMPLETED,
        executions=executions,
        total_latency_ms=sum(e.latency_ms for e in executions),
        total_estimated_cost_usd=round(sum(e.estimated_cost_usd for e in executions), 5),
        total_input_tokens=sum(e.input_tokens for e in executions),
        total_output_tokens=sum(e.output_tokens for e in executions),
    )


_LEGACY_INSERT = """
INSERT INTO tasks (
    task_id, prompt, status, classification_json, delegation_json,
    created_at, updated_at, level, model, score, requires_review, subtask_count, est_cost
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


def _build_legacy_db(db_path) -> tuple[str, str, str, DelegationResult]:
    """A raw legacy `tasks` DB (pre-Fase-1 schema, no `tasks_v2`) with 3 rows:
    one real delegated task, one classified-only task, and one with malformed
    `classification_json` — so the backfill's per-row tolerance is exercised
    against real corruption-shaped input rather than the theoretical case."""
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE tasks (
            task_id TEXT PRIMARY KEY,
            prompt TEXT NOT NULL,
            status TEXT NOT NULL,
            classification_json TEXT NOT NULL,
            delegation_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            level TEXT,
            model TEXT,
            score REAL,
            requires_review INTEGER,
            subtask_count INTEGER,
            est_cost REAL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE decisions (
            id TEXT PRIMARY KEY, task_id TEXT NOT NULL, phase TEXT NOT NULL,
            decision TEXT NOT NULL, score REAL, backend TEXT, reason TEXT, created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE metrics_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
            total_tasks INTEGER NOT NULL, total_estimated_cost_usd REAL NOT NULL,
            total_tokens INTEGER NOT NULL DEFAULT 0, avg_latency_ms INTEGER NOT NULL DEFAULT 0
        )
        """
    )

    now = datetime.now(timezone.utc).isoformat()

    task_a = "tsk_legacy_a"
    classification_a = _classification(task_a)
    delegation_a = _delegation(task_a)
    denorm_a = _denorm_values(classification_a.model_dump(mode="json"), delegation_a.model_dump(mode="json"))
    conn.execute(
        _LEGACY_INSERT,
        (
            task_a, classification_a.original_prompt, TaskStatus.COMPLETED.value,
            classification_a.model_dump_json(), delegation_a.model_dump_json(), now, now, *denorm_a,
        ),
    )

    task_b = "tsk_legacy_b"
    classification_b = _classification(task_b)
    denorm_b = _denorm_values(classification_b.model_dump(mode="json"), None)
    conn.execute(
        _LEGACY_INSERT,
        (
            task_b, classification_b.original_prompt, TaskStatus.CLASSIFIED.value,
            classification_b.model_dump_json(), None, now, now, *denorm_b,
        ),
    )

    task_c = "tsk_legacy_c"
    conn.execute(
        """
        INSERT INTO tasks (
            task_id, prompt, status, classification_json, delegation_json,
            created_at, updated_at, level, model, score, requires_review, subtask_count, est_cost
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)
        """,
        (task_c, "prompt roto", TaskStatus.CLASSIFIED.value, "{not valid json", now, now),
    )

    conn.commit()
    conn.close()
    return task_a, task_b, task_c, delegation_a


def _is_valid_json(text: str | None) -> bool:
    if text is None:
        return False
    try:
        json.loads(text)
        return True
    except (json.JSONDecodeError, TypeError):
        return False


def test_migration_parity_and_spot_check(tmp_path) -> None:
    db_path = tmp_path / "legacy.db"
    task_a, _task_b, task_c, delegation_a = _build_legacy_db(db_path)

    # Constructing TaskStore triggers _init_schema -> _migrate -> _init_schema_v2
    # -> _seed_project -> _backfill_v2, all against this real (pre-existing) file.
    TaskStore(db_path)

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        legacy_count = conn.execute("SELECT COUNT(*) AS c FROM tasks").fetchone()["c"]
        v2_count = conn.execute("SELECT COUNT(*) AS c FROM tasks_v2").fetchone()["c"]
        readable_legacy_ids = {
            row["task_id"]
            for row in conn.execute("SELECT task_id, classification_json FROM tasks").fetchall()
            if _is_valid_json(row["classification_json"])
        }

    assert legacy_count == 3
    # Parity is asserted against what's actually readable (2 of 3 rows), not a
    # hardcoded count — row C's malformed classification_json must be skipped,
    # not crash the backfill.
    assert v2_count == len(readable_legacy_ids) == 2

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        v2_row_a = conn.execute("SELECT * FROM tasks_v2 WHERE legacy_task_id = ?", (task_a,)).fetchone()
        v2_row_c = conn.execute("SELECT * FROM tasks_v2 WHERE legacy_task_id = ?", (task_c,)).fetchone()
        runs_a = conn.execute("SELECT * FROM runs WHERE task_id = ? ORDER BY run_index", (task_a,)).fetchall()
        projects = conn.execute("SELECT * FROM projects").fetchall()

    assert v2_row_a is not None
    assert v2_row_a["status"] == "completed"
    assert v2_row_c is None  # malformed row never migrated
    assert len(projects) == 1 and projects[0]["id"] == "proj_default"

    # Spot-check: migrated runs' cost/latency match the original delegation_json.
    assert len(runs_a) == 2
    assert [row["run_index"] for row in runs_a] == [0, 1]
    assert sum(row["latency_ms"] for row in runs_a) == delegation_a.total_latency_ms
    assert round(sum(row["estimated_cost_usd"] for row in runs_a), 5) == delegation_a.total_estimated_cost_usd
    # Legacy fallback: provider_name = model_used (documented best-effort approximation
    # for pre-Fase-1 rows that never persisted a real provider_name).
    assert runs_a[0]["provider_name"] == "provider-alpha"
    assert runs_a[1]["provider_name"] == "provider-beta"


def test_record_run_and_agent_performance_round_trip(tmp_path) -> None:
    store = TaskStore(tmp_path / "fresh.db")

    store.record_run(
        task_id="t1", provider_name="claude-cli", routing_entity_id="e1",
        routing_entity_name_snapshot="Claude", model_id="claude-3", backend="cli",
        status="completed", started_at="2026-01-01T00:00:00+00:00",
        completed_at="2026-01-01T00:00:01+00:00", latency_ms=100,
        input_tokens=10, output_tokens=20, estimated_cost_usd=0.01, error=None,
    )
    store.record_run(
        task_id="t2", provider_name="claude-cli", routing_entity_id="e1",
        routing_entity_name_snapshot="Claude", model_id="claude-3", backend="cli",
        status="failed", started_at="2026-01-01T00:00:00+00:00",
        completed_at="2026-01-01T00:00:02+00:00", latency_ms=200,
        input_tokens=5, output_tokens=0, estimated_cost_usd=0.02, error="boom",
    )
    store.record_run(
        task_id="t3", provider_name="ollama-qwen", routing_entity_id=None,
        routing_entity_name_snapshot=None, model_id="qwen2.5", backend="cli",
        status="completed", started_at="2026-01-01T00:00:00+00:00",
        completed_at="2026-01-01T00:00:01+00:00", latency_ms=50,
        input_tokens=8, output_tokens=8, estimated_cost_usd=0.0, error=None,
    )

    performance = {row["provider_name"]: row for row in store.agent_performance()}
    assert performance["claude-cli"]["task_count"] == 2
    assert performance["claude-cli"]["error_count"] == 1
    assert performance["claude-cli"]["total_cost"] == 0.03
    assert performance["claude-cli"]["total_tokens"] == 35
    assert performance["ollama-qwen"]["task_count"] == 1
    assert performance["ollama-qwen"]["error_count"] == 0


def test_run_index_increments_per_task(tmp_path) -> None:
    store = TaskStore(tmp_path / "idx.db")
    for _ in range(3):
        store.record_run(
            task_id="t_seq", provider_name="claude-cli", routing_entity_id=None,
            routing_entity_name_snapshot=None, model_id="claude-3", backend="cli",
            status="completed", started_at=None, completed_at=None, latency_ms=10,
            input_tokens=1, output_tokens=1, estimated_cost_usd=0.0, error=None,
        )
    runs = store.list_runs("t_seq")
    assert [row["run_index"] for row in runs] == [0, 1, 2]


def test_dual_write_creates_tasks_v2_and_history(tmp_path) -> None:
    db_path = tmp_path / "dual.db"
    store = TaskStore(db_path)
    classification = classify_prompt("Corrige un bug en una API y valida con tests.")
    store.save_classification(classification)

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        v2 = conn.execute(
            "SELECT * FROM tasks_v2 WHERE legacy_task_id = ?", (classification.task_id,)
        ).fetchone()
        assert v2 is not None
        assert v2["status"] == "draft"
        history = conn.execute("SELECT * FROM task_history WHERE task_id = ?", (v2["id"],)).fetchall()
        assert len(history) == 1

    result, decisions = delegate(classification, store=store)
    store.save_delegation(result, decisions)

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        v2 = conn.execute(
            "SELECT * FROM tasks_v2 WHERE legacy_task_id = ?", (classification.task_id,)
        ).fetchone()
        assert v2["status"] in ("completed", "failed")
        history = conn.execute(
            "SELECT * FROM task_history WHERE task_id = ? ORDER BY changed_at", (v2["id"],)
        ).fetchall()
        assert len(history) == 2  # draft -> completed/failed transition recorded

        runs = conn.execute("SELECT * FROM runs WHERE task_id = ?", (classification.task_id,)).fetchall()
        assert len(runs) == len(result.executions)
        assert all(row["provider_name"] is not None for row in runs)
