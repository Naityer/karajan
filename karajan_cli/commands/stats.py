from __future__ import annotations

import typer

from karajan_cli import output
from karajan_cli.client import KarajanClient

app = typer.Typer(no_args_is_help=True)


@app.command("health")
def health(ctx: typer.Context) -> None:
    """Estado de salud del harness (GET /health)."""
    client: KarajanClient = ctx.obj["client"]
    data = client.health()
    if ctx.obj["json"]:
        output.print_json(data)
        return
    output.print_kv(data)


@app.command("metrics")
def metrics(ctx: typer.Context) -> None:
    """Métricas agregadas (GET /metrics)."""
    client: KarajanClient = ctx.obj["client"]
    data = client.metrics()
    if ctx.obj["json"]:
        output.print_json(data)
        return
    output.print_kv(data)


@app.command("agents")
def agents_performance(ctx: typer.Context) -> None:
    """Coste/latencia/tasa de error por proveedor (GET /agents/performance)."""
    client: KarajanClient = ctx.obj["client"]
    data = client.agents_performance()
    if ctx.obj["json"]:
        output.print_json(data)
        return
    output.print_table(data, title="Rendimiento por agente")


@app.command("dashboard")
def dashboard(ctx: typer.Context, days: int = typer.Option(30, "--days")) -> None:
    """Analítica DuckDB completa (coste/latencia/leaderboard/heatmap). Requiere duckdb instalado."""
    client: KarajanClient = ctx.obj["client"]
    data = client.dashboard(days=days)
    output.print_json(data)


@app.command("leaderboard")
def leaderboard(ctx: typer.Context, days: int = typer.Option(30, "--days")) -> None:
    """Solo el ranking de proveedores del dashboard de analítica."""
    client: KarajanClient = ctx.obj["client"]
    data = client.dashboard(days=days)
    if not data.get("available", True):
        typer.echo(data.get("reason", "analítica no disponible"), err=True)
        raise typer.Exit(code=1)
    rows = data.get("provider_leaderboard", [])
    if ctx.obj["json"]:
        output.print_json(rows)
        return
    output.print_table(rows, title="Leaderboard de proveedores")


@app.command("observability")
def observability(
    ctx: typer.Context,
    history: int = typer.Option(
        0, "--history", help="Si es > 0, muestra el histórico de KPIs con ese límite en vez del snapshot actual."
    ),
) -> None:
    """Snapshot u historial de KPIs de observabilidad (GET /observability[/history])."""
    client: KarajanClient = ctx.obj["client"]
    data = client.observability_history(limit=history) if history > 0 else client.observability()
    if ctx.obj["json"]:
        output.print_json(data)
        return
    output.print_kv(data)


@app.command("search")
def search(ctx: typer.Context, query: str, limit: int = typer.Option(20, "--limit")) -> None:
    """Búsqueda de texto completo (FTS5) sobre el historial de tareas."""
    client: KarajanClient = ctx.obj["client"]
    data = client.search_tasks(query, limit=limit)
    if ctx.obj["json"]:
        output.print_json(data)
        return
    output.print_table(data.get("results", []), title=f"Resultados para '{query}'")
