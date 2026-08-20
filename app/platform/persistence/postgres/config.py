"""`ConfigRepository` sobre Postgres: la configuración activa de un workspace.

Un `UPSERT` (`INSERT ... ON CONFLICT`) sobre la clave (tenant, workspace,
project) — mismo comportamiento que `SqliteConfigRepository`
(`app/platform/persistence/sqlite/__init__.py`) pero sin caché en memoria: en
SaaS, otra réplica del proceso puede haber escrito la config, así que leer
siempre pega a la base en vez de servir un valor potencialmente obsoleto.
"""

from __future__ import annotations

from psycopg.types.json import Json
from psycopg_pool import ConnectionPool

from app import config as config_module
from app.models import KarajanConfig
from app.platform.multitenancy import WorkspaceContext


class PostgresConfigRepository:
    def __init__(self, pool: ConnectionPool, workspace: WorkspaceContext) -> None:
        self._pool = pool
        self._workspace = workspace

    def load(self) -> KarajanConfig:
        with self._pool.connection() as conn:
            row = conn.execute(
                "SELECT config_json FROM active_config WHERE tenant_id = %s AND workspace_id = %s AND project_id = %s",
                (self._workspace.tenant_id, self._workspace.workspace_id, self._workspace.project_id),
            ).fetchone()
        if row is None:
            return config_module.load_config()  # defaults, igual que SQLite sin override guardado
        return KarajanConfig.model_validate(row[0])

    def save(self, config: KarajanConfig) -> KarajanConfig:
        payload = config.model_dump(mode="json")
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO active_config (tenant_id, workspace_id, project_id, config_json, updated_at)
                VALUES (%s, %s, %s, %s, now())
                ON CONFLICT (tenant_id, workspace_id, project_id)
                DO UPDATE SET config_json = EXCLUDED.config_json, updated_at = now()
                """,
                (self._workspace.tenant_id, self._workspace.workspace_id, self._workspace.project_id, Json(payload)),
            )
            conn.commit()
        return config
