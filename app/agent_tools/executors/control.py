"""Control tools: they steer the loop instead of touching the world.

`note` is the important one and the one that looks pointless. Without a legal
zero-cost action, a model that is unsure emits prose — and prose outside a tool
block is the largest single source of parse failures on small local models.
"""

from __future__ import annotations

import re

from app.agent_tools.spec import ToolResult
from app.agent_tools.workspace import Workspace

VALID_FINISH_STATUS = ("success", "failed")

# The spec asks for one path per line; models also produce them comma-separated,
# parenthesised, bulleted or backticked. Splitting on all of those costs nothing
# and is the difference between selecting one file and selecting the right two.
_PATH_SEPARATORS = re.compile(r"[\n,;()\[\]]+")
_PATH_NOISE = re.compile(r"^[-*\s\"'`]+|[\"'`\s.]+$")


def note(workspace: Workspace, text: str) -> ToolResult:
    body = (text or "").strip()
    if not body:
        return ToolResult.failure("note", "bad_params", "note necesita un texto")
    return ToolResult.success("note", "anotado", text=body[:2000])


def finish(workspace: Workspace, summary: str, status: str = "success") -> ToolResult:
    normalized = (status or "success").strip().lower()
    if normalized not in VALID_FINISH_STATUS:
        normalized = "success"
    body = (summary or "").strip() or "(sin resumen)"
    return ToolResult.success("finish", body, summary=body, status=normalized, terminal=True)


def ask_human(workspace: Workspace, question: str) -> ToolResult:
    body = (question or "").strip()
    if not body:
        return ToolResult.failure("ask_human", "bad_params", "ask_human necesita una pregunta")
    return ToolResult.success("ask_human", body, question=body, terminal=True, awaiting_approval=True)


def propose_context(workspace: Workspace, paths: str, rationale: str = "") -> ToolResult:
    """Terminal selection step of the documentation handoff.

    Paths are validated against the workspace here rather than downstream: a
    context pack referencing a file that does not exist is worse than one that
    is short, because it silently ships a hallucination to the web chat.
    """
    candidates: list[str] = []
    for chunk in _PATH_SEPARATORS.split(paths or ""):
        cleaned = _PATH_NOISE.sub("", chunk)
        if cleaned and cleaned not in candidates:
            candidates.append(cleaned)
    if not candidates:
        return ToolResult.failure("propose_context", "bad_params", "propose_context necesita al menos una ruta")

    accepted: list[str] = []
    missing: list[str] = []
    for candidate in candidates:
        try:
            resolved = workspace.resolve(candidate)
        except Exception:  # noqa: BLE001 - ToolDenied and anything else are both "not usable"
            missing.append(candidate)
            continue
        if resolved.is_file():
            accepted.append(workspace.relative(resolved))
        else:
            missing.append(candidate)

    if not accepted:
        return ToolResult.failure(
            "propose_context", "not_found",
            "ninguna de las rutas propuestas existe como archivo del workspace:\n"
            + "\n".join(f"  {item}" for item in missing),
        )

    observation = "contexto propuesto:\n" + "\n".join(f"  {item}" for item in accepted)
    if missing:
        observation += "\n(descartadas por no existir: " + ", ".join(missing) + ")"
    return ToolResult.success(
        "propose_context", observation,
        paths=accepted, missing=missing, rationale=(rationale or "").strip(), terminal=True,
    )
