"""`ResourceRepository` sobre Postgres — el CRUD principal de la biblioteca.

Alcance deliberado de esta primera pasada (nota "Plan de mejora", §15): los
métodos que de verdad hacen falta para listar/crear/editar/buscar recursos
funcionan completos y están verificados contra Postgres real. Los grupos
jerárquicos, las fuentes de descubrimiento y el historial de operaciones
—superficie bastante más grande de `ResourceStore`, con lógica de fusión de
metadatos y taxonomía propia— quedan explícitamente sin implementar
(`NotImplementedError` con explicación, nunca una respuesta vacía silenciosa)
en vez de fingir un puerto completo que nadie ha verificado.

`upsert()` tampoco replica la heurística de preservación de metadatos de
`ResourceStore.upsert` (SQLite) — reseeding con analyzed_at más nuevo gana
siempre aquí, sin fusión selectiva. Documentado, no descuidado: portar esa
heurística es trabajo aparte una vez haya un flujo de reseeding SaaS real que
la ejercite.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from psycopg.types.json import Json
from psycopg_pool import ConnectionPool

from app.models import ResourceCreateRequest, ResourceItem, ResourceUpdateRequest
from app.platform.multitenancy import WorkspaceContext

_WORD_RE = re.compile(r"[a-zA-Z0-9_]+")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _canonical_repo_url(url: str | None) -> str | None:
    if not url:
        return None
    cleaned = str(url).strip().rstrip("/").casefold()
    return cleaned or None


class PostgresResourceRepository:
    def __init__(self, pool: ConnectionPool, workspace: WorkspaceContext) -> None:
        self._pool = pool
        self._workspace = workspace

    def _scope(self) -> tuple[str, str]:
        return self._workspace.tenant_id, self._workspace.workspace_id

    def _row_to_item(self, row) -> ResourceItem:
        return ResourceItem.model_validate(row[0])

    # --- recursos --------------------------------------------------------------

    def upsert(self, item: ResourceItem) -> ResourceItem:
        tenant_id, workspace_id = self._scope()
        payload = item.model_copy(update={"updated_at": _now()}).model_dump(mode="json")
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO resources (tenant_id, workspace_id, id, item_json, slug, kind, repo_url, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, now())
                ON CONFLICT (tenant_id, workspace_id, id) DO UPDATE SET
                    item_json = EXCLUDED.item_json, slug = EXCLUDED.slug, kind = EXCLUDED.kind,
                    repo_url = EXCLUDED.repo_url, updated_at = now()
                """,
                (tenant_id, workspace_id, item.id, Json(payload), item.slug, item.kind.value, _canonical_repo_url(item.repo_url)),
            )
            conn.commit()
        return item

    def create(self, request: ResourceCreateRequest) -> ResourceItem:
        tenant_id, workspace_id = self._scope()
        with self._pool.connection() as conn:
            existing = conn.execute(
                "SELECT 1 FROM resources WHERE tenant_id = %s AND workspace_id = %s AND kind = %s AND slug = %s",
                (tenant_id, workspace_id, request.kind.value, request.slug),
            ).fetchone()
        if existing:
            raise ValueError(f"Resource already exists: {request.kind.value}/{request.slug}")
        return self.upsert(ResourceItem(**request.model_dump()))

    def get(self, resource_id: str) -> ResourceItem:
        tenant_id, workspace_id = self._scope()
        with self._pool.connection() as conn:
            row = conn.execute(
                "SELECT item_json FROM resources WHERE tenant_id = %s AND workspace_id = %s AND id = %s",
                (tenant_id, workspace_id, resource_id),
            ).fetchone()
        if row is None:
            raise KeyError(resource_id)
        return self._row_to_item(row)

    def find_by_repo_url(self, repo_url: str) -> ResourceItem | None:
        canonical = _canonical_repo_url(repo_url)
        if not canonical:
            return None
        tenant_id, workspace_id = self._scope()
        with self._pool.connection() as conn:
            row = conn.execute(
                "SELECT item_json FROM resources WHERE tenant_id = %s AND workspace_id = %s AND repo_url = %s "
                "ORDER BY length(item_json ->> 'summary') DESC NULLS LAST LIMIT 1",
                (tenant_id, workspace_id, canonical),
            ).fetchone()
        return self._row_to_item(row) if row else None

    def update_resource(self, resource_id: str, request: ResourceUpdateRequest) -> ResourceItem:
        item = self.get(resource_id)
        changes = request.model_dump(exclude_unset=True)
        if "summary" in changes:
            changes["summary"] = " ".join(str(changes["summary"] or "").split()).strip()
            changes["metadata"] = {**item.metadata, "summary_edited": True}
        return self.upsert(item.model_copy(update=changes))

    def list_resources(
        self, *, kind=None, source: str | None = None, limit: int = 100, offset: int = 0, include_inactive: bool = False,
    ) -> list[ResourceItem]:
        tenant_id, workspace_id = self._scope()
        clauses = ["tenant_id = %s", "workspace_id = %s"]
        params: list = [tenant_id, workspace_id]
        if not include_inactive:
            clauses.append("item_json ->> 'index_status' != 'inactive'")
        if kind is not None:
            clauses.append("kind = %s")
            params.append(kind.value if hasattr(kind, "value") else kind)
        if source:
            clauses.append("item_json ->> 'source' = %s")
            params.append(source)
        params += [max(1, min(limit, 500)), max(0, offset)]
        with self._pool.connection() as conn:
            rows = conn.execute(
                f"SELECT item_json FROM resources WHERE {' AND '.join(clauses)} "
                "ORDER BY item_json ->> 'name', id LIMIT %s OFFSET %s",
                params,
            ).fetchall()
        return [self._row_to_item(row) for row in rows]

    def list_all_resources(self, *, kind=None, source: str | None = None, include_inactive: bool = False) -> list[ResourceItem]:
        items: list[ResourceItem] = []
        offset = 0
        while True:
            page = self.list_resources(kind=kind, source=source, limit=500, offset=offset, include_inactive=include_inactive)
            items.extend(page)
            if len(page) < 500:
                return items
            offset += len(page)

    def search(self, query: str, *, limit: int = 50) -> list[ResourceItem]:
        terms = _WORD_RE.findall(query)[:12]
        if not terms:
            return []
        tenant_id, workspace_id = self._scope()
        tsquery = " & ".join(f"{term}:*" for term in terms)
        with self._pool.connection() as conn:
            rows = conn.execute(
                """
                SELECT item_json FROM resources
                WHERE tenant_id = %s AND workspace_id = %s
                  AND to_tsvector('simple', (item_json ->> 'name') || ' ' || COALESCE(item_json ->> 'summary', ''))
                      @@ to_tsquery('simple', %s)
                ORDER BY item_json ->> 'name'
                LIMIT %s
                """,
                (tenant_id, workspace_id, tsquery, max(1, min(limit, 200))),
            ).fetchall()
        return [self._row_to_item(row) for row in rows]

    def recommendation_candidates(self, query: str, *, limit: int = 100) -> list[ResourceItem]:
        return self.search(query, limit=limit)

    def list_children(self, parent_resource_id: str, *, include_inactive: bool = False) -> list[ResourceItem]:
        tenant_id, workspace_id = self._scope()
        clauses = ["tenant_id = %s", "workspace_id = %s", "item_json ->> 'parent_resource_id' = %s"]
        params: list = [tenant_id, workspace_id, parent_resource_id]
        if not include_inactive:
            clauses.append("item_json ->> 'index_status' != 'inactive'")
        with self._pool.connection() as conn:
            rows = conn.execute(
                f"SELECT item_json FROM resources WHERE {' AND '.join(clauses)} ORDER BY item_json ->> 'name'",
                params,
            ).fetchall()
        return [self._row_to_item(row) for row in rows]

    def set_visibility(self, resource_id: str, agent_ids: list[str]) -> ResourceItem:
        item = self.get(resource_id)
        cleaned = sorted({v.strip() for v in agent_ids if v and v.strip()}, key=str.casefold)
        return self.upsert(item.model_copy(update={"visible_agent_ids": cleaned}))

    # --- preferencias ------------------------------------------------------------

    def get_preference(self, key: str, default: object = None) -> object:
        tenant_id, workspace_id = self._scope()
        with self._pool.connection() as conn:
            row = conn.execute(
                "SELECT value_json FROM resource_preferences WHERE tenant_id = %s AND workspace_id = %s AND preference_key = %s",
                (tenant_id, workspace_id, key),
            ).fetchone()
        return row[0] if row is not None else default

    def set_preference(self, key: str, value: object) -> object:
        tenant_id, workspace_id = self._scope()
        with self._pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO resource_preferences (tenant_id, workspace_id, preference_key, value_json, updated_at)
                VALUES (%s, %s, %s, %s, now())
                ON CONFLICT (tenant_id, workspace_id, preference_key)
                DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = now()
                """,
                (tenant_id, workspace_id, key, Json(value)),
            )
            conn.commit()
        return value

    # --- superficie deliberadamente no portada en esta pasada ---------------------

    def _not_ported(self, name: str):
        raise NotImplementedError(
            f"PostgresResourceRepository.{name}: grupos/fuentes de descubrimiento/"
            "operaciones no están portados todavía — ver el docstring del módulo."
        )

    def ensure_default_groups(self, *a, **kw):
        self._not_ported("ensure_default_groups")

    def list_groups(self, *a, **kw):
        self._not_ported("list_groups")

    def create_group(self, *a, **kw):
        self._not_ported("create_group")

    def update_group(self, *a, **kw):
        self._not_ported("update_group")

    def delete_group(self, *a, **kw):
        self._not_ported("delete_group")

    def assign_groups(self, *a, **kw):
        self._not_ported("assign_groups")

    def upsert_discovery_source(self, *a, **kw):
        self._not_ported("upsert_discovery_source")

    def list_discovery_sources(self, *a, **kw):
        self._not_ported("list_discovery_sources")

    def migrate_radar_profiles(self, *a, **kw):
        self._not_ported("migrate_radar_profiles")

    def record_operation(self, *a, **kw):
        self._not_ported("record_operation")

    def list_operations(self, *a, **kw):
        self._not_ported("list_operations")
