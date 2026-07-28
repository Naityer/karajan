"""Text protocol for models without native tool-calling.

This parser is the highest-risk surface in the whole layer: everything else can
be unit-tested against fixed inputs, but this has to cope with whatever a 7b
model emits. So it is deliberately over-tolerant, and every tolerance below is
there because small local models actually do the thing it forgives.

**Why tags with raw bodies and not JSON.** A model cannot reliably escape
multi-line file content inside a JSON string — one stray quote or backslash and
the whole turn is lost, with nothing salvageable. With tags, the body is taken
verbatim between the delimiters, so a file containing quotes, backslashes and
newlines survives byte-for-byte. JSON is still accepted as a *secondary* form,
because several fine-tunes emit it natively.

    <karajan:tool name="edit_file">
    <param name="path">app/main.py</param>
    <param name="old_text">
    def foo():
        pass
    </param>
    </karajan:tool>
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from app.agent_tools import catalog
from app.agent_tools.spec import ToolSpec

# Accepts the canonical tag and the spellings models drift into.
_TOOL_OPEN = re.compile(
    r"<\s*(?:karajan[:_])?(?:tool|use_tool|tool_call)\s+name\s*=\s*[\"']?([\w.-]+)[\"']?\s*>",
    re.IGNORECASE,
)
_TOOL_CLOSE = re.compile(r"<\s*/\s*(?:karajan[:_])?(?:tool|use_tool|tool_call)\s*>", re.IGNORECASE)
_PARAM = re.compile(
    r"<\s*param\s+name\s*=\s*[\"']?([\w.-]+)[\"']?\s*>(.*?)<\s*/\s*param\s*>",
    re.IGNORECASE | re.DOTALL,
)
_FENCE = re.compile(r"^```[\w-]*\s*$|^```\s*$", re.MULTILINE)

# Names models reach for that mean something else in our catalog.
PARAM_ALIASES: dict[str, str] = {
    "file": "path",
    "filename": "path",
    "filepath": "path",
    "file_path": "path",
    "dir": "path",
    "directory": "path",
    "query": "pattern",
    "search": "pattern",
    "old": "old_text",
    "new": "new_text",
    "old_string": "old_text",
    "new_string": "new_text",
    "cmd": "command",
    "message": "text",
    "content_text": "content",
}

TOOL_ALIASES: dict[str, str] = {
    "list_files": "list_dir",
    "ls": "list_dir",
    "readfile": "read_file",
    "read": "read_file",
    "grep": "search",
    "writefile": "write_file",
    "write": "write_file",
    "replace_in_file": "edit_file",
    "edit": "edit_file",
    "execute_command": "run_command",
    "bash": "run_command",
    "shell": "run_command",
    "attempt_completion": "finish",
    "done": "finish",
}


@dataclass
class ParsedCall:
    tool: str
    params: dict[str, str]
    source: str = "text"  # "text" | "json" | "native"
    raw: str = ""


@dataclass
class ParseOutcome:
    call: ParsedCall | None = None
    error: str | None = None
    candidates: list[str] = field(default_factory=list)


def _strip_body(body: str) -> str:
    """Remove exactly one leading and one trailing newline, nothing else.

    Models write the value on its own line for readability. Stripping more would
    destroy the indentation of file content, which is precisely what `edit_file`
    needs to match byte-for-byte.
    """
    if body.startswith("\r\n"):
        body = body[2:]
    elif body.startswith("\n"):
        body = body[1:]
    if body.endswith("\r\n"):
        body = body[:-2]
    elif body.endswith("\n"):
        body = body[:-1]
    return body


def _normalize_tool(name: str) -> str:
    lowered = name.strip().lower()
    return TOOL_ALIASES.get(lowered, lowered)


def _normalize_params(spec: ToolSpec, raw: dict[str, str]) -> dict[str, str]:
    known = {param.name for param in spec.params}
    values: dict[str, str] = {}
    for key, value in raw.items():
        name = key.strip().lower()
        if name not in known:
            name = PARAM_ALIASES.get(name, name)
        values[name] = value
    return values


def parse(text: str, allowed: list[ToolSpec]) -> ParseOutcome:
    """Extract a tool call from a model turn.

    **Last block wins.** Small models routinely restate the example from the
    system prompt before emitting their real call; taking the first match would
    execute the example over and over.
    """
    if not text or not text.strip():
        return ParseOutcome(error="la respuesta esta vacia")

    cleaned = _FENCE.sub("", text)
    matches = list(_TOOL_OPEN.finditer(cleaned))
    if matches:
        return _parse_tagged(cleaned, matches[-1], allowed)

    json_call = _parse_json(cleaned, allowed)
    if json_call is not None:
        return ParseOutcome(call=json_call)

    return ParseOutcome(error="no he encontrado ningun bloque <karajan:tool ...> en la respuesta")


def _parse_tagged(text: str, match: re.Match[str], allowed: list[ToolSpec]) -> ParseOutcome:
    name = _normalize_tool(match.group(1))
    spec = catalog.get_tool(name)
    if spec is None or spec not in allowed:
        return ParseOutcome(
            error=f"la herramienta '{match.group(1)}' no existe o no esta permitida",
            candidates=[tool.name for tool in allowed],
        )

    body_start = match.end()
    close = _TOOL_CLOSE.search(text, body_start)
    # A missing closing tag is common when the model runs out of tokens; the
    # rest of the message is treated as the body rather than losing the turn.
    body = text[body_start : close.start()] if close else text[body_start:]

    raw_params = {key: _strip_body(value) for key, value in _PARAM.findall(body)}
    params = _normalize_params(spec, raw_params)
    return ParseOutcome(call=ParsedCall(tool=spec.name, params=params, source="text", raw=body.strip()))


def _parse_json(text: str, allowed: list[ToolSpec]) -> ParsedCall | None:
    """Secondary form: `{"tool": "...", "params": {...}}` anywhere in the text."""
    for candidate in _json_objects(text):
        try:
            data = json.loads(candidate)
        except (TypeError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        name = data.get("tool") or data.get("name") or data.get("tool_name")
        if not isinstance(name, str):
            continue
        spec = catalog.get_tool(_normalize_tool(name))
        if spec is None or spec not in allowed:
            continue
        raw = data.get("params") or data.get("arguments") or data.get("input") or {}
        if not isinstance(raw, dict):
            continue
        params = _normalize_params(spec, {key: str(value) for key, value in raw.items()})
        return ParsedCall(tool=spec.name, params=params, source="json", raw=candidate)
    return None


def _json_objects(text: str) -> list[str]:
    """Balanced top-level `{...}` spans, last first (same last-wins rule)."""
    spans: list[str] = []
    depth = 0
    start = -1
    for index, char in enumerate(text):
        if char == "{":
            if depth == 0:
                start = index
            depth += 1
        elif char == "}" and depth:
            depth -= 1
            if depth == 0 and start >= 0:
                spans.append(text[start : index + 1])
    return list(reversed(spans))


def corrective_observation(outcome: ParseOutcome, allowed: list[ToolSpec]) -> str:
    """What the model is told after a parse failure.

    Echoing the exact expected signature plus that tool's canonical example does
    more for reliability on small models than any amount of prompt wording — it
    turns "I got it wrong" into "here is the shape, copy it".
    """
    lines = [f"ERROR DE FORMATO: {outcome.error}."]
    lines.append("Responde con UN solo bloque, sin texto alrededor:")
    example = allowed[0].example if allowed else ""
    if outcome.candidates:
        lines.append("Herramientas disponibles: " + ", ".join(outcome.candidates))
    if example:
        lines.append(example)
    lines.append("Si no sabes que hacer todavia, usa la herramienta `note`.")
    return "\n".join(lines)
