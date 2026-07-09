"""MCP server that bridges Claude Code to the Karajan AI routing harness.

Exposes Karajan's classify + delegate pipeline as MCP tools so Claude Code
can route sub-tasks to the right model automatically, through a pyramidal
hierarchy that can grow beyond these tiers:
  N1/N2 simple/moderate  → L2 local (Qwen 2.5 7B)
  N3 intermediate        → L1 open-source (Kimi K2.7 Code) → escalates to L2 (DeepSeek/Ornith/Mistral) if busy
  N4 complex             → L1 open-source (GLM-5.2 / Kimi K2.7 Code) → escalates to L2 → root backup (Codex/ChatGPT)
  N5 critical             → root (Claude Opus), requires human review

When Karajan's `dispatch_mode` is `"queue"`, delegation is asynchronous and
availability-driven (an agent only takes a task once it's actually free,
regardless of arrival order) — `karajan_run` polls until the task finishes.

Every tool here is a thin wrapper over `karajan_cli.client.KarajanClient` — the
same HTTP layer the `karajan` terminal CLI uses — so an MCP-connected agent
(Claude Code) and a plain shell/agent invoking `karajan ...` get identical
behavior against the same running server.

Usage: registered as an MCP server in ~/.claude/settings.json.
Requires Karajan server to be running: `karajan activate --start`, or
manually `python -m uvicorn app.main:app --reload`.
"""

from __future__ import annotations

import os
import re
import sys

# Force UTF-8 I/O so the → glyph and non-ASCII model output don't crash the
# MCP process when Windows defaults stdout/stderr to cp1252.
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
if sys.stderr.encoding and sys.stderr.encoding.lower() != "utf-8":
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]

import time

from mcp.server.fastmcp import FastMCP

from karajan_cli.client import DEFAULT_URL, KarajanApiError, KarajanClient

KARAJAN_URL = os.environ.get("KARAJAN_URL", DEFAULT_URL)
TIMEOUT_DELEGATE = 180
QUEUE_POLL_INTERVAL_S = 2
QUEUE_POLL_MAX_ATTEMPTS = TIMEOUT_DELEGATE // QUEUE_POLL_INTERVAL_S

mcp = FastMCP("karajan")
client = KarajanClient(base_url=KARAJAN_URL, timeout=TIMEOUT_DELEGATE)


_ANSI_RE = re.compile(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def _strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


def _not_running_message() -> str:
    return (
        "ERROR: El servidor Karajan no está activo.\n"
        "Inícialo con:\n"
        "  karajan activate --start\n"
        "o manualmente:\n"
        "  cd C:\\Users\\tiand\\Desktop\\Workspace\\karajan\n"
        "  .venv\\Scripts\\uvicorn app.main:app --reload"
    )


def _format_health(h: dict) -> str:
    return (
        f"status:   {h.get('status')}\n"
        f"backend:  {h.get('backend')}\n"
        f"profile:  {h.get('profile')}\n"
        f"db_ok:    {h.get('db_ok')}\n"
        f"tasks:    {h.get('total_tasks')}\n"
        f"version:  {h.get('version')}"
    )


@mcp.tool()
def karajan_run(prompt: str) -> str:
    """Classify a task by complexity and delegate it to the optimal AI model via Karajan.

    The routing hierarchy (root → L1 → L2, may grow more levels over time):
    - N1/N2 (simple/moderate)  → L2 local (Qwen 2.5 7B)
    - N3 (intermediate)        → L1 open-source (Kimi K2.7 Code), escalates to L2 if busy
    - N4 (complex)             → L1 open-source (GLM-5.2 / Kimi K2.7 Code), escalates to L2, then root backup
    - N5 (critical)            → root (Claude Opus), requires human review

    Args:
        prompt: The task or instruction to route and execute.
    """
    if not client.is_running():
        return _not_running_message()

    try:
        task = client.classify(prompt)
    except KarajanApiError as exc:
        return f"ERROR clasificando tarea: {exc}"

    task_id = task["task_id"]
    classification = task.get("classification", {})
    level = classification.get("complexity_level", "?")
    score = classification.get("complexity_score", "?")
    assigned_model = classification.get("recommended_model", "?")
    requires_review = classification.get("requires_human_review", False)

    if requires_review:
        return (
            f"[Karajan] Tarea clasificada como N5/crítica (score={score}).\n"
            f"Requiere revisión humana antes de delegar a {assigned_model}.\n"
            f"task_id={task_id}\n"
            "Aprueba en el dashboard de Karajan o via:\n"
            f"  karajan tasks approve {task_id}"
        )

    try:
        result = client.delegate(task_id)
    except KarajanApiError as exc:
        return f"ERROR delegando tarea (task_id={task_id}): {exc}"

    # Under dispatch_mode="queue" the task is enqueued and dispatched
    # asynchronously (availability-driven, not immediate) — poll until done.
    if result.get("status") == "queued":
        for _ in range(QUEUE_POLL_MAX_ATTEMPTS):
            time.sleep(QUEUE_POLL_INTERVAL_S)
            try:
                result = client.get_task(task_id)
            except KarajanApiError as exc:
                return f"ERROR consultando tarea en cola (task_id={task_id}): {exc}"
            if result.get("status") in ("completed", "failed"):
                break
        else:
            return (
                f"[Karajan] La tarea sigue en cola tras {TIMEOUT_DELEGATE}s "
                f"(ningún agente elegible quedó libre).\ntask_id={task_id}"
            )
    delegation = result.get("delegation") or {}
    executions = delegation.get("executions") or []
    latency = delegation.get("total_latency_ms", 0)

    errors = [e["error"] for e in executions if e.get("error")]
    if errors and not any(e.get("output") for e in executions):
        model_used = executions[0].get("model_used", assigned_model) if executions else assigned_model
        return (
            f"[Karajan → {model_used} | {level} | score={score}]\n"
            f"ERROR: {errors[0]}\ntask_id={task_id}"
        )

    model_used = executions[0].get("model_used", assigned_model) if executions else assigned_model
    outputs = [_strip_ansi(e.get("output", "")).strip() for e in executions if e.get("output")]
    combined = outputs[0] if len(outputs) == 1 else "\n\n---\n\n".join(outputs)

    return (
        f"[Karajan → {model_used} | {level} | score={score} | {latency}ms]\n\n"
        f"{combined}"
    )


@mcp.tool()
def karajan_classify(prompt: str) -> str:
    """Classify a task's complexity level without executing it.

    Returns the complexity level (N1-N5), score, assigned model, and whether
    human review is required. Useful to preview routing before delegating.

    Args:
        prompt: The task or instruction to classify.
    """
    if not client.is_running():
        return "ERROR: Karajan no está activo. Ver karajan_run para instrucciones."

    try:
        task = client.classify(prompt)
    except KarajanApiError as exc:
        return f"ERROR: {exc}"

    c = task.get("classification", {})
    lines = [
        f"task_id:         {task['task_id']}",
        f"level:           {c.get('complexity_level', '?')}",
        f"complexity_score:{c.get('complexity_score', '?')}",
        f"assigned_model:  {c.get('recommended_model', '?')}",
        f"human_review:    {c.get('requires_human_review', False)}",
        f"classified_by:   {c.get('classified_by', '?')}",
    ]
    criteria = c.get("criteria", {})
    if criteria:
        lines.append("criteria:")
        for k, v in criteria.items():
            lines.append(f"  {k}: {v}")
    return "\n".join(lines)


@mcp.tool()
def karajan_health() -> str:
    """Check if the Karajan server is running and which backend/profile is active."""
    try:
        return _format_health(client.health())
    except KarajanApiError as exc:
        return f"Karajan no disponible en {KARAJAN_URL}: {exc}"


@mcp.tool()
def karajan_providers() -> str:
    """List all AI providers and their credential/readiness status in Karajan."""
    try:
        providers = client.list_providers()
    except KarajanApiError as exc:
        return f"ERROR: {exc}"

    lines = []
    for p in providers:
        ready = "OK" if p.get("ready") else "FALTA"
        lines.append(f"[{ready}] {p['provider']:20s}  {p.get('detail', '')}")
    return "\n".join(lines) if lines else "Sin proveedores"


# --- Parity with the `karajan` CLI's mutating commands -----------------------


@mcp.tool()
def karajan_assign(task_id: str, provider_or_entity: str, as_entity: bool = False) -> str:
    """Force-delegate an already-classified task to one named agent/provider,
    bypassing the automatic tier-based routing (the same bypass `karajan assign`
    uses from the terminal).

    Args:
        task_id: id of a task already classified via karajan_classify/karajan_run.
        provider_or_entity: catalog provider name (e.g. "claude-cli"), or a
            routing-hierarchy entity id when as_entity=True.
        as_entity: interpret provider_or_entity as a RoutingEntity id from the
            Decisión hierarchy instead of a catalog provider name.
    """
    try:
        if as_entity:
            result = client.delegate(task_id, force_entity_id=provider_or_entity)
        else:
            result = client.delegate(task_id, force_provider=provider_or_entity)
    except KarajanApiError as exc:
        return f"ERROR: {exc}"

    executions = (result.get("delegation") or {}).get("executions") or []
    execution = executions[0] if executions else {}
    return (
        f"[Karajan → {provider_or_entity} forzado]\n"
        f"task_id={result.get('task_id')} status={result.get('status')}\n"
        f"backend={execution.get('backend')} modelo={execution.get('model_used')} "
        f"latencia_ms={execution.get('latency_ms')}"
    )


@mcp.tool()
def karajan_config_get(dotted_path: str | None = None) -> str:
    """Read the active KarajanConfig, or one field by dotted path (e.g. "orchestration.dispatch_mode")."""
    try:
        config = client.get_config()
    except KarajanApiError as exc:
        return f"ERROR: {exc}"

    if not dotted_path:
        return "\n".join(f"{k}: {v}" for k, v in config.items())

    node = config
    try:
        for part in dotted_path.split("."):
            node = node[part]
    except (KeyError, TypeError):
        return f"ERROR: ruta '{dotted_path}' no encontrada en la config"
    return f"{dotted_path} = {node}"


@mcp.tool()
def karajan_config_set(dotted_path: str, value: str) -> str:
    """Write one KarajanConfig field by dotted path (GET, patch locally, PUT)."""
    try:
        config = client.get_config()
    except KarajanApiError as exc:
        return f"ERROR: {exc}"

    parts = dotted_path.split(".")
    node = config
    try:
        for part in parts[:-1]:
            node = node[part]
    except (KeyError, TypeError):
        return f"ERROR: ruta '{dotted_path}' no encontrada en la config"

    coerced: object = value
    for cast in (int, float):
        try:
            coerced = cast(value)
            break
        except ValueError:
            continue
    else:
        if value.lower() in ("true", "false"):
            coerced = value.lower() == "true"
    node[parts[-1]] = coerced

    try:
        client.put_config(config)
    except KarajanApiError as exc:
        return f"ERROR guardando config: {exc}"
    return f"{dotted_path} = {coerced}"


@mcp.tool()
def karajan_layout_show() -> str:
    """Show the Decisión routing hierarchy (entities + groups)."""
    try:
        layout = client.get_routing_layout()
    except KarajanApiError as exc:
        return f"ERROR: {exc}"

    lines = [f"entidades: {len(layout.get('entities', []))}  grupos: {len(layout.get('groups', []))}"]
    for entity in layout.get("entities", []):
        lines.append(
            f"  {entity['id']:24s} rol={entity['role']:10s} provider={entity.get('provider') or '-':16s} "
            f"tier={entity.get('tier')} levels={','.join(entity.get('levels', []))}"
        )
    return "\n".join(lines)


@mcp.tool()
def karajan_layout_set_provider(entity_id: str, provider: str) -> str:
    """Change one routing entity's provider (narrowly-scoped layout mutation;
    full layout editing stays CLI/dashboard-only to limit the blast radius of
    an LLM-invoked tool call).
    """
    try:
        layout = client.get_routing_layout()
    except KarajanApiError as exc:
        return f"ERROR: {exc}"

    entity = next((e for e in layout.get("entities", []) if e["id"] == entity_id), None)
    if entity is None:
        return f"ERROR: no existe la entidad '{entity_id}'"
    entity["provider"] = provider

    try:
        client.put_routing_layout(layout)
    except KarajanApiError as exc:
        return f"ERROR guardando layout: {exc}"
    return f"'{entity_id}'.provider = {provider}"


@mcp.tool()
def karajan_provider_activate(name: str, slot: str = "probe_command") -> str:
    """Run a provider's catalog-defined login or probe command.

    Args:
        name: catalog provider name (see karajan_providers).
        slot: "login_command" or "probe_command".
    """
    if slot not in ("login_command", "probe_command"):
        return "ERROR: slot debe ser 'login_command' o 'probe_command'"
    try:
        result = client.provider_run(name, slot)
    except KarajanApiError as exc:
        return f"ERROR: {exc}"

    status = "OK" if result.get("ok") else "FALLO"
    lines = [f"[{status}] {result.get('command')}"]
    if result.get("stdout"):
        lines.append(_strip_ansi(result["stdout"]))
    if result.get("stderr"):
        lines.append(_strip_ansi(result["stderr"]))
    return "\n".join(lines)


@mcp.tool()
def karajan_stats(kind: str = "dashboard", days: int = 30) -> str:
    """Return harness statistics.

    Args:
        kind: one of "dashboard" (full DuckDB analytics), "leaderboard"
            (provider ranking only), "health", "agents" (per-provider
            cost/latency/error aggregation).
        days: lookback window for "dashboard"/"leaderboard".
    """
    try:
        if kind == "health":
            return _format_health(client.health())
        if kind == "agents":
            data = client.agents_performance()
            rows = [
                f"{a.get('provider', '?'):20s} runs={a.get('total_runs', '?')} "
                f"cost_usd={a.get('total_cost_usd', '?')} error_rate={a.get('error_rate', '?')}"
                for a in data
            ]
            return "\n".join(rows) if rows else "Sin datos"

        data = client.dashboard(days=days)
        if not data.get("available", True):
            return f"Analítica no disponible: {data.get('reason')}"
        if kind == "leaderboard":
            rows = data.get("provider_leaderboard", [])
            return "\n".join(str(row) for row in rows) if rows else "Sin datos"
        return str(data)
    except KarajanApiError as exc:
        return f"ERROR: {exc}"


if __name__ == "__main__":
    mcp.run()
