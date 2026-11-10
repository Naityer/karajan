"""Task storage: schema."""

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


class SchemaMixin:
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
                    est_cost REAL,
                    schema_version INTEGER NOT NULL DEFAULT 1
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
            # Lo que el usuario revisa en la nota del baúl (cabecera de agente): manda sobre lo clasificado en la analítica.
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS reviews (
                    task_id TEXT NOT NULL,
                    campo TEXT NOT NULL,
                    valor TEXT NOT NULL,
                    revisado_en TEXT NOT NULL,
                    PRIMARY KEY (task_id, campo, valor)
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at)")
            # Rolling snapshot of aggregate KPIs, one row per completed delegation —
            # lets the Monitor view chart cost/tokens/latency trends over time
            # instead of only showing the current totals.
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS metrics_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    total_tasks INTEGER NOT NULL,
                    total_estimated_cost_usd REAL NOT NULL,
                    total_tokens INTEGER NOT NULL DEFAULT 0,
                    avg_latency_ms INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_metrics_history_ts ON metrics_history(timestamp)")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS idempotency_keys (
                    workspace_id TEXT NOT NULL,
                    operation_name TEXT NOT NULL,
                    idempotency_key TEXT NOT NULL,
                    payload_hash TEXT NOT NULL,
                    task_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    schema_version INTEGER NOT NULL DEFAULT 1,
                    PRIMARY KEY (workspace_id, operation_name, idempotency_key)
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS domain_outbox (
                    event_id TEXT PRIMARY KEY,
                    event_type TEXT NOT NULL,
                    aggregate_id TEXT NOT NULL,
                    correlation_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    occurred_at TEXT NOT NULL,
                    delivered_at TEXT,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    schema_version INTEGER NOT NULL DEFAULT 1
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_outbox_pending "
                "ON domain_outbox(delivered_at, occurred_at)"
            )
            self._migrate(conn)
            self._init_schema_v2(conn)
            self._seed_project(conn)
            self._backfill_v2(conn)
            self._init_fts(conn)

    def _init_schema_v2(self, conn: sqlite3.Connection) -> None:
        """Fase 1 schema: Task/Run/Project model with stable provider attribution.

        New tables only (`CREATE TABLE IF NOT EXISTS`) — nothing existing is
        renamed or dropped; `tasks`/`decisions`/`metrics_history` are untouched
        and keep working exactly as before during/after this migration.
        """
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tasks_v2 (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                legacy_task_id TEXT UNIQUE,
                title TEXT,
                task_type TEXT,
                status TEXT NOT NULL,
                priority TEXT,
                tags_json TEXT,
                summary TEXT,
                created_at TEXT NOT NULL,
                completed_at TEXT,
                updated_at TEXT NOT NULL
                ,schema_version INTEGER NOT NULL DEFAULT 1
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_v2_legacy ON tasks_v2(legacy_task_id)")
        v2_columns = {row["name"] for row in conn.execute("PRAGMA table_info(tasks_v2)")}
        if "schema_version" not in v2_columns:
            conn.execute(
                "ALTER TABLE tasks_v2 ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1"
            )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS task_history (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                from_status TEXT,
                to_status TEXT NOT NULL,
                changed_at TEXT NOT NULL,
                note TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_task_history_task ON task_history(task_id)")
        # `runs` is the concrete fix for the fuzzy `_execution_owner()` attribution
        # bug: `provider_name` is a stable catalog constant (see app/providers/catalog.py),
        # never a user-editable routing-diagram node id, so `GROUP BY provider_name`
        # is safe to aggregate on even after the diagram is reshaped.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                run_index INTEGER NOT NULL,
                provider_name TEXT,
                routing_entity_id TEXT,
                routing_entity_name_snapshot TEXT,
                model_id TEXT,
                backend TEXT,
                status TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                latency_ms INTEGER,
                input_tokens INTEGER,
                output_tokens INTEGER,
                estimated_cost_usd REAL,
                error TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_runs_provider ON runs(provider_name)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id)")
        # `run_events` and `artifacts` were shipped empty as Fase-1 groundwork;
        # the agent-tools loop is what finally populates them (one row per tool
        # call / per file touched). `evaluations` is still unpopulated.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS run_events (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                ts TEXT NOT NULL,
                payload_json TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS evaluations (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                value REAL,
                comment TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS artifacts (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                run_id TEXT,
                kind TEXT NOT NULL,
                file_path TEXT NOT NULL,
                size_bytes INTEGER,
                content_hash TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        # Both traces are always read by their parent key, never scanned.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS comments (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                author TEXT,
                body TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )

    def create_project_if_missing(self) -> None:
        """Public, idempotent entry point to seed `proj_default` on demand."""
        with self._connect() as conn:
            self._seed_project(conn)

    def _seed_project(self, conn: sqlite3.Connection) -> None:
        row = conn.execute("SELECT COUNT(*) AS c FROM projects").fetchone()
        if row["c"] == 0:
            conn.execute(
                "INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)",
                ("proj_default", "Default", datetime.now(timezone.utc).isoformat()),
            )

    @staticmethod
    def _map_status_v2(status: TaskStatus) -> str:
        """Deterministic legacy `TaskStatus` -> broader `TaskV2Status` mapping.

        `running`/`archived` exist in the v2 vocabulary but nothing in the
        current flow produces them yet — acceptable, matches the plan.
        """
        mapping = {
            TaskStatus.CLASSIFIED: TaskV2Status.DRAFT,
            TaskStatus.QUEUED: TaskV2Status.QUEUED,
            TaskStatus.DELEGATED: TaskV2Status.WAITING_HUMAN,
            TaskStatus.COMPLETED: TaskV2Status.COMPLETED,
            TaskStatus.FAILED: TaskV2Status.FAILED,
        }
        return mapping.get(status, TaskV2Status.DRAFT).value

    def _upsert_task_v2(
        self,
        conn: sqlite3.Connection,
        task_id: str,
        prompt: str,
        classification: dict,
        status: TaskStatus,
        created_at: str,
        updated_at: str,
        completed_at: str | None = None,
    ) -> None:
        """Dual-write a `tasks_v2` row alongside the legacy `tasks` row.

        `legacy_task_id` holds the SAME `task_id` used by the old `tasks` table
        for both migrated AND newly-created (post-Fase-1) tasks — there is no
        separate id scheme, `tasks_v2` is a richer projection of the same task
        identity. Also appends a `task_history` row whenever the v2 status
        actually changes (including the initial creation).
        """
        status_v2 = self._map_status_v2(status)
        title = (prompt or "")[:80]
        task_type = classification.get("intent") if classification else None
        existing = conn.execute(
            "SELECT id, status FROM tasks_v2 WHERE legacy_task_id = ?", (task_id,)
        ).fetchone()
        if existing is None:
            new_id = f"tv2_{uuid4().hex[:16]}"
            conn.execute(
                """
                INSERT INTO tasks_v2 (
                    id, project_id, legacy_task_id, title, task_type, status,
                    priority, tags_json, summary, created_at, completed_at, updated_at
                )
                VALUES (?, 'proj_default', ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)
                """,
                (new_id, task_id, title, task_type, status_v2, created_at, completed_at, updated_at),
            )
            conn.execute(
                """
                INSERT INTO task_history (id, task_id, from_status, to_status, changed_at, note)
                VALUES (?, ?, NULL, ?, ?, ?)
                """,
                (f"th_{uuid4().hex[:16]}", new_id, status_v2, updated_at, "created"),
            )
        else:
            v2_id = existing["id"]
            prior_status = existing["status"]
            conn.execute(
                """
                UPDATE tasks_v2
                SET status = ?, task_type = COALESCE(?, task_type),
                    completed_at = COALESCE(?, completed_at), updated_at = ?
                WHERE id = ?
                """,
                (status_v2, task_type, completed_at, updated_at, v2_id),
            )
            if prior_status != status_v2:
                conn.execute(
                    """
                    INSERT INTO task_history (id, task_id, from_status, to_status, changed_at, note)
                    VALUES (?, ?, ?, ?, ?, NULL)
                    """,
                    (f"th_{uuid4().hex[:16]}", v2_id, prior_status, status_v2, updated_at),
                )

    def _read_legacy_tasks_tolerant(self, conn: sqlite3.Connection) -> list[sqlite3.Row]:
        """Same corruption-tolerant rowid-scan fallback as `list_tasks` (~line 353),
        reused here so a corrupted page skips one row during migration instead of
        aborting the whole backfill."""
        columns = "task_id, prompt, status, classification_json, delegation_json, created_at, updated_at"
        try:
            return conn.execute(f"SELECT {columns} FROM tasks ORDER BY rowid").fetchall()
        except sqlite3.DatabaseError:
            rows: list[sqlite3.Row] = []
            try:
                ids = conn.execute("SELECT rowid FROM tasks ORDER BY rowid").fetchall()
                for (rowid,) in ids:
                    try:
                        row = conn.execute(
                            f"SELECT {columns} FROM tasks WHERE rowid = ?", (rowid,)
                        ).fetchone()
                        if row:
                            rows.append(row)
                    except sqlite3.DatabaseError:
                        continue
            except sqlite3.DatabaseError:
                pass
            return rows

    def _backfill_v2(self, conn: sqlite3.Connection) -> None:
        """One-shot, idempotent migration: legacy `tasks` -> `tasks_v2` + `runs`.

        Guarded by "tasks_v2 empty AND tasks has rows" so it only ever runs
        once. Tolerates the known corruption history in `data/` — each row's
        migration is independently try/excepted (log + skip + continue) so one
        malformed historical row never aborts the whole backfill.
        """
        count_row = conn.execute("SELECT COUNT(*) AS c FROM tasks_v2").fetchone()
        if count_row["c"] > 0:
            return
        legacy_rows = self._read_legacy_tasks_tolerant(conn)
        if not legacy_rows:
            return

        migrated_tasks = 0
        skipped_tasks = 0
        migrated_runs = 0
        skipped_runs = 0

        for row in legacy_rows:
            task_id = row["task_id"]
            try:
                status = TaskStatus(row["status"])
                classification = json.loads(row["classification_json"]) if row["classification_json"] else {}
                delegation = json.loads(row["delegation_json"]) if row["delegation_json"] else None
                completed_at = delegation.get("completed_at") if delegation else None
                self._upsert_task_v2(
                    conn,
                    task_id=task_id,
                    prompt=row["prompt"] or "",
                    classification=classification,
                    status=status,
                    created_at=row["created_at"],
                    updated_at=row["updated_at"],
                    completed_at=completed_at,
                )
                migrated_tasks += 1
            except Exception as exc:  # noqa: BLE001 - one bad legacy row must not abort the backfill
                skipped_tasks += 1
                log_event(
                    logger, logging.WARNING, "backfill_v2_task_skipped",
                    task_id=task_id, error=f"{type(exc).__name__}: {exc}",
                )
                continue

            if not delegation:
                continue
            executions = delegation.get("executions") or []
            for index, execution in enumerate(executions):
                try:
                    # Pre-Fase-1 rows never persisted a real `provider_name`;
                    # all they have is `model_used` (`"<provider>:<model>"`).
                    # It is *split* rather than copied wholesale into both
                    # columns: writing `ollama-qwen:qwen2.5:7b` into
                    # `provider_name` is what used to make one agent show up
                    # twice in every `GROUP BY provider_name` aggregate. When
                    # the prefix matches no catalog provider, both stay NULL —
                    # an unattributed run is honest, a guessed one is not.
                    legacy_provider, legacy_model = catalog.split_model_used(
                        execution.get("model_used")
                    )
                    conn.execute(
                        """
                        INSERT INTO runs (
                            id, task_id, run_index, provider_name, routing_entity_id,
                            routing_entity_name_snapshot, model_id, backend, status,
                            started_at, completed_at, latency_ms, input_tokens, output_tokens,
                            estimated_cost_usd, error
                        )
                        VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            f"run_{uuid4().hex[:16]}",
                            task_id,
                            index,
                            legacy_provider,
                            legacy_model,
                            execution.get("backend"),
                            execution.get("status"),
                            completed_at,
                            execution.get("latency_ms"),
                            execution.get("input_tokens", 0),
                            execution.get("output_tokens", 0),
                            execution.get("estimated_cost_usd"),
                            execution.get("error"),
                        ),
                    )
                    migrated_runs += 1
                except Exception as exc:  # noqa: BLE001 - same tolerance, per-execution
                    skipped_runs += 1
                    log_event(
                        logger, logging.WARNING, "backfill_v2_run_skipped",
                        task_id=task_id, index=index, error=f"{type(exc).__name__}: {exc}",
                    )
                    continue

        log_event(
            logger, logging.INFO, "backfill_v2_completed",
            total_legacy_rows=len(legacy_rows),
            migrated_tasks=migrated_tasks, skipped_tasks=skipped_tasks,
            migrated_runs=migrated_runs, skipped_runs=skipped_runs,
        )

    def _init_fts(self, conn: sqlite3.Connection) -> None:
        """Fase 3: FTS5 full-text index over tasks_v2 + the full legacy prompt.

        Column set (chosen after inspecting real rows): `title`, `summary`,
        `tags`, `task_type` — the always-available lightweight tasks_v2 fields —
        PLUS the full original `prompt`. `tasks_v2.title` is only the first ~80
        chars of the prompt; the complete text lives solely in the legacy
        `tasks.prompt` column, reachable via `tasks_v2.legacy_task_id =
        tasks.task_id`. Real prompts run to ~158 chars, so indexing the full
        prompt is what makes searching for words past char 80 actually work.
        `summary`/`tags` are empty today but will populate in later phases; they
        cost nothing to index now and avoid a schema change later.

        Implementation: a normal (non-external-content) FTS5 table keyed to
        `tasks_v2.rowid`, kept in sync by AFTER INSERT/UPDATE/DELETE triggers
        (the prompt is pulled from `tasks` inside the trigger body), and
        backfilled once from existing rows — same one-shot idempotent style as
        `_backfill_v2`.

        Defensive: if FTS5 is not compiled into this machine's sqlite3, the
        CREATE VIRTUAL TABLE raises `OperationalError`; we flag it unavailable,
        skip the triggers/backfill, and `search_tasks` degrades to a LIKE scan.
        FTS5 IS present on the dev machine — this guard is purely for portability.
        """
        try:
            conn.execute(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
                    title, summary, tags, task_type, prompt
                )
                """
            )
        except sqlite3.OperationalError as exc:
            self._fts_available = False
            log_event(
                logger, logging.WARNING, "fts5_unavailable",
                error=f"{type(exc).__name__}: {exc}",
            )
            return
        self._fts_available = True
        conn.execute(
            """
            CREATE TRIGGER IF NOT EXISTS tasks_v2_fts_ai AFTER INSERT ON tasks_v2 BEGIN
                INSERT INTO tasks_fts (rowid, title, summary, tags, task_type, prompt)
                VALUES (
                    new.rowid, new.title, new.summary, new.tags_json, new.task_type,
                    (SELECT prompt FROM tasks WHERE task_id = new.legacy_task_id)
                );
            END
            """
        )
        conn.execute(
            """
            CREATE TRIGGER IF NOT EXISTS tasks_v2_fts_ad AFTER DELETE ON tasks_v2 BEGIN
                DELETE FROM tasks_fts WHERE rowid = old.rowid;
            END
            """
        )
        conn.execute(
            """
            CREATE TRIGGER IF NOT EXISTS tasks_v2_fts_au AFTER UPDATE ON tasks_v2 BEGIN
                DELETE FROM tasks_fts WHERE rowid = old.rowid;
                INSERT INTO tasks_fts (rowid, title, summary, tags, task_type, prompt)
                VALUES (
                    new.rowid, new.title, new.summary, new.tags_json, new.task_type,
                    (SELECT prompt FROM tasks WHERE task_id = new.legacy_task_id)
                );
            END
            """
        )
        empty = conn.execute("SELECT COUNT(*) AS c FROM tasks_fts").fetchone()["c"] == 0
        if empty:
            conn.execute(
                """
                INSERT INTO tasks_fts (rowid, title, summary, tags, task_type, prompt)
                SELECT
                    tv2.rowid, tv2.title, tv2.summary, tv2.tags_json, tv2.task_type,
                    (SELECT prompt FROM tasks WHERE task_id = tv2.legacy_task_id)
                FROM tasks_v2 tv2
                """
            )
