"""Task storage: queries."""

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


class QueriesMixin:
    def _record_metrics_snapshot(self, conn: sqlite3.Connection, when: datetime) -> None:
        """Append a metrics-history row reflecting current aggregate totals.

        Called from the same connection/transaction as save_delegation so the
        snapshot always corresponds to a real state transition (a task just
        completed), not an arbitrary poll tick.
        """
        agg = conn.execute(
            """
            SELECT
                COUNT(*) AS total,
                COALESCE(SUM(est_cost), 0.0) AS cost,
                COALESCE(AVG(
                    CASE WHEN delegation_json IS NOT NULL THEN
                        json_extract(delegation_json, '$.total_latency_ms')
                    END
                ), 0) AS avg_latency
            FROM tasks
            """
        ).fetchone()
        total_tokens = 0
        for row in conn.execute(
            "SELECT delegation_json FROM tasks WHERE delegation_json IS NOT NULL"
        ).fetchall():
            delegation = json.loads(row["delegation_json"])
            total_tokens += delegation.get("total_input_tokens", 0) + delegation.get("total_output_tokens", 0)
        conn.execute(
            """
            INSERT INTO metrics_history (timestamp, total_tasks, total_estimated_cost_usd, total_tokens, avg_latency_ms)
            VALUES (?, ?, ?, ?, ?)
            """,
            (when.isoformat(), agg["total"], round(agg["cost"], 5), total_tokens, int(agg["avg_latency"] or 0)),
        )

    def metrics_history(self, limit: int = 200) -> MetricsHistory:
        with self._connect() as conn:
            try:
                rows = conn.execute(
                    "SELECT * FROM metrics_history ORDER BY timestamp DESC LIMIT ?", (limit,)
                ).fetchall()
            except sqlite3.DatabaseError:
                rows = []
        points = [
            MetricsHistoryPoint(
                timestamp=datetime.fromisoformat(row["timestamp"]),
                total_tasks=row["total_tasks"],
                total_estimated_cost_usd=row["total_estimated_cost_usd"],
                total_tokens=row["total_tokens"],
                avg_latency_ms=row["avg_latency_ms"],
            )
            for row in rows
        ]
        points.reverse()  # oldest first, for charting left-to-right
        return MetricsHistory(points=points)

    def add_decisions(self, decisions: list[DecisionLogEntry]) -> None:
        """Append decision-log entries (e.g. reported live by the model)."""
        if not decisions:
            return
        with self._connect() as conn:
            self._insert_decisions(conn, decisions)

    def _insert_decisions(self, conn: sqlite3.Connection, decisions: list[DecisionLogEntry]) -> None:
        conn.executemany(
            """
            INSERT OR REPLACE INTO decisions (id, task_id, phase, decision, score, backend, reason, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    entry.id,
                    entry.task_id,
                    entry.phase,
                    entry.decision,
                    entry.score,
                    entry.backend.value if entry.backend else None,
                    entry.reason,
                    entry.created_at.isoformat(),
                )
                for entry in decisions
            ],
        )

    def save_reviews(self, task_id: str, campos: dict[str, list[str]], revisado_en: str) -> None:
        """Sustituye la revisión de una tarea (los campos de su cabecera en el baúl)."""
        with self._connect() as conn:
            conn.execute("DELETE FROM reviews WHERE task_id = ?", (task_id,))
            conn.executemany(
                "INSERT OR IGNORE INTO reviews (task_id, campo, valor, revisado_en) VALUES (?, ?, ?, ?)",
                [(task_id, campo, valor, revisado_en) for campo, valores in campos.items() for valor in valores if valor],
            )

    def list_reviews(self) -> dict[str, dict[str, list[str]]]:
        with self._connect() as conn:
            try:
                rows = conn.execute("SELECT task_id, campo, valor FROM reviews ORDER BY task_id, campo, valor").fetchall()
            except sqlite3.DatabaseError:
                rows = []
        salida: dict[str, dict[str, list[str]]] = {}
        for row in rows:
            salida.setdefault(row["task_id"], {}).setdefault(row["campo"], []).append(row["valor"])
        return salida

    def list_decisions(self, task_id: str | None = None) -> list[DecisionLogEntry]:
        with self._connect() as conn:
            try:
                if task_id is None:
                    rows = conn.execute("SELECT * FROM decisions ORDER BY created_at").fetchall()
                else:
                    rows = conn.execute(
                        "SELECT * FROM decisions WHERE task_id = ? ORDER BY created_at", (task_id,)
                    ).fetchall()
            except sqlite3.DatabaseError:
                rows = []
        entries: list[DecisionLogEntry] = []
        for row in rows:
            try:
                entries.append(DecisionLogEntry(
                    id=row["id"],
                    task_id=row["task_id"],
                    phase=row["phase"],
                    decision=row["decision"],
                    score=row["score"],
                    backend=row["backend"],
                    reason=row["reason"] or "",
                    created_at=datetime.fromisoformat(row["created_at"]),
                ))
            except Exception:
                continue
        return entries

    def get_task(self, task_id: str) -> TaskRecord:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
        if row is None:
            raise KeyError(task_id)
        return self._row_to_record(row)

    def list_tasks(self, limit: int | None = None, offset: int = 0) -> list[TaskRecord]:
        query = "SELECT * FROM tasks ORDER BY created_at DESC"
        params: list[int] = []
        if limit is not None:
            query += " LIMIT ? OFFSET ?"
            params = [limit, offset]
        with self._connect() as conn:
            try:
                rows = conn.execute(query, params).fetchall()
            except sqlite3.DatabaseError:
                # WAL corruption fallback: fetch rows one at a time by rowid,
                # skipping any that touch corrupted pages.
                rows = []
                try:
                    ids = conn.execute("SELECT rowid FROM tasks ORDER BY rowid DESC").fetchall()
                    for (rowid,) in ids:
                        try:
                            row = conn.execute("SELECT * FROM tasks WHERE rowid = ?", (rowid,)).fetchone()
                            if row:
                                rows.append(row)
                        except sqlite3.DatabaseError:
                            continue
                except sqlite3.DatabaseError:
                    pass
        records: list[TaskRecord] = []
        for row in rows:
            try:
                records.append(self._row_to_record(row))
            except Exception:
                continue
        return records

    def count_tasks(self) -> int:
        with self._connect() as conn:
            return conn.execute("SELECT COUNT(*) AS c FROM tasks").fetchone()["c"]

    def metrics(self) -> Metrics:
        """Aggregate KPIs in SQL from denormalized columns.

        Scalar metrics come straight from indexed columns; only `by_skill` and
        `by_backend` (array-derived) still need a light JSON pass — full
        normalization of those is deferred to the PostgreSQL migration (P2).
        """
        with self._connect() as conn:
            agg = conn.execute(
                """
                SELECT
                    COUNT(*) AS total,
                    COALESCE(SUM(subtask_count), 0) AS subtasks,
                    COALESCE(SUM(requires_review), 0) AS reviews,
                    COALESCE(SUM(est_cost), 0.0) AS cost,
                    COALESCE(AVG(score), 0.0) AS avg_score,
                    COALESCE(SUM(CASE WHEN delegation_json IS NOT NULL THEN 1 ELSE 0 END), 0) AS delegated
                FROM tasks
                """
            ).fetchone()
            by_level = _group(conn, "level")
            by_model = _group(conn, "model")
            by_status = _group(conn, "status")

            by_skill: dict[str, int] = {}
            by_backend: dict[str, int] = {}
            for row in conn.execute(
                "SELECT classification_json, delegation_json FROM tasks"
            ).fetchall():
                classification = json.loads(row["classification_json"])
                for skill in classification.get("recommended_skills", []):
                    by_skill[skill] = by_skill.get(skill, 0) + 1
                for subtask in classification.get("subtasks", []):
                    skill = subtask.get("recommended_skill")
                    if skill:
                        by_skill[skill] = by_skill.get(skill, 0) + 1
                if row["delegation_json"]:
                    for execution in json.loads(row["delegation_json"]).get("executions", []):
                        backend = execution["backend"]
                        by_backend[backend] = by_backend.get(backend, 0) + 1

        total = agg["total"]
        return Metrics(
            total_tasks=total,
            by_level=by_level,
            by_model=by_model,
            by_backend=by_backend,
            by_status=by_status,
            by_skill=by_skill,
            total_subtasks=agg["subtasks"],
            delegated_tasks=agg["delegated"],
            human_review_required=agg["reviews"],
            total_estimated_cost_usd=round(agg["cost"], 5),
            average_complexity_score=round(agg["avg_score"], 2) if total else 0.0,
        )

    def _row_to_record(self, row: sqlite3.Row) -> TaskRecord:
        delegation = row["delegation_json"]
        return TaskRecord(
            task_id=row["task_id"],
            prompt=row["prompt"],
            status=TaskStatus(row["status"]),
            classification=ClassificationResult.model_validate(json.loads(row["classification_json"])),
            delegation=DelegationResult.model_validate(json.loads(delegation)) if delegation else None,
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )
