from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from app.models import (
    ClassificationResult,
    DecisionLogEntry,
    DelegationResult,
    Metrics,
    TaskRecord,
    TaskStatus,
)

DEFAULT_DB_PATH = Path("data/task_logs.db")

# Denormalized scalar columns kept in sync on write so the dashboard KPIs can be
# aggregated in SQL instead of re-parsing every JSON blob into Pydantic models.
_DENORM_COLUMNS = ("level", "model", "score", "requires_review", "subtask_count", "est_cost")


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


class TaskStore:
    def __init__(self, db_path: Path | str = DEFAULT_DB_PATH) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        # WAL lets the dashboard read while a delegation writes, instead of
        # serializing behind a single lock; NORMAL keeps that safe and fast.
        # busy_timeout avoids spurious "database is locked" under contention.
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS tasks (
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
            # Compact, append-only harness decision log for control & monitoring.
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS decisions (
                    id TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL,
                    phase TEXT NOT NULL,
                    decision TEXT NOT NULL,
                    score REAL,
                    backend TEXT,
                    reason TEXT,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_decisions_task ON decisions(task_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at)")
            self._migrate(conn)

    def _migrate(self, conn: sqlite3.Connection) -> None:
        """Add denormalized columns to a pre-existing DB and backfill them once."""
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(tasks)")}
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
    ) -> TaskRecord:
        now = datetime.now(timezone.utc)
        payload = classification.model_dump_json()
        level, model, score, requires_review, subtask_count, est_cost = _denorm_values(
            classification.model_dump(mode="json"), None
        )
        with self._connect() as conn:
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
        return self.get_task(classification.task_id)

    def save_delegation(
        self,
        delegation: DelegationResult,
        decisions: list[DecisionLogEntry] | None = None,
    ) -> TaskRecord:
        now = datetime.now(timezone.utc)
        with self._connect() as conn:
            cursor = conn.execute("SELECT task_id FROM tasks WHERE task_id = ?", (delegation.task_id,))
            if cursor.fetchone() is None:
                raise KeyError(delegation.task_id)
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
        return self.get_task(delegation.task_id)

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
