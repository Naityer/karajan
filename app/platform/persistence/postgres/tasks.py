"""`TaskRepository` sobre Postgres, con aislamiento por workspace.

Espejo funcional de `TaskStore` (`app/database.py`, SQLite) tras el mismo
puerto (`app/core/contracts/repositories.py::TaskRepository`) — mismos
métodos, mismas formas de retorno (`TaskRecord`, `Metrics`, ...), para que
`app/modules/*/api.py` no note la diferencia.

Dos simplificaciones deliberadas frente a SQLite, ninguna visible desde el
Protocol:

- No hay split `tasks`/`tasks_v2`/`task_history` — esa separación es historia
  de migración de SQLite (`_migrate`, `_backfill_v2`), no comportamiento que
  el Protocol exponga. Una sola tabla `tasks` con `classification_json`/
  `delegation_json` (JSONB) + columnas desnormalizadas para `metrics()` basta.
- `search_tasks` usa `to_tsvector('simple', prompt)` (índice GIN, ya en
  `schema.sql`) en vez del håbrido FTS5+`tasks_v2.title/summary` de SQLite —
  Postgres tiene su propio full-text search nativo, no hace falta reproducir
  una tabla que solo existía para alimentar FTS5.

`record_run`/`open_run`/`close_run`/`record_run_event`/`record_artifact` NO
están en el `TaskRepository` Protocol (que solo describe lo que
`app/modules/*/api.py` consume) pero SÍ los llaman directamente
`app/delegation.py`, `app/agent_tools/trace.py` y `app/handoff/store.py` sobre
el store concreto — se implementan aquí con la misma firma que `TaskStore`
para que el runtime SaaS funcione con esos módulos sin cambiarlos. Ensanchar
el Protocol para reflejar esto es trabajo pendiente, no un descuido de esta
clase.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import uuid4

from psycopg.types.json import Json
from psycopg_pool import ConnectionPool

from app.models import (
    ClassificationResult,
    DecisionLogEntry,
    DelegationResult,
    Metrics,
    MetricsHistory,
    MetricsHistoryPoint,
    TaskRecord,
    TaskStatus,
)
from app.platform.multitenancy import WorkspaceContext


def _now() -> datetime:
    return datetime.now(timezone.utc)


class PostgresTaskRepository:
    def __init__(self, pool: ConnectionPool, workspace: WorkspaceContext) -> None:
        self._pool = pool
        self._workspace = workspace

    def _scope(self) -> tuple[str, str]:
        return self._workspace.tenant_id, self._workspace.workspace_id

    # --- ciclo de vida de la tarea ------------------------------------------

    def save_classification(
        self,
        classification: ClassificationResult,
        decision: DecisionLogEntry | None = None,
    ) -> TaskRecord:
        tenant_id, workspace_id = self._scope()
        now = _now()
        payload = classification.model_dump(mode="json")
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO tasks (
                    tenant_id, workspace_id, project_id, task_id, prompt, status,
                    classification_json, delegation_json, created_at, updated_at,
                    level, model, score, requires_review, subtask_count, est_cost
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, NULL, %s, %s, %s, %s, %s, %s, %s, 0)
                """,
                (
                    tenant_id, workspace_id, self._workspace.project_id,
                    classification.task_id, classification.original_prompt, TaskStatus.CLASSIFIED.value,
                    Json(payload), classification.created_at, now,
                    classification.complexity_level.value, classification.recommended_model.value,
                    classification.complexity_score, classification.requires_human_review,
                    len(classification.subtasks),
                ),
            )
            if decision is not None:
                self._insert_decisions(conn, [decision])
            conn.commit()
        return self.get_task(classification.task_id)

    def mark_status(self, task_id: str, status: TaskStatus) -> TaskRecord:
        tenant_id, workspace_id = self._scope()
        with self._pool.connection() as conn:
            cursor = conn.execute(
                "UPDATE tasks SET status = %s, updated_at = %s "
                "WHERE tenant_id = %s AND workspace_id = %s AND task_id = %s",
                (status.value, _now(), tenant_id, workspace_id, task_id),
            )
            if cursor.rowcount == 0:
                raise KeyError(task_id)
            conn.commit()
        return self.get_task(task_id)

    def save_delegation(
        self,
        delegation: DelegationResult,
        decisions: list[DecisionLogEntry] | None = None,
    ) -> TaskRecord:
        tenant_id, workspace_id = self._scope()
        with self._pool.connection() as conn:
            cursor = conn.execute(
                """
                UPDATE tasks
                SET status = %s, delegation_json = %s, updated_at = %s, est_cost = %s
                WHERE tenant_id = %s AND workspace_id = %s AND task_id = %s
                """,
                (
                    delegation.status.value, Json(delegation.model_dump(mode="json")), _now(),
                    round(delegation.total_estimated_cost_usd, 5),
                    tenant_id, workspace_id, delegation.task_id,
                ),
            )
            if cursor.rowcount == 0:
                raise KeyError(delegation.task_id)
            if decisions:
                self._insert_decisions(conn, decisions)
            conn.commit()
        return self.get_task(delegation.task_id)

    def get_task(self, task_id: str) -> TaskRecord:
        tenant_id, workspace_id = self._scope()
        with self._pool.connection() as conn:
            cursor = conn.execute(
                "SELECT * FROM tasks WHERE tenant_id = %s AND workspace_id = %s AND task_id = %s",
                (tenant_id, workspace_id, task_id),
            )
            row = cursor.fetchone()
            if row is None:
                raise KeyError(task_id)
            return self._row_to_record(cursor, row)

    def list_tasks(self, limit: int | None = None, offset: int = 0) -> list[TaskRecord]:
        tenant_id, workspace_id = self._scope()
        query = (
            "SELECT * FROM tasks WHERE tenant_id = %s AND workspace_id = %s ORDER BY created_at DESC"
        )
        params: list = [tenant_id, workspace_id]
        if limit is not None:
            query += " LIMIT %s OFFSET %s"
            params += [limit, offset]
        with self._pool.connection() as conn:
            cursor = conn.execute(query, params)
            rows = cursor.fetchall()
            return [self._row_to_record(cursor, row) for row in rows]

    def count_tasks(self) -> int:
        tenant_id, workspace_id = self._scope()
        with self._pool.connection() as conn:
            row = conn.execute(
                "SELECT COUNT(*) FROM tasks WHERE tenant_id = %s AND workspace_id = %s",
                (tenant_id, workspace_id),
            ).fetchone()
        return row[0]

    def _row_to_record(self, cursor, row) -> TaskRecord:
        columns = [d.name for d in cursor.description]
        data = dict(zip(columns, row))
        return TaskRecord(
            task_id=data["task_id"],
            prompt=data["prompt"],
            status=data["status"],
            classification=data["classification_json"],
            delegation=data["delegation_json"],
            created_at=data["created_at"],
            updated_at=data["updated_at"],
        )

    # --- trazas --------------------------------------------------------------

    def _insert_decisions(self, conn, decisions: list[DecisionLogEntry]) -> None:
        tenant_id, workspace_id = self._scope()
        for entry in decisions:
            conn.execute(
                """
                INSERT INTO decisions (tenant_id, workspace_id, id, task_id, phase, decision, score, backend, reason, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (tenant_id, workspace_id, id) DO UPDATE SET
                    phase = EXCLUDED.phase, decision = EXCLUDED.decision, score = EXCLUDED.score,
                    backend = EXCLUDED.backend, reason = EXCLUDED.reason
                """,
                (
                    tenant_id, workspace_id, entry.id, entry.task_id, entry.phase, entry.decision,
                    entry.score, entry.backend.value if entry.backend else None, entry.reason, entry.created_at,
                ),
            )

    def add_decisions(self, decisions: list[DecisionLogEntry]) -> None:
        if not decisions:
            return
        with self._pool.connection() as conn:
            self._insert_decisions(conn, decisions)
            conn.commit()

    def list_decisions(self, task_id: str | None = None) -> list[DecisionLogEntry]:
        tenant_id, workspace_id = self._scope()
        query = "SELECT id, task_id, phase, decision, score, backend, reason, created_at FROM decisions WHERE tenant_id = %s AND workspace_id = %s"
        params: list = [tenant_id, workspace_id]
        if task_id is not None:
            query += " AND task_id = %s"
            params.append(task_id)
        query += " ORDER BY created_at"
        with self._pool.connection() as conn:
            rows = conn.execute(query, params).fetchall()
        return [
            DecisionLogEntry(
                id=r[0], task_id=r[1], phase=r[2], decision=r[3], score=r[4],
                backend=r[5], reason=r[6] or "", created_at=r[7],
            )
            for r in rows
        ]

    def record_run(
        self, task_id, provider_name, routing_entity_id, routing_entity_name_snapshot,
        model_id, backend, status, started_at, completed_at, latency_ms,
        input_tokens, output_tokens, estimated_cost_usd, error,
    ) -> str:
        tenant_id, workspace_id = self._scope()
        run_id = f"run_{uuid4().hex[:16]}"
        with self._pool.connection() as conn:
            row = conn.execute(
                "SELECT COALESCE(MAX(run_index), -1) + 1 FROM runs WHERE tenant_id = %s AND workspace_id = %s AND task_id = %s",
                (tenant_id, workspace_id, task_id),
            ).fetchone()
            conn.execute(
                """
                INSERT INTO runs (
                    tenant_id, workspace_id, id, task_id, run_index, provider_name, routing_entity_id,
                    routing_entity_name_snapshot, model_id, backend, status, started_at, completed_at,
                    latency_ms, input_tokens, output_tokens, estimated_cost_usd, error
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    tenant_id, workspace_id, run_id, task_id, row[0], provider_name, routing_entity_id,
                    routing_entity_name_snapshot, model_id, backend, status, started_at, completed_at,
                    latency_ms, input_tokens, output_tokens, estimated_cost_usd, error,
                ),
            )
            conn.commit()
        return run_id

    def open_run(self, task_id, provider_name, routing_entity_id, routing_entity_name_snapshot, model_id, backend) -> str:
        tenant_id, workspace_id = self._scope()
        run_id = f"run_{uuid4().hex[:16]}"
        with self._pool.connection() as conn:
            row = conn.execute(
                "SELECT COALESCE(MAX(run_index), -1) + 1 FROM runs WHERE tenant_id = %s AND workspace_id = %s AND task_id = %s",
                (tenant_id, workspace_id, task_id),
            ).fetchone()
            conn.execute(
                """
                INSERT INTO runs (
                    tenant_id, workspace_id, id, task_id, run_index, provider_name, routing_entity_id,
                    routing_entity_name_snapshot, model_id, backend, status, started_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'running', %s)
                """,
                (
                    tenant_id, workspace_id, run_id, task_id, row[0], provider_name, routing_entity_id,
                    routing_entity_name_snapshot, model_id, backend, _now(),
                ),
            )
            conn.commit()
        return run_id

    def close_run(self, run_id, status, latency_ms=None, input_tokens=None, output_tokens=None, estimated_cost_usd=None, error=None) -> None:
        tenant_id, workspace_id = self._scope()
        with self._pool.connection() as conn:
            conn.execute(
                """
                UPDATE runs SET status = %s, completed_at = %s, latency_ms = %s, input_tokens = %s,
                    output_tokens = %s, estimated_cost_usd = %s, error = %s
                WHERE tenant_id = %s AND workspace_id = %s AND id = %s
                """,
                (status, _now(), latency_ms, input_tokens, output_tokens, estimated_cost_usd, error, tenant_id, workspace_id, run_id),
            )
            conn.commit()

    def list_runs(self, task_id: str) -> list[dict]:
        tenant_id, workspace_id = self._scope()
        with self._pool.connection() as conn:
            cursor = conn.execute(
                "SELECT * FROM runs WHERE tenant_id = %s AND workspace_id = %s AND task_id = %s ORDER BY run_index",
                (tenant_id, workspace_id, task_id),
            )
            columns = [d.name for d in cursor.description]
            return [dict(zip(columns, row)) for row in cursor.fetchall()]

    def record_run_event(self, run_id: str, event_type: str, payload: dict | None = None) -> str:
        tenant_id, workspace_id = self._scope()
        event_id = f"rev_{uuid4().hex[:16]}"
        try:
            json.dumps(payload) if payload is not None else None
            safe_payload = payload
        except (TypeError, ValueError):
            safe_payload = {"unserializable": repr(payload)[:500]}
        with self._pool.connection() as conn:
            conn.execute(
                "INSERT INTO run_events (tenant_id, workspace_id, id, run_id, event_type, ts, payload_json) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (tenant_id, workspace_id, event_id, run_id, event_type, _now(), Json(safe_payload) if safe_payload is not None else None),
            )
            conn.commit()
        return event_id

    def list_run_events(self, run_id: str, limit: int = 500, offset: int = 0) -> list[dict]:
        tenant_id, workspace_id = self._scope()
        with self._pool.connection() as conn:
            cursor = conn.execute(
                "SELECT id, run_id, event_type, ts, payload_json FROM run_events "
                "WHERE tenant_id = %s AND workspace_id = %s AND run_id = %s ORDER BY ts LIMIT %s OFFSET %s",
                (tenant_id, workspace_id, run_id, limit, offset),
            )
            columns = [d.name for d in cursor.description]
            events = []
            for row in cursor.fetchall():
                entry = dict(zip(columns, row))
                entry["payload"] = entry.pop("payload_json", None)
                events.append(entry)
            return events

    def record_artifact(self, task_id, run_id, kind, file_path, size_bytes=None, content_hash=None) -> str:
        tenant_id, workspace_id = self._scope()
        artifact_id = f"art_{uuid4().hex[:16]}"
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO artifacts (tenant_id, workspace_id, id, task_id, run_id, kind, file_path, size_bytes, content_hash, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (tenant_id, workspace_id, artifact_id, task_id, run_id, kind, file_path, size_bytes, content_hash, _now()),
            )
            conn.commit()
        return artifact_id

    def list_artifacts(self, task_id: str) -> list[dict]:
        tenant_id, workspace_id = self._scope()
        with self._pool.connection() as conn:
            cursor = conn.execute(
                "SELECT * FROM artifacts WHERE tenant_id = %s AND workspace_id = %s AND task_id = %s ORDER BY created_at",
                (tenant_id, workspace_id, task_id),
            )
            columns = [d.name for d in cursor.description]
            return [dict(zip(columns, row)) for row in cursor.fetchall()]

    # --- analítica -------------------------------------------------------------

    def metrics(self) -> Metrics:
        tenant_id, workspace_id = self._scope()
        with self._pool.connection() as conn:
            agg = conn.execute(
                """
                SELECT
                    COUNT(*),
                    COALESCE(SUM(subtask_count), 0),
                    COALESCE(SUM(CASE WHEN requires_review THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(est_cost), 0.0),
                    COALESCE(AVG(score), 0.0),
                    COALESCE(SUM(CASE WHEN delegation_json IS NOT NULL THEN 1 ELSE 0 END), 0)
                FROM tasks WHERE tenant_id = %s AND workspace_id = %s
                """,
                (tenant_id, workspace_id),
            ).fetchone()

            def group(column: str) -> dict[str, int]:
                rows = conn.execute(
                    f"SELECT {column}, COUNT(*) FROM tasks WHERE tenant_id = %s AND workspace_id = %s "
                    f"AND {column} IS NOT NULL GROUP BY {column}",
                    (tenant_id, workspace_id),
                ).fetchall()
                return {r[0]: r[1] for r in rows}

            by_level = group("level")
            by_model = group("model")
            by_status = group("status")

            by_skill: dict[str, int] = {}
            by_backend: dict[str, int] = {}
            for classification, delegation in conn.execute(
                "SELECT classification_json, delegation_json FROM tasks WHERE tenant_id = %s AND workspace_id = %s",
                (tenant_id, workspace_id),
            ).fetchall():
                for skill in classification.get("recommended_skills", []):
                    by_skill[skill] = by_skill.get(skill, 0) + 1
                for subtask in classification.get("subtasks", []):
                    skill = subtask.get("recommended_skill")
                    if skill:
                        by_skill[skill] = by_skill.get(skill, 0) + 1
                if delegation:
                    for execution in delegation.get("executions", []):
                        backend = execution["backend"]
                        by_backend[backend] = by_backend.get(backend, 0) + 1

        total = agg[0]
        return Metrics(
            total_tasks=total, by_level=by_level, by_model=by_model, by_backend=by_backend,
            by_status=by_status, by_skill=by_skill, total_subtasks=agg[1], delegated_tasks=agg[5],
            human_review_required=agg[2], total_estimated_cost_usd=round(agg[3], 5),
            average_complexity_score=round(agg[4], 2) if total else 0.0,
        )

    def metrics_history(self, limit: int = 200) -> MetricsHistory:
        tenant_id, workspace_id = self._scope()
        with self._pool.connection() as conn:
            rows = conn.execute(
                'SELECT "timestamp", total_tasks, total_estimated_cost_usd, total_tokens, avg_latency_ms '
                "FROM metrics_history WHERE tenant_id = %s AND workspace_id = %s ORDER BY \"timestamp\" DESC LIMIT %s",
                (tenant_id, workspace_id, limit),
            ).fetchall()
        points = [
            MetricsHistoryPoint(timestamp=r[0], total_tasks=r[1], total_estimated_cost_usd=r[2], total_tokens=r[3], avg_latency_ms=r[4])
            for r in rows
        ]
        points.reverse()
        return MetricsHistory(points=points)

    def agent_performance(self) -> list[dict]:
        tenant_id, workspace_id = self._scope()
        with self._pool.connection() as conn:
            rows = conn.execute(
                """
                SELECT provider_name, COUNT(*), SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),
                    AVG(latency_ms), SUM(estimated_cost_usd), SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0))
                FROM runs WHERE tenant_id = %s AND workspace_id = %s AND provider_name IS NOT NULL
                GROUP BY provider_name
                """,
                (tenant_id, workspace_id),
            ).fetchall()
        return [
            {
                "provider_name": r[0], "task_count": r[1], "error_count": r[2] or 0,
                "avg_latency_ms": r[3], "total_cost": round(r[4] or 0.0, 5), "total_tokens": r[5] or 0,
            }
            for r in rows
        ]

    def search_tasks(self, query: str, limit: int = 20) -> list[dict]:
        query = (query or "").strip()
        if not query:
            return []
        tenant_id, workspace_id = self._scope()
        with self._pool.connection() as conn:
            cursor = conn.execute(
                """
                SELECT task_id, prompt, status, created_at,
                       ts_rank(to_tsvector('simple', prompt), plainto_tsquery('simple', %s)) AS rank
                FROM tasks
                WHERE tenant_id = %s AND workspace_id = %s
                  AND to_tsvector('simple', prompt) @@ plainto_tsquery('simple', %s)
                ORDER BY rank DESC
                LIMIT %s
                """,
                (query, tenant_id, workspace_id, query, limit),
            )
            columns = [d.name for d in cursor.description]
            return [dict(zip(columns, row)) for row in cursor.fetchall()]
