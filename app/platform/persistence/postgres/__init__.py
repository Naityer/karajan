"""Persistencia Postgres: la que usa el modo SaaS (nota "Plan de mejora", §15).

Un `ConnectionPool` por proceso (`connection.py`), repositorios construidos
por-workspace (cada uno cierra sobre un `WorkspaceContext` — no hay caché
compartida entre inquilinos). Implementan los mismos puertos que
`app/platform/persistence/sqlite/`: `app/modules/*/api.py` no distingue cuál
tiene detrás.
"""

from app.platform.persistence.postgres.config import PostgresConfigRepository
from app.platform.persistence.postgres.connection import DATABASE_URL_ENV_VAR, ensure_schema, get_pool, reset_pool
from app.platform.persistence.postgres.resources import PostgresResourceRepository
from app.platform.persistence.postgres.routing import PostgresRoutingRepository
from app.platform.persistence.postgres.tasks import PostgresTaskRepository

__all__ = [
    "DATABASE_URL_ENV_VAR",
    "ensure_schema",
    "get_pool",
    "reset_pool",
    "PostgresConfigRepository",
    "PostgresResourceRepository",
    "PostgresRoutingRepository",
    "PostgresTaskRepository",
]
