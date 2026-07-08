from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from app.logging_config import get_logger, log_event
from app.models import (
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
        # Flipped to False by `_init_fts` if this machine's sqlite3 lacks FTS5;
        # `search_tasks` reads it to decide FTS-MATCH vs. LIKE-scan fallback.
        self._fts_available = True
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
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_v2_legacy ON tasks_v2(legacy_task_id)")
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
        # bug: `provider_name` is a stable catalog constant (see app/catalog.py),
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
        # Schema-only groundwork for later phases (no tool-call/RAG tracing,
        # evaluator, or artifact-writing feature exists yet) — created now so the
        # migration/dashboard schema is stable, deliberately left unpopulated.
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
                    # Legacy fallback: pre-Fase-1 rows never persisted a real
                    # `provider_name` (the bug this phase fixes) — `model_used` is
                    # the best-effort approximation, ONLY for this one-off backfill
                    # of historical data. Every run recorded after Fase-1 ships
                    # carries the real `resolution.provider_name` from delegation.py.
                    legacy_provider = execution.get("model_used")
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
                            legacy_provider,
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

    def mark_status(self, task_id: str, status: TaskStatus) -> TaskRecord:
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
        return self.get_task(task_id)

    def save_delegation(
        self,
        delegation: DelegationResult,
        decisions: list[DecisionLogEntry] | None = None,
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
