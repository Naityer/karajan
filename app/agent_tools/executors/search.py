"""Discovery tools: search and find_files.

Both skip `NOISE_DIRS`. That is a token-budget decision as much as a usability
one: one `search` that walks `node_modules` can spend a local model's entire
context on irrelevant matches.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.agent_tools.spec import ToolResult
from app.agent_tools.workspace import Workspace

MAX_SCAN_BYTES = 400_000  # per file; larger files are skipped, not truncated


def _candidates(workspace: Workspace, glob: str, limit: int) -> tuple[list[Path], bool]:
    found: list[Path] = []
    truncated = False
    try:
        iterator = workspace.root.glob(glob)
    except (ValueError, IndexError):
        return [], False
    for path in iterator:
        if not path.is_file() or workspace.is_noise(path):
            continue
        if len(found) >= limit:
            truncated = True
            break
        found.append(path)
    return found, truncated


def find_files(workspace: Workspace, glob: str, max_results: int = 100) -> ToolResult:
    pattern = (glob or "").strip()
    if not pattern:
        return ToolResult.failure("find_files", "bad_params", "el patron glob no puede estar vacio")
    if pattern.startswith("/") or (len(pattern) > 1 and pattern[1] == ":"):
        return ToolResult.failure("find_files", "outside_workspace", "usa un patron relativo al workspace")

    limit = max(1, min(int(max_results), 500))
    paths, truncated = _candidates(workspace, pattern, limit)
    if not paths:
        return ToolResult.success(
            "find_files", f"sin coincidencias para '{pattern}'", glob=pattern, matches=0
        )

    body = "\n".join(sorted(workspace.relative(path) for path in paths))
    if truncated:
        body += f"\n[truncado en {limit} resultados; acota el patron]"
    return ToolResult.success("find_files", body, glob=pattern, matches=len(paths), truncated=truncated)


def search(
    workspace: Workspace,
    pattern: str,
    glob: str = "**/*",
    regex: bool = False,
    max_results: int = 50,
) -> ToolResult:
    needle = pattern or ""
    if not needle.strip():
        return ToolResult.failure("search", "bad_params", "el patron de busqueda no puede estar vacio")

    if regex:
        try:
            matcher = re.compile(needle)
        except re.error as exc:
            return ToolResult.failure("search", "bad_params", f"expresion regular invalida: {exc}")
    else:
        matcher = re.compile(re.escape(needle))

    limit = max(1, min(int(max_results), 500))
    paths, _ = _candidates(workspace, (glob or "**/*").strip() or "**/*", 5000)

    hits: list[str] = []
    scanned_bytes = 0
    truncated = False
    for path in sorted(paths):
        if len(hits) >= limit:
            truncated = True
            break
        try:
            if path.stat().st_size > MAX_SCAN_BYTES:
                continue
            data = path.read_bytes()
        except OSError:
            continue
        if b"\0" in data[:8000]:
            continue
        scanned_bytes += len(data)
        rel = workspace.relative(path)
        for index, line in enumerate(data.decode("utf-8", errors="replace").splitlines(), 1):
            if len(hits) >= limit:
                truncated = True
                break
            if matcher.search(line):
                trimmed = line.strip()
                if len(trimmed) > 240:
                    trimmed = trimmed[:240] + "…"
                hits.append(f"{rel}:{index}: {trimmed}")

    if not hits:
        return ToolResult(
            ok=True, tool="search",
            observation=f"sin coincidencias para {needle!r} en {glob}",
            data={"pattern": needle, "glob": glob, "matches": 0},
            bytes_read=scanned_bytes,
        )

    body = "\n".join(hits)
    if truncated:
        body += f"\n[truncado en {limit} coincidencias; acota el patron o el glob]"
    return ToolResult(
        ok=True, tool="search", observation=body,
        data={"pattern": needle, "glob": glob, "matches": len(hits), "truncated": truncated},
        bytes_read=scanned_bytes,
    )
