"""Task storage: writes."""

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

from .task_store_common import DEFAULT_DB_PATH, _DENORM_COLUMNS, _now_iso, _denorm_values, _group, logger


class WritesMixin:
    def _migrate(self, conn: sqlite3.Connection) -> None:
        """Add denormalized columns to a pre-existing DB and backfill them once."""
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(tasks)")}
        if "schema_version" not in existing:
            conn.execute(
                "ALTER TABLE tasks ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1"
            )
            existing.add("schema_version")
        added = False
        for column in _DENORM_COLUMNS:
            if column not in existing:
                sql_type = "INTEGER" if column in ("requires_review", "subtask_count") else (
                    "REAL" if column in ("score", "est_cost") else "TEXT"
                )
                conn.execute(f"ALTER TABLE tasks ADD COLUMN {column} {sql_type}")
                added = True
        if not added:
            return
        rows = conn.execute(
            "SELECT task_id, classification_json, delegation_json FROM tasks WHERE level IS NULL"
        ).fetchall()
        for row in rows:
            classification = json.loads(row["classification_json"])
            delegation = json.loads(row["delegation_json"]) if row["delegation_json"] else None
            conn.execute(
                """
                UPDATE tasks
                SET level = ?, model = ?, score = ?, requires_review = ?, subtask_count = ?, est_cost = ?
                WHERE task_id = ?
                """,
                (*_denorm_values(classification, delegation), row["task_id"]),
            )

    def save_classification(
        self,
        classification: ClassificationResult,
        decision: DecisionLogEntry | None = None,
        *,
        workspace_id: str = "default",
        operation_name: str = "classify",
        idempotency_key: str = "",
        payload_hash: str = "",
        outbox_events: list[dict] | None = None,
    ) -> TaskRecord:
        now = datetime.now(timezone.utc)
        payload = classification.model_dump_json()
        level, model, score, requires_review, subtask_count, est_cost = _denorm_values(
            classification.model_dump(mode="json"), None
        )
        with self._connect() as conn:
            if idempotency_key:
                conn.execute(
                    """
                    INSERT INTO idempotency_keys (
                        workspace_id, operation_name, idempotency_key,
                        payload_hash, task_id, created_at, schema_version
                    ) VALUES (?, ?, ?, ?, ?, ?, 1)
                    """,
                    (
                        workspace_id,
                        operation_name,
                        idempotency_key,
                        payload_hash,
                        classification.task_id,
                        now.isoformat(),
                    ),
                )
            conn.execute(
                """
                INSERT INTO tasks (
                    task_id, prompt, status, classification_json, delegation_json,
                    created_at, updated_at,
                    level, model, score, requires_review, subtask_count, est_cost
                )
                VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    classification.task_id,
                    classification.original_prompt,
                    TaskStatus.CLASSIFIED.value,
                    payload,
                    classification.created_at.isoformat(),
                    now.isoformat(),
                    level,
                    model,
                    score,
                    requires_review,
                    subtask_count,
                    est_cost,
                ),
            )
            if decision is not None:
                self._insert_decisions(conn, [decision])
            self._insert_outbox(conn, outbox_events or [])
            self._upsert_task_v2(
                conn,
                task_id=classification.task_id,
                prompt=classification.original_prompt,
                classification=classification.model_dump(mode="json"),
                status=TaskStatus.CLASSIFIED,
                created_at=classification.created_at.isoformat(),
                updated_at=now.isoformat(),
                completed_at=None,
            )
        return self.get_task(classification.task_id)

    def mark_status(
        self,
        task_id: str,
        status: TaskStatus,
        *,
        outbox_events: list[dict] | None = None,
    ) -> TaskRecord:
        """Flip a task's status without requiring a full `DelegationResult`.

        Used by the async queue dispatcher to record `queued` the instant a
        task is accepted, before any subtask has actually run.
        """
        now = datetime.now(timezone.utc)
        with self._connect() as conn:
            cursor = conn.execute(
                "SELECT task_id, prompt, classification_json, created_at FROM tasks WHERE task_id = ?",
                (task_id,),
            )
            row = cursor.fetchone()
            if row is None:
                raise KeyError(task_id)
            conn.execute(
                "UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?",
                (status.value, now.isoformat(), task_id),
            )
            classification = json.loads(row["classification_json"]) if row["classification_json"] else {}
            self._upsert_task_v2(
                conn,
                task_id=task_id,
                prompt=row["prompt"] or "",
                classification=classification,
                status=status,
                created_at=row["created_at"],
                updated_at=now.isoformat(),
                completed_at=None,
            )
            self._insert_outbox(conn, outbox_events or [])
        return self.get_task(task_id)

    def save_delegation(
        self,
        delegation: DelegationResult,
        decisions: list[DecisionLogEntry] | None = None,
        *,
        outbox_events: list[dict] | None = None,
        workspace_id: str = "default",
        operation_name: str = "execute",
        idempotency_key: str = "",
        payload_hash: str = "",
    ) -> TaskRecord:
        now = datetime.now(timezone.utc)
        with self._connect() as conn:
            cursor = conn.execute(
                "SELECT task_id, prompt, classification_json, created_at FROM tasks WHERE task_id = ?",
                (delegation.task_id,),
            )
            row = cursor.fetchone()
            if row is None:
                raise KeyError(delegation.task_id)
            if idempotency_key:
                conn.execute(
                    """
                    INSERT INTO idempotency_keys (
                        workspace_id, operation_name, idempotency_key,
                        payload_hash, task_id, created_at, schema_version
                    ) VALUES (?, ?, ?, ?, ?, ?, 1)
                    """,
                    (
                        workspace_id,
                        operation_name,
                        idempotency_key,
                        payload_hash,
                        delegation.task_id,
                        now.isoformat(),
                    ),
                )
            conn.execute(
                """
                UPDATE tasks
                SET status = ?, delegation_json = ?, updated_at = ?, est_cost = ?
                WHERE task_id = ?
                """,
                (
                    delegation.status.value,
                    delegation.model_dump_json(),
                    now.isoformat(),
                    round(delegation.total_estimated_cost_usd, 5),
                    delegation.task_id,
                ),
            )
            if decisions:
                self._insert_decisions(conn, decisions)
            self._insert_outbox(conn, outbox_events or [])
            self._record_metrics_snapshot(conn, now)
            classification = json.loads(row["classification_json"]) if row["classification_json"] else {}
            completed_at = (
                delegation.completed_at.isoformat()
                if delegation.status in (TaskStatus.COMPLETED, TaskStatus.FAILED)
                else None
            )
            self._upsert_task_v2(
                conn,
                task_id=delegation.task_id,
                prompt=row["prompt"] or "",
                classification=classification,
                status=delegation.status,
                created_at=row["created_at"],
                updated_at=now.isoformat(),
                completed_at=completed_at,
            )
        return self.get_task(delegation.task_id)

    def get_idempotency(
        self, workspace_id: str, operation_name: str, idempotency_key: str
    ) -> dict | None:
        if not idempotency_key:
            return None
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT payload_hash, task_id, created_at, schema_version
                FROM idempotency_keys
                WHERE workspace_id = ? AND operation_name = ? AND idempotency_key = ?
                """,
                (workspace_id, operation_name, idempotency_key),
            ).fetchone()
        return dict(row) if row is not None else None

    @staticmethod
    def _insert_outbox(conn: sqlite3.Connection, events: list[dict]) -> None:
        for event in events:
            conn.execute(
                """
                INSERT INTO domain_outbox (
                    event_id, event_type, aggregate_id, correlation_id,
                    payload_json, occurred_at, schema_version
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event["event_id"],
                    event["event_type"],
                    event["aggregate_id"],
                    event["correlation_id"],
                    json.dumps(event.get("payload", {}), sort_keys=True),
                    event["occurred_at"],
                    int(event.get("schema_version", 1)),
                ),
            )

    def list_pending_outbox(self, limit: int = 100) -> list[dict]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT event_id, event_type, aggregate_id, correlation_id,
                       payload_json, occurred_at, attempts, schema_version
                FROM domain_outbox
                WHERE delivered_at IS NULL
                ORDER BY occurred_at ASC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [
            {
                **dict(row),
                "payload": json.loads(row["payload_json"]),
            }
            for row in rows
        ]

    def mark_outbox_delivered(self, event_id: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE domain_outbox
                SET delivered_at = ?, attempts = attempts + 1
                WHERE event_id = ? AND delivered_at IS NULL
                """,
                (_now_iso(), event_id),
            )

    def record_outbox_attempt(self, event_id: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "UPDATE domain_outbox SET attempts = attempts + 1 WHERE event_id = ?",
                (event_id,),
            )
