"""`RoutingRepository` sobre Postgres: el layout de enrutado de un workspace."""

from __future__ import annotations

from psycopg.types.json import Json
from psycopg_pool import ConnectionPool

from app.models import RoutingLayout
from app.platform.multitenancy import WorkspaceContext


class PostgresRoutingRepository:
    def __init__(self, pool: ConnectionPool, workspace: WorkspaceContext) -> None:
        self._pool = pool
        self._workspace = workspace

    def load(self) -> RoutingLayout:
        with self._pool.connection() as conn:
            row = conn.execute(
                "SELECT layout_json FROM routing_layout WHERE tenant_id = %s AND workspace_id = %s AND project_id = %s",
                (self._workspace.tenant_id, self._workspace.workspace_id, self._workspace.project_id),
            ).fetchone()
        if row is None:
            return RoutingLayout()  # workspace nuevo: layout vacío, igual que RoutingLayoutStore sin fichero
        return RoutingLayout.model_validate(row[0])

    def save(self, layout: RoutingLayout) -> RoutingLayout:
        payload = layout.model_dump(mode="json")
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO routing_layout (tenant_id, workspace_id, project_id, layout_json, updated_at)
                VALUES (%s, %s, %s, %s, now())
                ON CONFLICT (tenant_id, workspace_id, project_id)
                DO UPDATE SET layout_json = EXCLUDED.layout_json, updated_at = now()
                """,
                (self._workspace.tenant_id, self._workspace.workspace_id, self._workspace.project_id, Json(payload)),
            )
            conn.commit()
        return layout
