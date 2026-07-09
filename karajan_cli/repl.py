"""Interactive REPL: slash commands with Tab-autocomplete, free-text prompts
with no quoting needed — the terminal counterpart to the Claude Code UI.

Every command has two equivalent forms, both fully-spelled words (no
cryptic abbreviations):
  - long form:  /<domain> <subcommand> [args...]   e.g. /tasks show tsk_123
  - short form: /<domain>_<subcommand> [args...]   e.g. /task_show tsk_123
Both resolve to the exact same underlying command (see SHORT_COMMANDS).

`/classify <texto>` (or just `<texto>` with no leading slash) sends the rest
of the line verbatim as the prompt — no quoting needed. Every other slash
command is a thin dispatcher into the same `karajan` Typer app used by the
one-shot shell commands (`karajan tasks show ...` etc.), so there is exactly
one implementation of each command's logic.
"""

from __future__ import annotations

import shlex
import sys
import time
from pathlib import Path

from prompt_toolkit import PromptSession
from prompt_toolkit.completion import FuzzyCompleter, NestedCompleter
from prompt_toolkit.history import FileHistory
from rich.panel import Panel

from karajan_cli import banner, output
from karajan_cli.client import KarajanApiError, KarajanClient

HISTORY_FILE = Path.home() / ".karajan" / "repl_history"

_QUEUE_POLL_INTERVAL_S = 1.5
_QUEUE_POLL_MAX_ATTEMPTS = 80  # ~2 minutes

# Commands with no domain/subcommand split — already a single, full word.
_TOP_LEVEL = {"activate", "classify", "assign", "help", "exit", "json", "clear"}

# The only two words that act as commands even without a leading "/" — muscle
# memory from every other shell/REPL. Everything else without "/" is a prompt.
_BARE_COMMANDS = {"exit", "clear"}

# short form (snake_case, one token) -> [domain, subcommand, ...] long-form path.
SHORT_COMMANDS: dict[str, list[str]] = {
    "task_list": ["tasks", "list"],
    "task_show": ["tasks", "show"],
    "task_decisions": ["tasks", "decisions"],
    "task_approve": ["tasks", "approve"],
    "task_search": ["tasks", "search"],
    "config_show": ["config", "show"],
    "config_get": ["config", "get"],
    "config_set": ["config", "set"],
    "config_set_provider_pref": ["config", "set-provider-pref"],
    "config_set_weight": ["config", "set-weight"],
    "config_set_threshold": ["config", "set-threshold"],
    "config_set_dispatch_mode": ["config", "set-dispatch-mode"],
    "layout_show": ["layout", "show"],
    "layout_entity_list": ["layout", "entities", "list"],
    "layout_entity_add": ["layout", "entities", "add"],
    "layout_entity_edit": ["layout", "entities", "edit"],
    "layout_entity_remove": ["layout", "entities", "remove"],
    "layout_group_list": ["layout", "groups", "list"],
    "layout_group_add": ["layout", "groups", "add"],
    "layout_group_remove": ["layout", "groups", "remove"],
    "layout_membership_set": ["layout", "membership", "set"],
    "layout_membership_unset": ["layout", "membership", "unset"],
    "stats_health": ["stats", "health"],
    "stats_metrics": ["stats", "metrics"],
    "stats_agents": ["stats", "agents"],
    "stats_dashboard": ["stats", "dashboard"],
    "stats_leaderboard": ["stats", "leaderboard"],
    "stats_observability": ["stats", "observability"],
    "stats_search": ["stats", "search"],
    "agent_list": ["agents", "list"],
    "agent_status": ["agents", "status"],
    "agent_setup": ["agents", "setup"],
    "agent_login": ["agents", "login"],
    "agent_probe": ["agents", "probe"],
    # explicit synonym for the one example given when this naming scheme was defined
    "state_health": ["stats", "health"],
}

# domain -> subcommands, for the long form's Tab-completion.
_DOMAINS: dict[str, dict | None] = {
    "tasks": {"list": None, "show": None, "decisions": None, "approve": None, "search": None},
    "config": {
        "show": None,
        "get": None,
        "set": None,
        "set-provider-pref": None,
        "set-weight": None,
        "set-threshold": None,
        "set-dispatch-mode": None,
    },
    "layout": {
        "show": None,
        "entities": {"list": None, "add": None, "edit": None, "remove": None},
        "groups": {"list": None, "add": None, "remove": None},
        "membership": {"set": None, "unset": None},
    },
    "stats": {
        "health": None,
        "metrics": None,
        "agents": None,
        "dashboard": None,
        "leaderboard": None,
        "observability": None,
        "search": None,
    },
    "agents": {"list": None, "status": None, "setup": None, "login": None, "probe": None},
}

HELP_TEXT = """\
Cada comando tiene forma larga y forma corta (equivalentes); Tab autocompleta
ambas.

  <texto libre>                              clasifica Y delega (muestra el log del proceso)
  /activate                                  arranca o comprueba el harness
  /classify <texto>                          solo clasifica, sin delegar (vista previa)
  /assign <task_id> --to <agente>            fuerza la delegación a un agente concreto

  /tasks list|show|decisions|approve|search    == /task_list /task_show ...
  /config show|get|set|set-provider-pref|...   == /config_show /config_get ...
  /layout show|entities ...|groups ...|...     == /layout_show /layout_entity_list ...
  /stats health|metrics|agents|dashboard|...   == /stats_health /stats_agents ...
  /agents list|status|setup|login|probe        == /agent_list /agent_status ...

  /json    alterna salida JSON cruda
  /help    esta ayuda
  /clear   limpia la pantalla   (también funciona sin "/": clear)
  /exit    salir                (también funciona sin "/": exit)
"""


class ReplExit(Exception):
    pass


def _completion_tree() -> dict:
    tree: dict = {f"/{name}": None for name in _TOP_LEVEL}
    for domain, sub in _DOMAINS.items():
        tree[f"/{domain}"] = sub
    for short in SHORT_COMMANDS:
        tree[f"/{short}"] = None
    return tree


def _run_typer(args: list[str], client: KarajanClient, json_mode: bool) -> None:
    # Local import: karajan_cli.main imports this module to wire the bare
    # `karajan` invocation, so importing it at module scope would cycle.
    from karajan_cli.main import app

    call_args = ["--url", client.base_url]
    if client.token:
        call_args += ["--token", client.token]
    if json_mode:
        call_args.append("--json")
    call_args += args
    try:
        app(args=call_args, prog_name="karajan", standalone_mode=False)
    except SystemExit:
        pass
    except KarajanApiError as exc:
        output.console.print(f"[red]ERROR:[/red] {exc}")
    except Exception as exc:  # noqa: BLE001 - a bad command must never kill the REPL
        output.console.print(f"[red]ERROR:[/red] {exc}")


def _classify(prompt_text: str, client: KarajanClient, json_mode: bool) -> None:
    if not prompt_text:
        output.console.print("[yellow]Escribe un prompt después de /classify.[/yellow]")
        return
    try:
        record = client.classify(prompt_text)
    except KarajanApiError as exc:
        output.console.print(f"[red]ERROR:[/red] {exc}")
        return
    if json_mode:
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


def _run_pipeline(prompt_text: str, client: KarajanClient, json_mode: bool) -> None:
    """Classify AND delegate a prompt, printing each phase as it happens —
    the "process log" for free-text input in the REPL. Polls when the task
    lands in the async queue (`dispatch_mode=queue`); otherwise the harness
    resolves everything in one blocking call and the log/result print right
    after it returns.
    """
    prompt_text = prompt_text.strip()
    if not prompt_text:
        output.console.print("[yellow]Escribe un prompt.[/yellow]")
        return

    output.console.print("[dim]· clasificando...[/dim]")
    try:
        record = client.classify(prompt_text)
    except KarajanApiError as exc:
        output.console.print(f"[red]ERROR:[/red] {exc}")
        return

    task_id = record["task_id"]
    c = record["classification"]
    output.console.print(
        f"[dim]· clasificado[/dim] task_id={task_id} nivel={c['complexity_level']} "
        f"score={c['complexity_score']} modelo={c['recommended_model']}"
    )

    if c.get("requires_human_review"):
        output.console.print(
            f"[yellow]Requiere revisión humana antes de delegar.[/yellow] Aprueba con "
            f"[bold]/task_approve {task_id}[/bold] y luego [bold]/assign {task_id} --to <agente>[/bold]."
        )
        return

    output.console.print("[dim]· delegando...[/dim]")
    try:
        result = client.delegate(task_id)
    except KarajanApiError as exc:
        output.console.print(f"[red]ERROR:[/red] {exc}")
        return

    if result.get("status") == "queued":
        output.console.print("[dim]· en cola, esperando un agente libre...[/dim]")
        for attempt in range(_QUEUE_POLL_MAX_ATTEMPTS):
            time.sleep(_QUEUE_POLL_INTERVAL_S)
            try:
                result = client.get_task(task_id)
            except KarajanApiError as exc:
                output.console.print(f"[red]ERROR:[/red] {exc}")
                return
            if result.get("status") in ("completed", "failed"):
                break
            if attempt and attempt % 4 == 0:
                waited = int(attempt * _QUEUE_POLL_INTERVAL_S)
                output.console.print(f"[dim]  ... sigue en cola ({waited}s)[/dim]")
        else:
            waited = int(_QUEUE_POLL_MAX_ATTEMPTS * _QUEUE_POLL_INTERVAL_S)
            output.console.print(f"[yellow]Sigue en cola tras {waited}s.[/yellow] task_id={task_id}")
            return

    try:
        decisions = client.get_decisions(task_id)
    except KarajanApiError:
        decisions = []
    output.console.print("[bold]Log del proceso:[/bold]")
    output.print_timeline(decisions)

    if json_mode:
        output.print_json(result)
        return

    executions = (result.get("delegation") or {}).get("executions") or []
    if not executions:
        output.console.print("[yellow]Sin ejecuciones registradas.[/yellow]")
        return
    output.print_table(
        [
            {
                "subtask": e.get("subtask_id"),
                "backend": e.get("backend"),
                "modelo": e.get("model_used"),
                "estado": e.get("status"),
                "latencia_ms": e.get("latency_ms"),
            }
            for e in executions
        ],
        title="Resultado",
    )
    for execution in executions:
        if execution.get("output"):
            output.console.print(
                Panel(execution["output"], title=execution.get("subtask_id", ""), border_style="dim")
            )


def dispatch(line: str, client: KarajanClient, json_mode: bool) -> bool:
    """Handle one REPL line. Returns the (possibly toggled) json_mode flag.

    Raises `ReplExit` on /exit. Pulled out of `run()` so it can be unit
    tested without a real interactive terminal.
    """
    line = line.strip()
    if not line:
        return json_mode

    if not line.startswith("/"):
        if line.lower() in _BARE_COMMANDS:
            if line.lower() == "exit":
                raise ReplExit
            output.console.clear()
            return json_mode
        _run_pipeline(line, client, json_mode)
        return json_mode

    head, _, rest = line[1:].partition(" ")
    head = head.strip()
    if not head:
        return json_mode

    if head == "exit":
        raise ReplExit
    if head == "clear":
        output.console.clear()
        return json_mode
    if head == "help":
        output.console.print(HELP_TEXT)
        return json_mode
    if head == "json":
        json_mode = not json_mode
        output.console.print(f"Salida JSON: {'activada' if json_mode else 'desactivada'}")
        return json_mode
    if head == "classify":
        _classify(rest.strip(), client, json_mode)
        return json_mode

    try:
        extra = shlex.split(rest) if rest.strip() else []
    except ValueError as exc:  # unbalanced quotes
        output.console.print(f"[red]ERROR:[/red] {exc}")
        return json_mode

    # Short form (/task_show ...) expands to its long-form path; anything
    # else (/activate, /assign, /tasks, /config, /layout, /stats, /agents)
    # is already the long form and is used as-is.
    args = list(SHORT_COMMANDS.get(head, [head])) + extra
    _run_typer(args, client, json_mode)
    return json_mode


def _build_session() -> PromptSession | None:
    """Build the full-featured prompt_toolkit session (history + autocomplete).

    Returns None if no real interactive console is available — piped/redirected
    stdin/stdout (scripts, some CI/agent shells), or Windows terminals that
    don't expose a console screen buffer (e.g. plain MSYS2/Git-Bash without
    winpty) all raise here instead of degrading on their own.
    """
    if not sys.stdin.isatty():
        return None
    try:
        HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
        completer = FuzzyCompleter(NestedCompleter.from_nested_dict(_completion_tree()))
        return PromptSession(
            history=FileHistory(str(HISTORY_FILE)),
            completer=completer,
            complete_while_typing=True,
        )
    except Exception:
        return None


def run(client: KarajanClient, json_mode: bool = False) -> None:
    is_up = client.is_running()
    health = client.health() if is_up else None
    layout = config = providers = None
    if is_up:
        try:
            layout = client.get_routing_layout()
            config = client.get_config()
            providers = client.list_providers()
        except KarajanApiError:
            pass  # banner degrades to the fields it did get
    output.console.print(banner.render(client.base_url, health, layout, config, providers))

    session = _build_session()
    if session is None:
        output.console.print(
            "[yellow](sin autocompletado: no hay una terminal interactiva real)[/yellow]"
        )

    while True:
        try:
            line = session.prompt("karajan> ") if session is not None else input("karajan> ")
        except (EOFError, KeyboardInterrupt):
            break
        try:
            json_mode = dispatch(line, client, json_mode)
        except ReplExit:
            break

    output.console.print("Hasta luego.")
