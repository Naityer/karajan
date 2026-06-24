from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from app import monitoring
from app.models import (
    ClassificationResult,
    DecisionLogEntry,
    DelegationResult,
    Metrics,
    TaskRecord,
    TaskStatus,
)

DEFAULT_DB_PATH = Path("data/task_logs.db")


class TaskStore:
    def __init__(self, db_path: Path | str = DEFAULT_DB_PATH) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
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
                    updated_at TEXT NOT NULL
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

    def save_classification(
        self,
        classification: ClassificationResult,
        decision: DecisionLogEntry | None = None,
    ) -> TaskRecord:
        now = datetime.now(timezone.utc)
        payload = classification.model_dump_json()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO tasks (task_id, prompt, status, classification_json, delegation_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, NULL, ?, ?)
                """,
                (
                    classification.task_id,
                    classification.original_prompt,
                    TaskStatus.CLASSIFIED.value,
                    payload,
                    classification.created_at.isoformat(),
                    now.isoformat(),
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
                SET status = ?, delegation_json = ?, updated_at = ?
                WHERE task_id = ?
                """,
                (
                    delegation.status.value,
                    delegation.model_dump_json(),
                    now.isoformat(),
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
            if task_id is None:
                rows = conn.execute("SELECT * FROM decisions ORDER BY created_at").fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM decisions WHERE task_id = ? ORDER BY created_at", (task_id,)
                ).fetchall()
        return [
            DecisionLogEntry(
                id=row["id"],
                task_id=row["task_id"],
                phase=row["phase"],
                decision=row["decision"],
                score=row["score"],
                backend=row["backend"],
                reason=row["reason"] or "",
                created_at=datetime.fromisoformat(row["created_at"]),
            )
            for row in rows
        ]

    def get_task(self, task_id: str) -> TaskRecord:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
        if row is None:
            raise KeyError(task_id)
        return self._row_to_record(row)

    def list_tasks(self) -> list[TaskRecord]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM tasks ORDER BY created_at DESC").fetchall()
        return [self._row_to_record(row) for row in rows]

    def metrics(self) -> Metrics:
        return monitoring.compute_metrics(self.list_tasks())

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
