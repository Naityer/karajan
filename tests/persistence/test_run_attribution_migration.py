"""Agent-attribution repair: `catalog.split_model_used` and the migration script.

The defect being fixed: the pre-Fase-1 backfill wrote the whole `model_used`
string into `runs.provider_name`, so one agent appears twice in every
`GROUP BY provider_name` aggregate.
"""

import json
import sqlite3
from pathlib import Path

import pytest

from app import catalog
from app.database import TaskStore
from scripts import migrate_run_attribution as migration


@pytest.mark.parametrize(
    ("model_used", "expected"),
    [
        ("ollama-qwen:qwen2.5:7b", ("ollama-qwen", "qwen2.5:7b")),  # model id contains a colon
        ("claude-cli:haiku", ("claude-cli", "haiku")),
        ("codex:gpt-5-codex", ("codex", "gpt-5-codex")),
        ("ollama-qwen", ("ollama-qwen", None)),  # bare provider, no model
        ("simulated:cheap_model", (None, None)),  # retired provider, never in the catalog
        ("totally-unknown:m", (None, None)),
        ("", (None, None)),
        (None, (None, None)),
    ],
)
def test_split_model_used(model_used, expected) -> None:
    assert catalog.split_model_used(model_used) == expected


def test_split_model_used_prefers_the_longest_matching_provider() -> None:
    """`ollama` and `ollama-qwen` both exist; the longer name must win."""
    assert catalog.split_model_used("ollama-qwen:qwen2.5:7b")[0] == "ollama-qwen"
    assert catalog.split_model_used("ollama:llama3.2:3b")[0] == "ollama"


def _seed(db_path: Path) -> None:
    """A DB shaped like the real one: backfilled rows next to live rows."""
    TaskStore(db_path)  # create the schema
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    with conn:
        # Backfilled rows: provider_name == model_id, started_at NULL.
        for index, model_used in enumerate(
            ["ollama-qwen:qwen2.5:7b", "claude-cli:haiku", "simulated:cheap_model", "ghost:x"]
        ):
            conn.execute(
                "INSERT INTO runs (id, task_id, run_index, provider_name, model_id, status, started_at)"
                " VALUES (?, 'tsk_1', ?, ?, ?, 'completed', NULL)",
                (f"run_backfill_{index}", index, model_used, model_used),
            )
        # A live row written by the current path — must be left alone.
        conn.execute(
            "INSERT INTO runs (id, task_id, run_index, provider_name, model_id, status, started_at)"
            " VALUES ('run_live', 'tsk_1', 9, 'ollama-qwen', 'qwen2.5:7b', 'completed', '2026-07-01T00:00:00Z')"
        )
        # A live simulated row, plus its trace — must be purged with its children.
        conn.execute(
            "INSERT INTO runs (id, task_id, run_index, provider_name, model_id, status, started_at)"
            " VALUES ('run_sim', 'tsk_1', 10, 'simulated', 'cheap_model', 'completed', '2026-07-01T00:00:00Z')"
        )
        conn.execute(
            "INSERT INTO run_events (id, run_id, event_type, ts) VALUES ('ev1', 'run_sim', 'x', 'now')"
        )
        conn.execute(
            "INSERT INTO artifacts (id, task_id, run_id, kind, file_path, created_at)"
            " VALUES ('a1', 'tsk_1', 'run_sim', 'file_created', 'x.py', 'now')"
        )
        delegation = {
            "task_id": "tsk_1",
            "status": "completed",
            "executions": [
                {"model_used": "simulated:cheap_model", "latency_ms": 217, "estimated_cost_usd": 0.0004},
                {"model_used": "ollama-qwen:qwen2.5:7b", "latency_ms": 900, "estimated_cost_usd": 0.0},
            ],
            "total_latency_ms": 1117,
            "total_estimated_cost_usd": 0.0004,
        }
        conn.execute(
            "INSERT INTO tasks (task_id, prompt, status, classification_json, delegation_json,"
            " created_at, updated_at) VALUES ('tsk_1', 'p', 'completed', '{}', ?, 'now', 'now')",
            (json.dumps(delegation),),
        )
    conn.close()


def test_dry_run_plans_the_right_work_and_writes_nothing(tmp_path: Path) -> None:
    db = tmp_path / "task_logs.db"
    _seed(db)
    conn = migration._connect(db)
    try:
        fixable, unknown = migration.plan_normalize(conn)
        run_ids, tasks = migration.plan_purge(conn)
    finally:
        conn.close()

    assert {item["before"] for item in fixable} == {"ollama-qwen:qwen2.5:7b", "claude-cli:haiku"}
    # Unknown prefixes are reported, never guessed at.
    assert [item["before"] for item in unknown] == ["ghost:x"]
    assert set(run_ids) == {"run_backfill_2", "run_sim"}
    assert tasks == [("tsk_1", 1)]

    conn = migration._connect(db)
    try:
        assert conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 6
    finally:
        conn.close()


def test_apply_collapses_duplicate_agents_and_purges_simulated(tmp_path: Path) -> None:
    db = tmp_path / "task_logs.db"
    _seed(db)

    conn = migration._connect(db)
    try:
        fixable, _ = migration.plan_normalize(conn)
        run_ids, tasks = migration.plan_purge(conn)
        with conn:
            migration.apply_normalize(conn, fixable)
            migration.apply_purge(conn, run_ids, tasks)
    finally:
        conn.close()

    conn = migration._connect(db)
    try:
        rows = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM runs")}
        # The whole point: one agent, one row in the aggregate.
        agents = {r["provider_name"] for r in conn.execute("SELECT DISTINCT provider_name FROM runs")}
        assert agents == {"ollama-qwen", "claude-cli", "ghost:x"}
        assert rows["run_backfill_0"]["model_id"] == "qwen2.5:7b"
        assert rows["run_backfill_1"]["provider_name"] == "claude-cli"
        # Untouched: the live row already had correct attribution.
        assert rows["run_live"]["provider_name"] == "ollama-qwen"
        # Purged, with its trace children.
        assert "run_sim" not in rows and "run_backfill_2" not in rows
        assert conn.execute("SELECT COUNT(*) FROM run_events").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0] == 0

        delegation = json.loads(
            conn.execute("SELECT delegation_json FROM tasks WHERE task_id = 'tsk_1'").fetchone()[0]
        )
        assert [e["model_used"] for e in delegation["executions"]] == ["ollama-qwen:qwen2.5:7b"]
        # Totals recomputed, not left counting the removed execution.
        assert delegation["total_latency_ms"] == 900
        assert delegation["total_estimated_cost_usd"] == 0.0
    finally:
        conn.close()


def test_backfill_no_longer_writes_model_used_into_provider_name(tmp_path: Path) -> None:
    """Regression guard on the source of the defect (`TaskStore._backfill_v2`)."""
    db = tmp_path / "legacy.db"
    TaskStore(db)  # schema only
    conn = sqlite3.connect(db)
    with conn:
        conn.execute("DELETE FROM runs")
        conn.execute("DELETE FROM tasks_v2")
        conn.execute(
            "INSERT INTO tasks (task_id, prompt, status, classification_json, delegation_json,"
            " created_at, updated_at) VALUES ('tsk_legacy', 'p', 'completed', ?, ?, 'now', 'now')",
            (
                json.dumps(
                    {
                        "complexity_level": "level_1_simple",
                        "recommended_model": "cheap_model",
                        "complexity_score": 1.0,
                        "requires_human_review": False,
                        "subtasks": [],
                    }
                ),
                json.dumps(
                    {
                        "executions": [
                            {"model_used": "ollama-qwen:qwen2.5:7b", "backend": "cli", "status": "completed"}
                        ]
                    }
                ),
            ),
        )
    conn.close()

    TaskStore(db)  # re-open: runs the backfill over the legacy row

    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT provider_name, model_id FROM runs WHERE task_id = 'tsk_legacy'").fetchone()
    finally:
        conn.close()
    assert row["provider_name"] == "ollama-qwen"
    assert row["model_id"] == "qwen2.5:7b"
