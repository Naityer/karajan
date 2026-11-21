"""Shared SQLite helpers for task storage."""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from app.providers import catalog
from app.core.logging_config import get_logger, log_event
from app.domain.models import (
    ClassificationResult,
    DecisionLogEntry,
    DelegationResult,
    Metrics,
    MetricsHistory,
    MetricsHistoryPoint,
    TaskRecord,
    TaskStatus,
    TaskV2Status,
)

DEFAULT_DB_PATH = Path("data/task_logs.db")

logger = get_logger("database")

# Denormalized scalar columns kept in sync on write so the dashboard KPIs can be
# aggregated in SQL instead of re-parsing every JSON blob into Pydantic models.
_DENORM_COLUMNS = ("level", "model", "score", "requires_review", "subtask_count", "est_cost")


def _now_iso() -> str:
    """UTC timestamp for the run/trace tables. Sortable as a plain string, which
    is what `list_run_events` orders on."""
    return datetime.now(timezone.utc).isoformat()


def _denorm_values(classification: dict, delegation: dict | None) -> tuple:
    """Scalar projection of a task used for SQL-side metric aggregation.

    Accepts plain dicts (JSON-decoded rows or `model_dump(mode="json")`) so it
    works both on the write path and during the one-off backfill migration.
    """
    return (
        classification["complexity_level"],
        classification["recommended_model"],
        classification["complexity_score"],
        int(classification["requires_human_review"]),
        len(classification.get("subtasks", [])),
        round(delegation["total_estimated_cost_usd"], 5) if delegation else 0.0,
    )


def _group(conn: sqlite3.Connection, column: str) -> dict[str, int]:
    rows = conn.execute(
        f"SELECT {column} AS k, COUNT(*) AS c FROM tasks WHERE {column} IS NOT NULL GROUP BY {column}"
    ).fetchall()
    return {row["k"]: row["c"] for row in rows}
