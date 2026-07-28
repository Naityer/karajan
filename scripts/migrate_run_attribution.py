"""Repair agent attribution in `runs` and purge the retired simulated backend.

Two independent, destructive operations on `data/task_logs.db`. Both are
reported in full before anything is written, and nothing is written at all
without `--apply`.

  (a) normalize
      The pre-Fase-1 backfill (`TaskStore._backfill_v2`) wrote the whole
      `model_used` string into `runs.provider_name`, so `ollama-qwen` and
      `ollama-qwen:qwen2.5:7b` are the same agent counted twice in every
      `GROUP BY provider_name` aggregate — which is why the Monitor shows eight
      rows for four agents. Rows with that exact signature
      (`started_at IS NULL AND provider_name = model_id`) are split back into
      `(provider_name, model_id)` via `catalog.split_model_used`.

  (b) purge
      KARAJAN no longer ships a simulated provider, so rows attributed to it
      describe executions that never happened. They are deleted from `runs`
      (with their `run_events` / `artifacts`) and from the `executions` array
      inside the legacy `tasks.delegation` JSON.

Usage:
    python scripts/migrate_run_attribution.py                  # report only
    python scripts/migrate_run_attribution.py --apply          # write (makes a .bak)
    python scripts/migrate_run_attribution.py --db other.db --apply
"""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app import catalog  # noqa: E402  - needs the sys.path shim above

DEFAULT_DB = PROJECT_ROOT / "data" / "task_logs.db"

# `model_used` values the retired provider produced, plus the bare provider name.
SIMULATED_PREFIX = "simulated"


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _is_simulated(provider_name: str | None) -> bool:
    if not provider_name:
        return False
    return provider_name == SIMULATED_PREFIX or provider_name.startswith(f"{SIMULATED_PREFIX}:")


def plan_normalize(conn: sqlite3.Connection) -> tuple[list[dict], list[dict]]:
    """Rows to rewrite, and rows that match the backfill signature but whose
    prefix is not a catalog provider (reported, never guessed at)."""
    rows = conn.execute(
        """
        SELECT id, provider_name, model_id
          FROM runs
         WHERE started_at IS NULL
           AND provider_name IS NOT NULL
           AND provider_name = model_id
        """
    ).fetchall()

    fixable: list[dict] = []
    unknown: list[dict] = []
    for row in rows:
        if _is_simulated(row["provider_name"]):
            continue  # handled by the purge step, not this one
        provider_name, model_id = catalog.split_model_used(row["provider_name"])
        target = fixable if provider_name else unknown
        target.append(
            {
                "id": row["id"],
                "before": row["provider_name"],
                "provider_name": provider_name,
                "model_id": model_id,
            }
        )
    return fixable, unknown


def plan_purge(conn: sqlite3.Connection) -> tuple[list[str], list[tuple[str, int]]]:
    """Simulated `runs` ids, and `(task_id, count)` for legacy JSON executions."""
    run_ids = [
        row["id"]
        for row in conn.execute("SELECT id, provider_name FROM runs").fetchall()
        if _is_simulated(row["provider_name"])
    ]

    tasks: list[tuple[str, int]] = []
    for row in conn.execute(
        "SELECT task_id, delegation_json FROM tasks WHERE delegation_json IS NOT NULL"
    ).fetchall():
        try:
            delegation = json.loads(row["delegation_json"])
        except (TypeError, ValueError):
            continue
        executions = delegation.get("executions") or []
        simulated = sum(
            1 for item in executions if str(item.get("model_used", "")).startswith(SIMULATED_PREFIX)
        )
        if simulated:
            tasks.append((row["task_id"], simulated))
    return run_ids, tasks


def apply_normalize(conn: sqlite3.Connection, fixable: list[dict]) -> None:
    conn.executemany(
        "UPDATE runs SET provider_name = ?, model_id = ? WHERE id = ?",
        [(item["provider_name"], item["model_id"], item["id"]) for item in fixable],
    )


def apply_purge(conn: sqlite3.Connection, run_ids: list[str], tasks: list[tuple[str, int]]) -> None:
    if run_ids:
        marks = ",".join("?" * len(run_ids))
        conn.execute(f"DELETE FROM run_events WHERE run_id IN ({marks})", run_ids)
        conn.execute(f"DELETE FROM artifacts WHERE run_id IN ({marks})", run_ids)
        conn.execute(f"DELETE FROM runs WHERE id IN ({marks})", run_ids)

    for task_id, _ in tasks:
        row = conn.execute(
            "SELECT delegation_json FROM tasks WHERE task_id = ?", (task_id,)
        ).fetchone()
        if row is None:
            continue
        delegation = json.loads(row["delegation_json"])
        kept = [
            item
            for item in (delegation.get("executions") or [])
            if not str(item.get("model_used", "")).startswith(SIMULATED_PREFIX)
        ]
        delegation["executions"] = kept
        # Recompute the totals so the stored aggregate matches what is left,
        # instead of still counting the executions we just removed.
        delegation["total_latency_ms"] = sum(int(item.get("latency_ms") or 0) for item in kept)
        delegation["total_estimated_cost_usd"] = round(
            sum(float(item.get("estimated_cost_usd") or 0.0) for item in kept), 5
        )
        delegation["total_input_tokens"] = sum(int(item.get("input_tokens") or 0) for item in kept)
        delegation["total_output_tokens"] = sum(int(item.get("output_tokens") or 0) for item in kept)
        conn.execute(
            "UPDATE tasks SET delegation_json = ?, est_cost = ? WHERE task_id = ?",
            (
                json.dumps(delegation, ensure_ascii=False),
                delegation["total_estimated_cost_usd"],
                task_id,
            ),
        )


def report(fixable: list[dict], unknown: list[dict], run_ids: list[str], tasks: list[tuple[str, int]]) -> None:
    print("\n(a) Normalizar atribucion de agente")
    if fixable:
        collapsed: dict[str, int] = {}
        for item in fixable:
            collapsed[f"{item['before']} -> {item['provider_name']}"] = (
                collapsed.get(f"{item['before']} -> {item['provider_name']}", 0) + 1
            )
        for label, count in sorted(collapsed.items()):
            print(f"    {count:>4}  {label}")
        print(f"    total: {len(fixable)} fila(s)")
    else:
        print("    nada que normalizar")

    if unknown:
        print(f"\n    AVISO: {len(unknown)} fila(s) con firma de backfill cuyo prefijo no esta")
        print("    en el catalogo; se dejan intactas (no se adivina el proveedor):")
        for item in unknown[:10]:
            print(f"        {item['before']}")

    print("\n(b) Purgar el backend simulado")
    print(f"    runs a borrar: {len(run_ids)}")
    print(f"    tasks con ejecuciones simuladas en el JSON legacy: {len(tasks)}")
    for task_id, count in tasks[:10]:
        print(f"        {task_id}: {count} ejecucion(es)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="ruta a task_logs.db")
    parser.add_argument("--apply", action="store_true", help="escribir los cambios (por defecto solo informa)")
    parser.add_argument("--skip-normalize", action="store_true")
    parser.add_argument("--skip-purge", action="store_true")
    args = parser.parse_args()

    if not args.db.exists():
        print(f"No existe la base de datos: {args.db}")
        return 1

    conn = _connect(args.db)
    try:
        fixable, unknown = ([], []) if args.skip_normalize else plan_normalize(conn)
        run_ids, tasks = ([], []) if args.skip_purge else plan_purge(conn)

        print(f"Base de datos: {args.db}")
        report(fixable, unknown, run_ids, tasks)

        if not args.apply:
            print("\nDRY-RUN: no se ha escrito nada. Repite con --apply para aplicarlo.")
            return 0

        if not fixable and not run_ids and not tasks:
            print("\nNada que aplicar.")
            return 0

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = args.db.with_suffix(f".{stamp}.bak")
        conn.close()
        shutil.copy2(args.db, backup)
        print(f"\nCopia de seguridad: {backup}")

        conn = _connect(args.db)
        with conn:
            if fixable:
                apply_normalize(conn, fixable)
            if run_ids or tasks:
                apply_purge(conn, run_ids, tasks)
        print("Aplicado.")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
