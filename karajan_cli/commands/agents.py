from __future__ import annotations

import typer

from karajan_cli import output
from karajan_cli.client import KarajanClient

app = typer.Typer(no_args_is_help=True)


@app.command("list")
def list_catalog(ctx: typer.Context) -> None:
    """Catálogo estático de proveedores conocidos (GET /catalog)."""
    client: KarajanClient = ctx.obj["client"]
    data = client.list_catalog()
    if ctx.obj["json"]:
        output.print_json(data)
        return
    rows = [
        {"name": p["name"], "label": p.get("label", ""), "backend": p["backend"], "gratis": p.get("is_free", False)}
        for p in data
    ]
    output.print_table(rows, title="Catálogo de proveedores")


@app.command("status")
def status(ctx: typer.Context, name: str = typer.Argument(None, help="Filtra a un solo proveedor.")) -> None:
    """Estado de credenciales/disponibilidad en vivo (GET /providers)."""
    client: KarajanClient = ctx.obj["client"]
    data = client.list_providers()
    if name:
        data = [p for p in data if p["provider"] == name]
    if ctx.obj["json"]:
        output.print_json(data)
        return
    rows = [
        {"provider": p["provider"], "listo": p["ready"], "disponible": p["available"], "detalle": p.get("detail", "")}
        for p in data
    ]
    output.print_table(rows, title="Estado de proveedores")


@app.command("setup")
def setup(ctx: typer.Context, name: str) -> None:
    """Pasos guiados para activar/conectar un proveedor (GET /providers/{name}/setup)."""
    client: KarajanClient = ctx.obj["client"]
    data = client.provider_setup(name)
    if ctx.obj["json"]:
        output.print_json(data)
        return
    typer.echo(f"{name} (disponible={data['available']})")
    for i, step in enumerate(data.get("steps", []), start=1):
        typer.echo(f"  {i}. {step}")
    if data.get("signup_url"):
        typer.echo(f"  URL: {data['signup_url']}")


@app.command("login")
def login(ctx: typer.Context, name: str) -> None:
    """Ejecuta el comando de login del catálogo para este proveedor."""
    _run(ctx, name, "login_command")


@app.command("probe")
def probe(ctx: typer.Context, name: str) -> None:
    """Ejecuta el comando de verificación/salud del catálogo para este proveedor."""
    _run(ctx, name, "probe_command")


def _run(ctx: typer.Context, name: str, slot: str) -> None:
    client: KarajanClient = ctx.obj["client"]
    result = client.provider_run(name, slot)
    if ctx.obj["json"]:
        output.print_json(result)
        return
    status_txt = "OK" if result["ok"] else "FALLO"
    header = f"[{status_txt}] {result['command']}" if result.get("command") else f"[{status_txt}]"
    typer.echo(header)
    if result.get("detail"):
        typer.echo(result["detail"])
    if result.get("stdout"):
        typer.echo(result["stdout"])
    if result.get("stderr"):
        typer.echo(result["stderr"], err=True)
    if not result["ok"]:
        raise typer.Exit(code=1)
