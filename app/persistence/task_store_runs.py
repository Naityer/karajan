"""Task storage: runs."""

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


class RunsMixin:
    def search_tasks(self, query: str, limit: int = 20) -> list[dict]:
        """Full-text search over tasks (title/summary/tags/task_type/full prompt).

        Uses FTS5 `MATCH` with `bm25()` relevance ranking when available,
        joining back to `tasks_v2` for the full row. Falls back to a `LIKE`
        scan over `title`/`summary`/`task_type` when FTS5 is unavailable on this
        machine (portability) or when a MATCH query raises (e.g. the user typed
        malformed FTS syntax) — never crashes on user input.
        """
        query = (query or "").strip()
        if not query:
            return []
        with self._connect() as conn:
            if self._fts_available:
                try:
                    rows = conn.execute(
                        """
                        SELECT tv2.*, bm25(tasks_fts) AS rank
                        FROM tasks_fts
                        JOIN tasks_v2 tv2 ON tv2.rowid = tasks_fts.rowid
                        WHERE tasks_fts MATCH ?
                        ORDER BY rank
                        LIMIT ?
                        """,
                        (query, limit),
                    ).fetchall()
                    return [dict(row) for row in rows]
                except sqlite3.OperationalError:
                    # Malformed MATCH syntax etc. — degrade to LIKE below.
                    pass
            like = f"%{query}%"
            rows = conn.execute(
                """
                SELECT * FROM tasks_v2
                WHERE title LIKE ? OR summary LIKE ? OR task_type LIKE ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (like, like, like, limit),
            ).fetchall()
            return [dict(row) for row in rows]

    def record_run(
        self,
        task_id: str,
        provider_name: str | None,
        routing_entity_id: str | None,
        routing_entity_name_snapshot: str | None,
        model_id: str | None,
        backend: str | None,
        status: str,
        started_at: str | None,
        completed_at: str | None,
        latency_ms: int | None,
        input_tokens: int | None,
        output_tokens: int | None,
        estimated_cost_usd: float | None,
        error: str | None,
    ) -> str:
        """Persist one real run and return its id.

        `run_index` is computed under `BEGIN IMMEDIATE` (not a plain SELECT then
        INSERT) so two runs for the same task recorded concurrently from
        different worker threads (parallel delegation, or the queue scheduler's
        `asyncio.to_thread` calls) never race onto the same index — the write
        lock is taken before the index is read, and WAL + `busy_timeout=5000`
        (see `_connect`) let concurrent readers proceed regardless.
        """
        run_id = f"run_{uuid4().hex[:16]}"
        conn = self._connect()
        conn.isolation_level = None  # manual transaction control for BEGIN IMMEDIATE
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT COALESCE(MAX(run_index), -1) + 1 AS next_index FROM runs WHERE task_id = ?",
                (task_id,),
            ).fetchone()
            run_index = row["next_index"]
            conn.execute(
                """
                INSERT INTO runs (
                    id, task_id, run_index, provider_name, routing_entity_id,
                    routing_entity_name_snapshot, model_id, backend, status,
                    started_at, completed_at, latency_ms, input_tokens, output_tokens,
                    estimated_cost_usd, error
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_id, task_id, run_index, provider_name, routing_entity_id,
                    routing_entity_name_snapshot, model_id, backend, status,
                    started_at, completed_at, latency_ms, input_tokens, output_tokens,
                    estimated_cost_usd, error,
                ),
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()
        return run_id

    def list_runs(self, task_id: str) -> list[dict]:
        with self._connect() as conn:
            try:
                rows = conn.execute(
                    "SELECT * FROM runs WHERE task_id = ? ORDER BY run_index", (task_id,)
                ).fetchall()
            except sqlite3.DatabaseError:
                rows = []
        return [dict(row) for row in rows]

    def open_run(
        self,
        task_id: str,
        provider_name: str | None,
        routing_entity_id: str | None,
        routing_entity_name_snapshot: str | None,
        model_id: str | None,
        backend: str | None,
    ) -> str:
        """Insert a `running` run up front and return its id.

        The one-shot path calls `record_run` once the execution is over, but an
        agent session emits tool events *while* it runs — those events need a
        `run_id` to point at before there is any result to record. This is that
        id. Pair every `open_run` with a `close_run`; `record_run` stays the
        single-call path so no existing caller or test changes.
        """
        run_id = f"run_{uuid4().hex[:16]}"
        conn = self._connect()
        conn.isolation_level = None  # manual transaction control for BEGIN IMMEDIATE
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT COALESCE(MAX(run_index), -1) + 1 AS next_index FROM runs WHERE task_id = ?",
                (task_id,),
            ).fetchone()
            conn.execute(
                """
                INSERT INTO runs (
                    id, task_id, run_index, provider_name, routing_entity_id,
                    routing_entity_name_snapshot, model_id, backend, status, started_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
                """,
                (
                    run_id, task_id, row["next_index"], provider_name, routing_entity_id,
                    routing_entity_name_snapshot, model_id, backend, _now_iso(),
                ),
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()
        return run_id

    def close_run(
        self,
        run_id: str,
        status: str,
        latency_ms: int | None = None,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        estimated_cost_usd: float | None = None,
        error: str | None = None,
    ) -> None:
        """Finalize a run opened with `open_run`. Never raises on an unknown id."""
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE runs
                   SET status = ?, completed_at = ?, latency_ms = ?, input_tokens = ?,
                       output_tokens = ?, estimated_cost_usd = ?, error = ?
                 WHERE id = ?
                """,
                (
                    status, _now_iso(), latency_ms, input_tokens,
                    output_tokens, estimated_cost_usd, error, run_id,
                ),
            )

    def record_run_event(self, run_id: str, event_type: str, payload: dict | None = None) -> str:
        """Append one entry to a run's execution trace.

        Tracing must never be able to break the run it is tracing, so an
        unserializable payload is degraded to a note instead of raising.
        """
        event_id = f"rev_{uuid4().hex[:16]}"
        try:
            payload_json = json.dumps(payload, ensure_ascii=False) if payload is not None else None
        except (TypeError, ValueError):
            payload_json = json.dumps({"unserializable": repr(payload)[:500]})
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO run_events (id, run_id, event_type, ts, payload_json) VALUES (?, ?, ?, ?, ?)",
                (event_id, run_id, event_type, _now_iso(), payload_json),
            )
        return event_id

    def list_run_events(self, run_id: str, limit: int = 500, offset: int = 0) -> list[dict]:
        """Chronological trace for one run, with `payload_json` already decoded."""
        with self._connect() as conn:
            try:
                rows = conn.execute(
                    "SELECT * FROM run_events WHERE run_id = ? ORDER BY ts, rowid LIMIT ? OFFSET ?",
                    (run_id, limit, offset),
                ).fetchall()
            except sqlite3.DatabaseError:
                rows = []
        events: list[dict] = []
        for row in rows:
            entry = dict(row)
            raw = entry.pop("payload_json", None)
            try:
                entry["payload"] = json.loads(raw) if raw else None
            except (TypeError, ValueError):
                entry["payload"] = None
            events.append(entry)
        return events

    def record_artifact(
        self,
        task_id: str,
        run_id: str | None,
        kind: str,
        file_path: str,
        size_bytes: int | None = None,
        content_hash: str | None = None,
    ) -> str:
        """Record a file an agent touched. `file_path` must be workspace-relative."""
        artifact_id = f"art_{uuid4().hex[:16]}"
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO artifacts (
                    id, task_id, run_id, kind, file_path, size_bytes, content_hash, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (artifact_id, task_id, run_id, kind, file_path, size_bytes, content_hash, _now_iso()),
            )
        return artifact_id

    def list_artifacts(self, task_id: str) -> list[dict]:
        with self._connect() as conn:
            try:
                rows = conn.execute(
                    "SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at, rowid", (task_id,)
                ).fetchall()
            except sqlite3.DatabaseError:
                rows = []
        return [dict(row) for row in rows]

    def agent_performance(self) -> list[dict]:
        """Provider-keyed aggregation over `runs` — the concrete replacement for
        `monitoring._execution_owner()`'s fuzzy model-name/level-alias matching."""
        with self._connect() as conn:
            try:
                rows = conn.execute(
                    """
                    SELECT
                        provider_name,
                        COUNT(*) AS task_count,
                        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS error_count,
                        AVG(latency_ms) AS avg_latency_ms,
                        SUM(estimated_cost_usd) AS total_cost,
                        SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS total_tokens
                    FROM runs
                    WHERE provider_name IS NOT NULL
                    GROUP BY provider_name
                    """
                ).fetchall()
            except sqlite3.DatabaseError:
                rows = []
        return [
            {
                "provider_name": row["provider_name"],
                "task_count": row["task_count"],
                "error_count": row["error_count"] or 0,
                "avg_latency_ms": row["avg_latency_ms"],
                "total_cost": round(row["total_cost"] or 0.0, 5),
                "total_tokens": row["total_tokens"] or 0,
            }
            for row in rows
        ]
