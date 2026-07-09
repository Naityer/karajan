from __future__ import annotations

import typer

from karajan_cli import output
from karajan_cli.client import KarajanClient

app = typer.Typer(no_args_is_help=True)


def _get_path(data: dict, dotted: str):
    node = data
    for part in dotted.split("."):
        node = node[part]
    return node


def _set_path(data: dict, dotted: str, value) -> None:
    parts = dotted.split(".")
    node = data
    for part in parts[:-1]:
        node = node[part]
    node[parts[-1]] = value


def _coerce(raw: str):
    for cast in (int, float):
        try:
            return cast(raw)
        except ValueError:
            continue
    if raw.lower() in ("true", "false"):
        return raw.lower() == "true"
    return raw


@app.command("show")
def show(ctx: typer.Context) -> None:
    """Vuelca la KarajanConfig activa completa."""
    client: KarajanClient = ctx.obj["client"]
    config = client.get_config()
    if ctx.obj["json"]:
        output.print_json(config)
        return
    output.print_kv(config)


@app.command("get")
def get(ctx: typer.Context, path: str = typer.Argument(..., help="Ruta con puntos, ej. orchestration.dispatch_mode")) -> None:
    """Lee un campo concreto de la config por ruta con puntos."""
    client: KarajanClient = ctx.obj["client"]
    config = client.get_config()
    typer.echo(_get_path(config, path))


@app.command("set")
def set_value(ctx: typer.Context, path: str, value: str) -> None:
    """Escribe un campo concreto (lectura-modificación-escritura de /config)."""
    client: KarajanClient = ctx.obj["client"]
    config = client.get_config()
    _set_path(config, path, _coerce(value))
    updated = client.put_config(config)
    typer.echo(f"{path} = {_get_path(updated, path)}")


@app.command("set-provider-pref")
def set_provider_pref(ctx: typer.Context, tier: str, provider: str) -> None:
    """Sugar sobre provider_preferences[tier] = provider."""
    client: KarajanClient = ctx.obj["client"]
    config = client.get_config()
    config["provider_preferences"][tier] = provider
    client.put_config(config)
    typer.echo(f"provider_preferences.{tier} = {provider}")


@app.command("set-weight")
def set_weight(ctx: typer.Context, criterion: str, value: float) -> None:
    """Sugar sobre criteria_weights[criterion] = value."""
    client: KarajanClient = ctx.obj["client"]
    config = client.get_config()
    config["criteria_weights"][criterion] = value
    client.put_config(config)
    typer.echo(f"criteria_weights.{criterion} = {value}")


@app.command("set-threshold")
def set_threshold(ctx: typer.Context, index: int, value: float) -> None:
    """Sugar sobre level_thresholds[index] = value (índices 0-3, los 4 cortes entre N1..N5)."""
    client: KarajanClient = ctx.obj["client"]
    config = client.get_config()
    config["level_thresholds"][index] = value
    client.put_config(config)
    typer.echo(f"level_thresholds[{index}] = {value}")


@app.command("set-dispatch-mode")
def set_dispatch_mode(ctx: typer.Context, mode: str) -> None:
    """Cambia orchestration.dispatch_mode entre 'sync' y 'queue'."""
    if mode not in ("sync", "queue"):
        typer.echo("mode debe ser 'sync' o 'queue'", err=True)
        raise typer.Exit(code=1)
    client: KarajanClient = ctx.obj["client"]
    config = client.get_config()
    config["orchestration"]["dispatch_mode"] = mode
    client.put_config(config)
    typer.echo(f"orchestration.dispatch_mode = {mode}")
