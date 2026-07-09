"""Rendering helpers shared by every CLI command (table/JSON, `--json` flag)."""

from __future__ import annotations

import json as json_module
from typing import Any

from rich.console import Console
from rich.table import Table

console = Console()


def print_json(data: Any) -> None:
    console.print_json(json_module.dumps(data, default=str))


def print_table(rows: list[dict], columns: list[str] | None = None, title: str | None = None) -> None:
    if not rows:
        console.print("(sin resultados)")
        return
    columns = columns or list(rows[0].keys())
    table = Table(title=title)
    for column in columns:
        table.add_column(column)
    for row in rows:
        table.add_row(*(_cell(row.get(column)) for column in columns))
    console.print(table)


_PHASE_STYLE = {"classify": "blue", "assign": "magenta", "delegate": "cyan", "validate": "green"}


def print_timeline(decisions: list[dict]) -> None:
    """Render a task's decision log (classify/assign/delegate/validate) as a
    simple step-by-step timeline — the "process log" shown after /classify
    free-text runs the full classify+delegate pipeline in the REPL.
    """
    if not decisions:
        console.print("(sin decisiones registradas)")
        return
    for entry in decisions:
        phase = entry.get("phase", "?")
        style = _PHASE_STYLE.get(phase, "white")
        backend = entry.get("backend")
        suffix = f"  [dim]({backend})[/dim]" if backend else ""
        console.print(f"  [{style}][{phase}][/{style}] {entry.get('decision', '')}{suffix}")
        reason = entry.get("reason")
        if reason:
            console.print(f"      {reason}", style="dim")


def print_kv(data: dict) -> None:
    table = Table(show_header=False)
    table.add_column("campo", style="bold")
    table.add_column("valor")
    for key, value in data.items():
        table.add_row(str(key), _cell(value))
    console.print(table)


def _cell(value: Any) -> str:
    if isinstance(value, (dict, list)):
        return json_module.dumps(value, default=str, ensure_ascii=False)
    return "" if value is None else str(value)
