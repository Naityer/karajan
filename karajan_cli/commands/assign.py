from __future__ import annotations

import typer

from karajan_cli import output
from karajan_cli.client import KarajanClient


def assign(
    ctx: typer.Context,
    task_id: str = typer.Argument(None, help="ID de una tarea ya clasificada (omítelo si usas --prompt)."),
    to: str = typer.Option(..., "--to", help="Nombre de proveedor del catálogo, o id de RoutingEntity con --entity."),
    entity: bool = typer.Option(
        False, "--entity", help="Interpreta --to como un id de RoutingEntity de la jerarquía en vez de un proveedor."
    ),
    prompt: str = typer.Option(
        None, "--prompt", help="Clasifica este prompt y fuerza la delegación en un solo paso (alternativa a task_id)."
    ),
) -> None:
    """Fuerza la delegación de una tarea a un agente/proveedor concreto,
    saltándose el enrutado automático por tier/complejidad."""
    client: KarajanClient = ctx.obj["client"]

    if bool(task_id) == bool(prompt):
        typer.echo("Pasa exactamente uno de <task_id> o --prompt.", err=True)
        raise typer.Exit(code=1)

    if prompt:
        classified = client.classify(prompt)
        task_id = classified["task_id"]

    force_provider = None if entity else to
    force_entity_id = to if entity else None

    record = client.delegate(task_id, force_provider=force_provider, force_entity_id=force_entity_id)
    if ctx.obj["json"]:
        output.print_json(record)
        return
    execution = ((record.get("delegation") or {}).get("executions") or [{}])[0]
    output.print_kv(
        {
            "task_id": record["task_id"],
            "status": record["status"],
            "agente_forzado": to,
            "backend": execution.get("backend"),
            "modelo_usado": execution.get("model_used"),
            "latencia_ms": execution.get("latency_ms"),
        }
    )
