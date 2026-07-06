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

Usage: registered as an MCP server in ~/.claude/settings.json.
Requires Karajan server to be running: python -m uvicorn app.main:app --reload
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

import httpx
from mcp.server.fastmcp import FastMCP

KARAJAN_URL = os.environ.get("KARAJAN_URL", "http://127.0.0.1:8000")
TIMEOUT_CLASSIFY = 30
TIMEOUT_DELEGATE = 180
QUEUE_POLL_INTERVAL_S = 2
QUEUE_POLL_MAX_ATTEMPTS = TIMEOUT_DELEGATE // QUEUE_POLL_INTERVAL_S

mcp = FastMCP("karajan")


_ANSI_RE = re.compile(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def _strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


def _is_running() -> bool:
    try:
        httpx.get(f"{KARAJAN_URL}/health", timeout=3).raise_for_status()
        return True
    except Exception:
        return False


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
    if not _is_running():
        return (
            "ERROR: El servidor Karajan no está activo.\n"
            "Inícialo con:\n"
            "  cd C:\\Users\\tiand\\Desktop\\karajan\n"
            "  .venv\\Scripts\\uvicorn app.main:app --reload"
        )

    # 1. Classify
    try:
        r = httpx.post(
            f"{KARAJAN_URL}/classify-task",
            json={"prompt": prompt},
            timeout=TIMEOUT_CLASSIFY,
        )
        r.raise_for_status()
    except httpx.HTTPError as exc:
        return f"ERROR clasificando tarea: {exc}"

    task = r.json()
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
            f"  POST {KARAJAN_URL}/tasks/{task_id}/approve-review"
        )

    # 2. Delegate
    try:
        r2 = httpx.post(
            f"{KARAJAN_URL}/delegate-task",
            json={"task_id": task_id},
            timeout=TIMEOUT_DELEGATE,
        )
        r2.raise_for_status()
    except httpx.HTTPError as exc:
        return f"ERROR delegando tarea (task_id={task_id}): {exc}"

    result = r2.json()

    # Under dispatch_mode="queue" the task is enqueued and dispatched
    # asynchronously (availability-driven, not immediate) — poll until done.
    if result.get("status") == "queued":
        for _ in range(QUEUE_POLL_MAX_ATTEMPTS):
            time.sleep(QUEUE_POLL_INTERVAL_S)
            try:
                r3 = httpx.get(f"{KARAJAN_URL}/tasks/{task_id}", timeout=10)
                r3.raise_for_status()
            except httpx.HTTPError as exc:
                return f"ERROR consultando tarea en cola (task_id={task_id}): {exc}"
            result = r3.json()
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
    if not _is_running():
        return "ERROR: Karajan no está activo. Ver karajan_run para instrucciones."

    try:
        r = httpx.post(
            f"{KARAJAN_URL}/classify-task",
            json={"prompt": prompt},
            timeout=TIMEOUT_CLASSIFY,
        )
        r.raise_for_status()
    except httpx.HTTPError as exc:
        return f"ERROR: {exc}"

    task = r.json()
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
        r = httpx.get(f"{KARAJAN_URL}/health", timeout=5)
        r.raise_for_status()
        h = r.json()
        return (
            f"status:   {h.get('status')}\n"
            f"backend:  {h.get('backend')}\n"
            f"profile:  {h.get('profile')}\n"
            f"db_ok:    {h.get('db_ok')}\n"
            f"tasks:    {h.get('total_tasks')}\n"
            f"version:  {h.get('version')}"
        )
    except Exception as exc:
        return f"Karajan no disponible en {KARAJAN_URL}: {exc}"


@mcp.tool()
def karajan_providers() -> str:
    """List all AI providers and their credential/readiness status in Karajan."""
    try:
        r = httpx.get(f"{KARAJAN_URL}/providers", timeout=10)
        r.raise_for_status()
    except Exception as exc:
        return f"ERROR: {exc}"

    providers = r.json()
    lines = []
    for p in providers:
        ready = "OK" if p.get("ready") else "FALTA"
        lines.append(f"[{ready}] {p['provider']:20s}  {p.get('detail', '')}")
    return "\n".join(lines) if lines else "Sin proveedores"


if __name__ == "__main__":
    mcp.run()
