"""Kit de comandos CLI de Karajan: activación, asignación forzada a un agente,
configuración de la arquitectura de Decisión, estadísticas y gestión de
agentes/proveedores. Funciona igual desde una terminal normal que desde
cualquier agente de IA con acceso a shell (Claude Code, aider, etc.).
"""

from __future__ import annotations

import sys

import typer

from karajan_cli import repl as repl_module
from karajan_cli.client import DEFAULT_URL, KarajanApiError, KarajanClient
from karajan_cli.commands import activate as activate_cmd
from karajan_cli.commands import agents as agents_cmd
from karajan_cli.commands import assign as assign_cmd
from karajan_cli.commands import config as config_cmd
from karajan_cli.commands import layout as layout_cmd
from karajan_cli.commands import stats as stats_cmd
from karajan_cli.commands import tasks as tasks_cmd

app = typer.Typer(
    no_args_is_help=False,
    add_completion=False,
    help=(
        "CLI de Karajan: activación del harness, asignación de tareas a un agente "
        "concreto, configuración de la arquitectura de Decisión, estadísticas y "
        "gestión de agentes/proveedores. Sin subcomando, entra en modo interactivo."
    ),
)


@app.callback(invoke_without_command=True)
def main(
    ctx: typer.Context,
    url: str = typer.Option(None, "--url", envvar="KARAJAN_URL", help=f"URL del servidor Karajan (default {DEFAULT_URL})."),
    token: str = typer.Option(None, "--token", envvar="KARAJAN_TOKEN", help="Token de mutación (X-Karajan-Token)."),
    json_output: bool = typer.Option(False, "--json", help="Salida en JSON crudo en vez de tablas."),
) -> None:
    ctx.obj = {"client": KarajanClient(base_url=url, token=token), "json": json_output}
    if ctx.invoked_subcommand is None:
        repl_module.run(ctx.obj["client"], ctx.obj["json"])
        raise typer.Exit()


# Comandos de nivel superior (sin subgrupo)
app.command(name="activate")(activate_cmd.activate)
app.command(name="classify")(tasks_cmd.classify)
app.command(name="ingest")(tasks_cmd.ingest)
app.command(name="assign")(assign_cmd.assign)


@app.command(name="repl", help="Entra en modo interactivo explícitamente (igual que ejecutar `karajan` sin argumentos).")
def repl_command(ctx: typer.Context) -> None:
    repl_module.run(ctx.obj["client"], ctx.obj["json"])


# Grupos de subcomandos
app.add_typer(tasks_cmd.app, name="tasks", help="Listar/consultar tareas y su historial de decisiones.")
app.add_typer(config_cmd.app, name="config", help="Configuración de KarajanConfig (pesos, umbrales, modo de despacho).")
app.add_typer(layout_cmd.app, name="layout", help="Arquitectura de Decisión: jerarquía de agentes, grupos y Prio.")
app.add_typer(stats_cmd.app, name="stats", help="Estadísticas y analítica del harness.")
app.add_typer(agents_cmd.app, name="agents", help="Catálogo y activación/conexión de proveedores.")


def run() -> None:
    """Console-script entry point: catches `KarajanApiError` for a clean
    one-line message instead of a full traceback (Typer's default pretty-print
    still applies to genuine bugs)."""
    try:
        app()
    except KarajanApiError as exc:
        typer.echo(f"ERROR: {exc}", err=True)
        sys.exit(1)


if __name__ == "__main__":
    run()
