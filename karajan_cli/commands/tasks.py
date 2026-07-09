from __future__ import annotations

import json as json_module
from pathlib import Path

import typer

from karajan_cli import output
from karajan_cli.client import KarajanClient

app = typer.Typer(no_args_is_help=True)


def classify(ctx: typer.Context, prompt: str = typer.Argument(..., help="Prompt a clasificar.")) -> None:
    """Clasifica un prompt sin delegarlo (POST /classify-task)."""
    client: KarajanClient = ctx.obj["client"]
    record = client.classify(prompt)
    if ctx.obj["json"]:
        output.print_json(record)
        return
    c = record["classification"]
    output.print_kv(
        {
            "task_id": record["task_id"],
            "nivel": c["complexity_level"],
            "score": c["complexity_score"],
            "modelo_recomendado": c["recommended_model"],
            "revision_humana": c["requires_human_review"],
            "subtareas": len(c["subtasks"]),
        }
    )


def ingest(
    ctx: typer.Context,
    file: Path = typer.Option(..., "--file", exists=True, readable=True, help="JSON con el payload IngestRequest."),
) -> None:
    """Registra una clasificación ya hecha por el propio LLM (POST /ingest).

    Alternativa preferida al `curl` crudo descrito en `skills/karajan/SKILL.md`:
    maneja servidor caído y formatea la respuesta.
    """
    client: KarajanClient = ctx.obj["client"]
    payload = json_module.loads(file.read_text(encoding="utf-8"))
    record = client.ingest(payload)
    if ctx.obj["json"]:
        output.print_json(record)
        return
    output.print_kv({"task_id": record["task_id"], "nivel": record["classification"]["complexity_level"]})


@app.command("list")
def list_tasks(
    ctx: typer.Context,
    limit: int = typer.Option(20, "--limit"),
    offset: int = typer.Option(0, "--offset"),
) -> None:
    """Historial de tareas, más recientes primero."""
    client: KarajanClient = ctx.obj["client"]
    records = client.list_tasks(limit=limit, offset=offset)
    if ctx.obj["json"]:
        output.print_json(records)
        return
    rows = [
        {
            "task_id": r["task_id"],
            "status": r["status"],
            "nivel": r["classification"]["complexity_level"],
            "modelo": r["classification"]["recommended_model"],
        }
        for r in records
    ]
    output.print_table(rows, title="Tareas")


@app.command("show")
def show_task(ctx: typer.Context, task_id: str) -> None:
    """Detalle de una tarea."""
    client: KarajanClient = ctx.obj["client"]
    record = client.get_task(task_id)
    if ctx.obj["json"]:
        output.print_json(record)
        return
    output.print_kv(record)


@app.command("decisions")
def show_decisions(ctx: typer.Context, task_id: str) -> None:
    """Historial de decisiones del harness para una tarea."""
    client: KarajanClient = ctx.obj["client"]
    decisions = client.get_decisions(task_id)
    if ctx.obj["json"]:
        output.print_json(decisions)
        return
    output.print_table(decisions, title=f"Decisiones de {task_id}")


@app.command("approve")
def approve(ctx: typer.Context, task_id: str) -> None:
    """Libera la puerta de revisión humana de una tarea N5/crítica."""
    client: KarajanClient = ctx.obj["client"]
    record = client.approve_review(task_id)
    if ctx.obj["json"]:
        output.print_json(record)
        return
    output.print_kv({"task_id": record["task_id"], "status": record["status"]})


@app.command("search")
def search(ctx: typer.Context, query: str, limit: int = typer.Option(20, "--limit")) -> None:
    """Búsqueda de texto completo (FTS5) sobre el historial de tareas."""
    client: KarajanClient = ctx.obj["client"]
    result = client.search_tasks(query, limit=limit)
    if ctx.obj["json"]:
        output.print_json(result)
        return
    output.print_table(result.get("results", []), title=f"Resultados para '{query}'")
