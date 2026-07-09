"""DuckDB analytics layer over the Fase-1 SQLite schema (Fase 3).

Richer analytics than plain SQLite conveniently does — time-series buckets,
`PERCENTILE_CONT` latency percentiles, multi-dimensional grouping — for the
"professional Monitor" dashboard. This is *additive*: `GET /agents/performance`
(plain `GROUP BY provider_name` in SQLite) stays the canonical per-agent
summary; this module is for trends and distributions on top of it.

Design: DuckDB's `sqlite_scanner` attaches `data/task_logs.db` in-place per
call (no ETL, no sync subsystem) — sub-second at the current/expected scale
(thousands of rows). ETL to native DuckDB tables is a documented future step
only past ~100k rows. The attach is **READ_ONLY** so this analytics reader can
never take a write lock or contend with `TaskStore`'s WAL writes.

First-run note: `INSTALL sqlite` downloads the `sqlite_scanner` extension
binary the first time it runs on a machine (a one-time ~network dependency),
then caches it locally under DuckDB's extension directory. Subsequent calls
(and every query after the first) are fully offline. `INSTALL` is idempotent —
DuckDB no-ops if the extension is already present, so it is safe to call on
every connection.

Graceful degradation: if `duckdb` is not installed (it is a commented-optional
extra in requirements.txt, matching this codebase's convention), importing this
module still succeeds and every public function raises `AnalyticsUnavailable`
so the caller can return a friendly "analytics unavailable" state instead of a
500. Mirrors the `TREE_SITTER_AVAILABLE` pattern in `app/analysis/ts_analyzer.py`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.database import DEFAULT_DB_PATH

try:  # optional dependency — /analytics/dashboard degrades gracefully if absent
    import duckdb

    DUCKDB_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised via monkeypatch in tests
    duckdb = None  # type: ignore[assignment]
    DUCKDB_AVAILABLE = False


class AnalyticsUnavailable(RuntimeError):
    """Raised when the DuckDB analytics layer cannot run (duckdb not installed).

    Catchable by the API layer so it can answer `{"available": false, ...}` with
    a 200 rather than crashing the request with a 500.
    """


def _require_duckdb() -> None:
    if not DUCKDB_AVAILABLE:
        raise AnalyticsUnavailable(
            "duckdb is not installed — install the optional 'duckdb' extra "
            "(see requirements.txt) to enable /analytics/dashboard"
        )


def _connect(db_path: Path | str = DEFAULT_DB_PATH):
    """Open a DuckDB connection with the SQLite DB attached READ_ONLY as `tl`.

    The path is resolved to an absolute path the same way `TaskStore` resolves
    its default (via the shared `DEFAULT_DB_PATH`), so the two never drift onto
    different files.
    """
    _require_duckdb()
    abs_path = str(Path(db_path).resolve()).replace("'", "''")
    con = duckdb.connect()
    con.execute("INSTALL sqlite")  # idempotent: no-op if already installed
    con.execute("LOAD sqlite")
    # READ_ONLY: analytics-only reader, must never write to / lock the SQLite
    # file that TaskStore is concurrently writing to under WAL.
    con.execute(f"ATTACH '{abs_path}' AS tl (TYPE sqlite, READ_ONLY)")
    return con


def _rows(con, sql: str, params: list | None = None) -> list[dict[str, Any]]:
    """Execute a query and return JSON-serializable list-of-dicts.

    Floats are rounded lightly so the JSON payload stays compact/readable.
    """
    cur = con.execute(sql, params or [])
    columns = [d[0] for d in cur.description]
    out: list[dict[str, Any]] = []
    for row in cur.fetchall():
        record: dict[str, Any] = {}
        for key, value in zip(columns, row):
            if isinstance(value, float):
                value = round(value, 5)
            record[key] = value
        out.append(record)
    return out


def cost_by_provider_by_day(days: int = 30, db_path: Path | str = DEFAULT_DB_PATH) -> list[dict[str, Any]]:
    """Daily cost + run count per provider over the last `days` days.

    Time-series fuel for a stacked cost-over-time chart, broken down by the
    stable `provider_name` aggregation key.
    """
    con = _connect(db_path)
    try:
        return _rows(
            con,
            """
            SELECT
                CAST(completed_at AS TIMESTAMP)::DATE      AS day,
                provider_name,
                COUNT(*)                                   AS run_count,
                COALESCE(SUM(estimated_cost_usd), 0.0)     AS total_cost,
                COALESCE(SUM(COALESCE(input_tokens, 0)
                           + COALESCE(output_tokens, 0)), 0) AS total_tokens
            FROM tl.runs
            WHERE completed_at IS NOT NULL
              AND provider_name IS NOT NULL
              AND CAST(completed_at AS TIMESTAMP) >= now() - CAST(? AS INTEGER) * INTERVAL 1 DAY
            GROUP BY day, provider_name
            ORDER BY day, provider_name
            """,
            [days],
        )
    finally:
        con.close()


def latency_percentiles(
    provider_name: str | None = None, db_path: Path | str = DEFAULT_DB_PATH
) -> list[dict[str, Any]]:
    """p50 / p90 / p99 latency per provider via `PERCENTILE_CONT`.

    When `provider_name` is given, returns a single-row list for that provider;
    otherwise one row per provider. Percentiles beat a plain AVG for latency
    because latency distributions are heavily right-skewed.
    """
    con = _connect(db_path)
    try:
        where = "WHERE latency_ms IS NOT NULL AND provider_name IS NOT NULL"
        params: list = []
        if provider_name is not None:
            where += " AND provider_name = ?"
            params.append(provider_name)
        return _rows(
            con,
            f"""
            SELECT
                provider_name,
                COUNT(*)                                                  AS run_count,
                CAST(AVG(latency_ms) AS DOUBLE)                           AS avg_latency_ms,
                PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY latency_ms)  AS p50_latency_ms,
                PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY latency_ms)  AS p90_latency_ms,
                PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms)  AS p99_latency_ms
            FROM tl.runs
            {where}
            GROUP BY provider_name
            ORDER BY run_count DESC
            """,
            params,
        )
    finally:
        con.close()


def success_rate_by_task_type(db_path: Path | str = DEFAULT_DB_PATH) -> list[dict[str, Any]]:
    """Success rate + volume per task_type, joining runs back to `tasks_v2`.

    `runs.task_id` holds the legacy task id, which is `tasks_v2.legacy_task_id`
    (see the Fase-1 backfill) — that is the join key. A run is "successful" when
    its status is `completed` and it carries no error.
    """
    con = _connect(db_path)
    try:
        return _rows(
            con,
            """
            SELECT
                COALESCE(t.task_type, 'unknown')                          AS task_type,
                COUNT(*)                                                  AS run_count,
                SUM(CASE WHEN r.status = 'completed' AND r.error IS NULL
                         THEN 1 ELSE 0 END)                               AS success_count,
                CAST(AVG(CASE WHEN r.status = 'completed' AND r.error IS NULL
                              THEN 1.0 ELSE 0.0 END) AS DOUBLE)           AS success_rate,
                CAST(AVG(r.latency_ms) AS DOUBLE)                         AS avg_latency_ms,
                COALESCE(SUM(r.estimated_cost_usd), 0.0)                  AS total_cost
            FROM tl.runs r
            LEFT JOIN tl.tasks_v2 t ON t.legacy_task_id = r.task_id
            GROUP BY task_type
            ORDER BY run_count DESC
            """,
        )
    finally:
        con.close()


def runs_over_time(bucket: str = "day", db_path: Path | str = DEFAULT_DB_PATH) -> list[dict[str, Any]]:
    """Run volume / cost / avg-latency bucketed over time (day|week|month|hour).

    Powers the headline "activity over time" trend line on the Monitor.
    """
    allowed = {"hour", "day", "week", "month"}
    if bucket not in allowed:
        raise ValueError(f"bucket must be one of {sorted(allowed)}, got {bucket!r}")
    con = _connect(db_path)
    try:
        return _rows(
            con,
            f"""
            SELECT
                date_trunc('{bucket}', CAST(completed_at AS TIMESTAMP))  AS bucket,
                COUNT(*)                                                 AS run_count,
                SUM(CASE WHEN status = 'completed' AND error IS NULL
                         THEN 1 ELSE 0 END)                              AS success_count,
                COALESCE(SUM(estimated_cost_usd), 0.0)                   AS total_cost,
                CAST(AVG(latency_ms) AS DOUBLE)                          AS avg_latency_ms
            FROM tl.runs
            WHERE completed_at IS NOT NULL
            GROUP BY bucket
            ORDER BY bucket
            """,
        )
    finally:
        con.close()


def provider_leaderboard(db_path: Path | str = DEFAULT_DB_PATH) -> list[dict[str, Any]]:
    """Ranked provider summary: volume, cost, avg cost/run, error rate, tokens.

    A single multi-dimensional table the Monitor can render as a leaderboard —
    the analytics-layer companion to `/agents/performance` (which is intentionally
    lighter for the always-on Agents view).
    """
    con = _connect(db_path)
    try:
        return _rows(
            con,
            """
            SELECT
                provider_name,
                COUNT(*)                                                  AS run_count,
                SUM(CASE WHEN status = 'failed' OR error IS NOT NULL
                         THEN 1 ELSE 0 END)                               AS error_count,
                CAST(AVG(CASE WHEN status = 'failed' OR error IS NOT NULL
                              THEN 1.0 ELSE 0.0 END) AS DOUBLE)           AS error_rate,
                CAST(AVG(latency_ms) AS DOUBLE)                           AS avg_latency_ms,
                COALESCE(SUM(estimated_cost_usd), 0.0)                    AS total_cost,
                COALESCE(AVG(estimated_cost_usd), 0.0)                    AS avg_cost_per_run,
                COALESCE(SUM(COALESCE(input_tokens, 0)
                           + COALESCE(output_tokens, 0)), 0)             AS total_tokens
            FROM tl.runs
            WHERE provider_name IS NOT NULL
            GROUP BY provider_name
            ORDER BY run_count DESC, total_cost DESC
            """,
        )
    finally:
        con.close()


def agent_task_matrix(db_path: Path | str = DEFAULT_DB_PATH) -> list[dict[str, Any]]:
    """Cross-tab of provider (agent) x task_type with volume/quality/cost/latency.

    One row per (provider_name, task_type) combination that actually ran, joining
    `runs` back to `tasks_v2` on `legacy_task_id` (the same key used by
    `success_rate_by_task_type`). This is the canonical source for the Monitor's
    "relación Agente x Tarea" heatmap and the cost-vs-latency efficiency scatter:
    it exposes, per combination, the run volume, success rate, mean cost/run and
    mean latency so the frontend can pivot any of those into a magnitude matrix.
    """
    con = _connect(db_path)
    try:
        return _rows(
            con,
            """
            SELECT
                r.provider_name                                          AS provider_name,
                COALESCE(t.task_type, 'unknown')                         AS task_type,
                COUNT(*)                                                 AS run_count,
                SUM(CASE WHEN r.status = 'completed' AND r.error IS NULL
                         THEN 1 ELSE 0 END)                              AS success_count,
                CAST(AVG(CASE WHEN r.status = 'completed' AND r.error IS NULL
                              THEN 1.0 ELSE 0.0 END) AS DOUBLE)          AS success_rate,
                CAST(AVG(r.latency_ms) AS DOUBLE)                        AS avg_latency_ms,
                COALESCE(AVG(r.estimated_cost_usd), 0.0)                 AS avg_cost_per_run,
                COALESCE(SUM(r.estimated_cost_usd), 0.0)                 AS total_cost,
                SUM(CASE WHEN r.status = 'failed' OR r.error IS NOT NULL
                         THEN 1 ELSE 0 END)                              AS error_count
            FROM tl.runs r
            LEFT JOIN tl.tasks_v2 t ON t.legacy_task_id = r.task_id
            WHERE r.provider_name IS NOT NULL
            GROUP BY provider_name, task_type
            ORDER BY run_count DESC
            """,
        )
    finally:
        con.close()


def agent_task_flow(db_path: Path | str = DEFAULT_DB_PATH) -> list[dict[str, Any]]:
    """Run counts grouped by (task_type, provider, run status) for the flow Sankey.

    A single 3-way grouping the frontend collapses into the two link layers of a
    `Tipo de tarea -> Agente -> Estado` Sankey: summing over `status` yields the
    task_type -> provider links, summing over `task_type` yields the
    provider -> status links. Keeping it one query (vs. two) avoids a second scan
    and keeps the two link sets perfectly consistent.
    """
    con = _connect(db_path)
    try:
        return _rows(
            con,
            """
            SELECT
                COALESCE(t.task_type, 'unknown')                         AS task_type,
                r.provider_name                                          AS provider_name,
                r.status                                                 AS status,
                COUNT(*)                                                 AS run_count
            FROM tl.runs r
            LEFT JOIN tl.tasks_v2 t ON t.legacy_task_id = r.task_id
            WHERE r.provider_name IS NOT NULL
            GROUP BY task_type, provider_name, r.status
            ORDER BY run_count DESC
            """,
        )
    finally:
        con.close()


def dashboard(days: int = 30, db_path: Path | str = DEFAULT_DB_PATH) -> dict[str, Any]:
    """Assemble the full analytics dashboard payload in one call.

    Raises `AnalyticsUnavailable` (via `_connect`) if duckdb is absent — the API
    layer catches that and returns `{"available": false, ...}` with a 200.
    """
    return {
        "available": True,
        "window_days": days,
        "cost_by_provider_by_day": cost_by_provider_by_day(days, db_path),
        "latency_percentiles": latency_percentiles(None, db_path),
        "success_rate_by_task_type": success_rate_by_task_type(db_path),
        "runs_over_time": runs_over_time("day", db_path),
        "provider_leaderboard": provider_leaderboard(db_path),
        "agent_task_matrix": agent_task_matrix(db_path),
        "agent_task_flow": agent_task_flow(db_path),
    }
