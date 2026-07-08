"""Analytics layer (Fase 3+).

Optional, additive read-only analytics over the Fase-1 Task/Run schema. The
DuckDB-backed aggregation lives in `duckdb_ops`; importing this package never
requires DuckDB to be installed (each function degrades gracefully instead).
"""
