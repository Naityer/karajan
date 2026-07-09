"""Startup banner for the interactive REPL — an ASCII wordmark plus a couple
of info panels, in the spirit of Claude Code's own welcome screen.
"""

from __future__ import annotations

import pyfiglet
from rich.align import Align
from rich.console import Group, RenderableType
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from karajan_cli.output import console as _console

# Below this console width, the two side-by-side panels wrap ugly (the ASCII
# logo needs ~38 cols on its own) — fall back to stacking them vertically.
_MIN_WIDTH_FOR_COLUMNS = 100

VERSION = "0.2.0"
_LOGO_FONT = "small"
_LOGO_COLOR = "bold cyan"


def _logo() -> Text:
    art = pyfiglet.figlet_format("KARAJAN", font=_LOGO_FONT).rstrip("\n")
    return Text(art, style=_LOGO_COLOR)


def _status_text(base_url: str, health: dict | None) -> Text:
    line = Text()
    if health is not None:
        line.append("● ", style="bold green")
        line.append("activo", style="green")
        line.append(f"  en {base_url}\n", style="dim")
        line.append(
            f"backend={health.get('backend')}  ·  perfil={health.get('profile')}  ·  tareas={health.get('total_tasks')}",
            style="dim",
        )
    else:
        line.append("● ", style="bold yellow")
        line.append("inactivo", style="yellow")
        line.append(f"  en {base_url}\n", style="dim")
        line.append("escribe /activate para arrancarlo o comprobarlo", style="dim")
    return line


def _decision_text(layout: dict | None, config: dict | None) -> Text | None:
    """Decisión (routing) architecture summary — entities/groups/dispatch mode."""
    if layout is None or config is None:
        return None
    n_entities = len(layout.get("entities", []))
    n_groups = len(layout.get("groups", []))
    dispatch_mode = (config.get("orchestration") or {}).get("dispatch_mode", "?")
    line = Text()
    line.append("Decisión: ", style="bold")
    line.append(f"{n_entities} agente(s)", style="magenta")
    line.append("  ·  ")
    line.append(f"{n_groups} grupo(s)", style="magenta")
    line.append("  ·  ")
    line.append(f"modo={dispatch_mode}", style="magenta")
    return line


def _availability_text(providers: list[dict] | None) -> Text | None:
    """Provider readiness check — how many catalog providers are actually usable now."""
    if providers is None:
        return None
    ready = [p["provider"] for p in providers if p.get("ready")]
    line = Text()
    color = "green" if ready else "yellow"
    line.append("Disponibilidad: ", style="bold")
    line.append(f"{len(ready)}/{len(providers)} proveedores listos", style=color)
    if ready:
        shown = ", ".join(ready[:4]) + (", ..." if len(ready) > 4 else "")
        line.append(f"\n{shown}", style="dim")
    return line


def _tips() -> Text:
    tips = Text()
    tips.append("Primeros pasos\n", style="bold")
    rows = [
        ("/activate --start", "arranca el harness"),
        ("<texto libre>", "clasifica y delega (muestra el log del proceso)"),
        ("/classify <texto>", "solo clasifica, sin delegar (vista previa)"),
        ("/assign <id> --to <agente>", "fuerza un agente concreto"),
        ("/task_list", "historial de tareas"),
        ("/help", "todos los comandos"),
        ("exit / clear", "salir · limpiar pantalla (sin \"/\")"),
    ]
    width = max(len(cmd) for cmd, _ in rows)
    for cmd, desc in rows:
        tips.append(f"{cmd:<{width}}  ", style="cyan")
        tips.append(f"{desc}\n")
    return tips[:-1]


def _content_height(renderable, width: int) -> int:
    options = _console.options.update(width=width, height=None)
    return len(_console.render_lines(renderable, options, pad=False))


def render(
    base_url: str,
    health: dict | None,
    layout: dict | None = None,
    config: dict | None = None,
    providers: list[dict] | None = None,
) -> RenderableType:
    left_items = [
        Align.center(_logo()),
        Align.center(Text(f"v{VERSION} · harness de orquestación multi-agente", style="dim")),
        Text(""),
        _status_text(base_url, health),
    ]
    decision = _decision_text(layout, config)
    if decision is not None:
        left_items += [Text(""), decision]
    availability = _availability_text(providers)
    if availability is not None:
        left_items += [Text(""), availability]

    left = Group(*left_items)
    tips = _tips()

    two_columns = _console.size.width >= _MIN_WIDTH_FOR_COLUMNS
    measure_width = (
        max(40, _console.size.width // 2 - 8) if two_columns else max(40, _console.size.width - 8)
    )
    target_h = max(_content_height(left, measure_width), _content_height(tips, measure_width))
    panel_height = target_h + 4  # +2 vertical padding, +2 top/bottom border

    left_panel = Panel(left, border_style="cyan", padding=(1, 2), height=panel_height)
    right_panel = Panel(tips, title="Tips", border_style="grey50", padding=(1, 2), height=panel_height)

    if two_columns:
        grid = Table.grid(expand=True, padding=(0, 1, 0, 0))
        grid.add_column(ratio=1)
        grid.add_column(ratio=1)
        grid.add_row(left_panel, right_panel)
        return grid
    return Group(left_panel, right_panel)
