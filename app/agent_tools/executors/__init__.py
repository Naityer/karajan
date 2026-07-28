"""Dispatch: parsed call → validated params → executor → `ToolResult`.

The single boundary where exceptions stop. Everything below may raise
`ToolDenied` (or, in the worst case, anything at all); nothing above ever sees
an exception, because a loop that crashes on a bad tool call is strictly worse
for the operator than one that hands the model an error it can read.
"""

from __future__ import annotations

import time
from typing import Any, Callable

from app.agent_tools import catalog
from app.agent_tools.budget import RunBudget
from app.agent_tools.executors import control, fs, search, shell
from app.agent_tools.spec import ToolDenied, ToolResult
from app.agent_tools.workspace import Workspace

_EXECUTORS: dict[str, Callable[..., ToolResult]] = {
    "list_dir": fs.list_dir,
    "read_file": fs.read_file,
    "write_file": fs.write_file,
    "edit_file": fs.edit_file,
    "search": search.search,
    "find_files": search.find_files,
    "run_command": shell.run_command,
    "note": control.note,
    "finish": control.finish,
    "ask_human": control.ask_human,
    "propose_context": control.propose_context,
}


def dispatch(
    name: str,
    raw_params: dict[str, Any],
    workspace: Workspace,
    *,
    profile: str = "readonly",
    budget: RunBudget | None = None,
) -> ToolResult:
    """Execute one tool call. Always returns; never raises."""
    started = time.perf_counter()

    spec = catalog.get_tool(name)
    if spec is None:
        available = ", ".join(tool.name for tool in catalog.tools_for_profile(profile))
        return ToolResult.failure(
            "unknown", "bad_params",
            f"la herramienta '{name}' no existe. Disponibles: {available}",
        )

    granted = {tool.name for tool in catalog.tools_for_profile(profile)}
    if spec.name not in granted:
        return ToolResult.failure(
            spec.name, "denied",
            f"'{spec.name}' no esta permitida en el perfil '{profile}'. Disponibles: {', '.join(sorted(granted))}",
        )

    if budget is not None:
        refusal = budget.refuses(spec.name, bytes_out=len(str(raw_params.get("content", ""))))
        if refusal:
            return ToolResult.failure(spec.name, "denied", refusal)

    executor = _EXECUTORS.get(spec.name)
    if executor is None:  # pragma: no cover - catalog and dispatch drift guard
        return ToolResult.failure(spec.name, "internal", f"'{spec.name}' no tiene ejecutor asociado")

    try:
        from app.agent_tools.spec import coerce_params

        params = coerce_params(spec, raw_params)
        result = executor(workspace, **params)
    except ToolDenied as exc:
        result = ToolResult.failure(spec.name, exc.code, str(exc))
    except Exception as exc:  # noqa: BLE001 - a tool bug must not kill the session
        result = ToolResult.failure(spec.name, "internal", f"{type(exc).__name__}: {exc}")

    if not result.duration_ms:
        result.duration_ms = int((time.perf_counter() - started) * 1000)
    if len(result.observation) > spec.max_output_chars:
        result.observation = (
            result.observation[: spec.max_output_chars] + f"\n[truncado a {spec.max_output_chars} caracteres]"
        )

    if budget is not None:
        budget.record_call(
            spec.name, bytes_read=result.bytes_read, bytes_written=result.bytes_written
        )
    return result


def is_terminal(name: str) -> bool:
    spec = catalog.get_tool(name)
    return bool(spec and spec.terminal)
