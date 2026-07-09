from __future__ import annotations

from pathlib import Path

import typer

from karajan_cli import serverctl, userconfig
from karajan_cli.client import KarajanClient
from karajan_cli.output import console

_NEXT_STEP_HINT = 'Ya puedes escribir tareas: /classify <texto> en el REPL, o karajan classify "..." en la terminal.'


def activate(
    ctx: typer.Context,
    start: bool = typer.Option(
        False, "--start/--no-start", help="Arranca el servidor si no está activo (por defecto, solo reporta su estado)."
    ),
    wait: float = typer.Option(10.0, "--wait", help="Segundos a esperar a que /health responda tras arrancar."),
    port: int = typer.Option(8000, "--port", help="Puerto para el servidor arrancado con --start."),
    repo: str = typer.Option(
        None, "--repo", help="Raíz del repo Karajan (si no se detecta automáticamente ni hay una recordada)."
    ),
) -> None:
    """Comprueba que el harness esté activo y, si se pide, lo arranca.

    Es el comando de activación: úsalo primero para garantizar que ya puedes
    escribir tareas y usar la arquitectura de reparto (jerarquía/Decisión) sin
    más pasos manuales. Funciona desde cualquier carpeta: la primera vez que
    `--start` localiza el repo (por estar dentro de él o vía --repo), recuerda
    la ruta en `~/.karajan/config.json` para las siguientes veces.
    """
    client: KarajanClient = ctx.obj["client"]

    if client.is_running():
        health = client.health()
        console.print(
            f"[green]Karajan activo[/green] en {client.base_url} — "
            f"backend={health.get('backend')} perfil={health.get('profile')} tareas={health.get('total_tasks')}"
        )
        console.print(_NEXT_STEP_HINT)
        return

    if not start:
        console.print(f"[red]Karajan no está activo[/red] en {client.base_url}.")
        remembered = userconfig.get_repo_root()
        if remembered:
            console.print(f"Repo recordado: {remembered}. Repite con --start para arrancarlo desde aquí.")
        else:
            console.print("Arráncalo con una de estas opciones, o repite este comando con --start:")
            for hint in serverctl.LAUNCH_HINTS:
                console.print(f"  - {hint}")
        raise typer.Exit(code=1)

    repo_root = Path(repo).resolve() if repo else serverctl.find_repo_root()
    if repo_root is None:
        console.print(
            "[red]No se encontró la raíz del repo Karajan[/red] (busca app/main.py), ni hay una recordada en "
            "~/.karajan/config.json. Usa --repo <ruta> una vez, o ejecuta este comando desde dentro del repo."
        )
        raise typer.Exit(code=1)

    console.print(f"Arrancando Karajan desde {repo_root} en el puerto {port}...")
    serverctl.start_server(repo_root, port)
    if client.base_url != f"http://127.0.0.1:{port}":
        console.print(
            f"[yellow]Aviso:[/yellow] --url/KARAJAN_URL apunta a {client.base_url}, "
            f"pero el servidor arranca en el puerto {port}."
        )

    if serverctl.wait_for_health(client, wait):
        userconfig.remember_repo_root(repo_root)
        health = client.health()
        console.print(f"[green]Karajan listo[/green] — backend={health.get('backend')} perfil={health.get('profile')}")
        console.print(f"Recordado como repo Karajan por defecto — a partir de ahora funciona desde cualquier carpeta.")
        console.print(_NEXT_STEP_HINT)
    else:
        console.print(f"[red]Karajan no respondió a /health tras {wait}s.[/red] Revisa el proceso uvicorn arrancado.")
        raise typer.Exit(code=1)
