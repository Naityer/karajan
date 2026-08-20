"""Pool de conexiones Postgres, compartido por todos los repositorios SaaS.

Un solo pool por proceso (no uno por workspace): el aislamiento entre
inquilinos lo dan las columnas `tenant_id`/`workspace_id` de cada tabla y el
`WHERE` de cada consulta (ver `app/platform/multitenancy.py`), no conexiones
separadas — así es como Postgres soporta multi-tenant a escala sin abrir un
pool por cliente.
"""

from __future__ import annotations

import os
from pathlib import Path

from psycopg_pool import ConnectionPool

DATABASE_URL_ENV_VAR = "KARAJAN_SAAS_DATABASE_URL"
SCHEMA_PATH = Path(__file__).parent / "schema.sql"

_pool: ConnectionPool | None = None


def _resolve_dsn(dsn: str | None) -> str:
    resolved = dsn or os.environ.get(DATABASE_URL_ENV_VAR)
    if not resolved:
        raise RuntimeError(f"falta la cadena de conexión Postgres ({DATABASE_URL_ENV_VAR})")
    return resolved


def get_pool(dsn: str | None = None) -> ConnectionPool:
    """El pool del proceso, creado perezosamente la primera vez que hace falta."""
    global _pool
    if _pool is None:
        _pool = ConnectionPool(_resolve_dsn(dsn), min_size=1, max_size=10, open=True)
    return _pool


def reset_pool() -> None:
    """Cierra y olvida el pool — usado por los tests para aislar bases distintas."""
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


def ensure_schema(pool: ConnectionPool | None = None) -> None:
    """Aplica `schema.sql` (todo `CREATE TABLE IF NOT EXISTS` — idempotente,
    segura de llamar en cada arranque, igual que `TaskStore._init_schema`)."""
    pool = pool or get_pool()
    statement_block = SCHEMA_PATH.read_text(encoding="utf-8")
    with pool.connection() as conn:
        conn.execute(statement_block)
        conn.commit()
