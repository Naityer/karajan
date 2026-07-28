"""File-system tools: list_dir, read_file, write_file, edit_file.

Every observation is written for a small model to act on: line numbers so it can
ask for the right window, explicit truncation markers so it knows there is more,
and — on a failed `edit_file` — the nearest lines from the file, because "not
found" alone leaves a 7b model with nowhere to go.
"""

from __future__ import annotations

import difflib
from pathlib import Path

from app.agent_tools.spec import ToolResult
from app.agent_tools.workspace import MAX_READ_BYTES, MAX_WRITE_BYTES, NOISE_DIRS, Workspace

MAX_DIR_ENTRIES = 200


def _read_text(path: Path) -> str | None:
    """Decode as UTF-8, or return None for anything that looks binary."""
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if b"\0" in data[:8000]:
        return None
    return data.decode("utf-8", errors="replace")


def list_dir(workspace: Workspace, path: str = ".", depth: int = 1) -> ToolResult:
    target = workspace.resolve(path)
    if not target.exists():
        return ToolResult.failure("list_dir", "not_found", f"no existe: {path}")
    if not target.is_dir():
        return ToolResult.failure("list_dir", "bad_params", f"'{path}' es un archivo, no un directorio")

    depth = max(1, min(int(depth), 3))
    entries: list[str] = []
    truncated = False

    def walk(current: Path, level: int, prefix: str) -> None:
        nonlocal truncated
        if truncated or level > depth:
            return
        try:
            children = sorted(current.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            return
        for child in children:
            if child.is_dir() and child.name in NOISE_DIRS:
                entries.append(f"{prefix}{child.name}/ (omitido)")
                continue
            if len(entries) >= MAX_DIR_ENTRIES:
                truncated = True
                return
            if child.is_dir():
                entries.append(f"{prefix}{child.name}/")
                walk(child, level + 1, prefix + "  ")
            else:
                entries.append(f"{prefix}{child.name}")

    walk(target, 1, "")
    body = "\n".join(entries) or "(directorio vacio)"
    if truncated:
        body += f"\n[truncado: mas de {MAX_DIR_ENTRIES} entradas; acota con path= o baja depth=]"
    return ToolResult.success(
        "list_dir", f"{workspace.relative(target)}/\n{body}",
        path=workspace.relative(target), entries=len(entries), truncated=truncated,
    )


def read_file(workspace: Workspace, path: str, start_line: int = 1, max_lines: int = 400) -> ToolResult:
    target = workspace.resolve(path)
    if not target.exists():
        return ToolResult.failure("read_file", "not_found", f"no existe: {path}")
    if target.is_dir():
        return ToolResult.failure("read_file", "bad_params", f"'{path}' es un directorio; usa list_dir")
    size = target.stat().st_size
    if size > MAX_READ_BYTES:
        return ToolResult.failure(
            "read_file", "too_large",
            f"'{path}' ocupa {size} bytes (limite {MAX_READ_BYTES}); no se puede leer entero",
        )

    text = _read_text(target)
    if text is None:
        return ToolResult.failure("read_file", "bad_params", f"'{path}' parece binario; no se puede leer como texto")

    lines = text.splitlines()
    start = max(1, int(start_line))
    count = max(1, min(int(max_lines), 2000))
    window = lines[start - 1 : start - 1 + count]
    if not window:
        return ToolResult.failure(
            "read_file", "bad_params",
            f"'{path}' tiene {len(lines)} lineas; start_line={start} esta fuera de rango",
        )

    numbered = "\n".join(f"{start + i:>5}| {line}" for i, line in enumerate(window))
    remaining = len(lines) - (start - 1 + len(window))
    if remaining > 0:
        numbered += f"\n[truncado: {remaining} lineas mas; sigue con start_line={start + len(window)}]"

    body = "\n".join(window)
    return ToolResult(
        ok=True, tool="read_file", observation=numbered,
        data={"path": workspace.relative(target), "lines": len(lines), "from": start, "to": start + len(window) - 1},
        bytes_read=len(body.encode("utf-8")),
    )


def write_file(workspace: Workspace, path: str, content: str, overwrite: bool = False) -> ToolResult:
    target = workspace.resolve(path, for_write=True)
    payload = content.encode("utf-8")
    if len(payload) > MAX_WRITE_BYTES:
        return ToolResult.failure(
            "write_file", "too_large",
            f"el contenido ocupa {len(payload)} bytes (limite {MAX_WRITE_BYTES} por archivo)",
        )
    existed = target.exists()
    if existed and not overwrite:
        return ToolResult.failure(
            "write_file", "conflict",
            f"'{path}' ya existe. Usa overwrite=true para sustituirlo, o edit_file para cambiar una parte.",
        )

    rel = workspace.relative(target)
    digest = workspace.digest(payload)
    if workspace.dry_run:
        preview = _diff(_read_text(target) or "" if existed else "", content, rel)
        return ToolResult(
            ok=True, tool="write_file",
            observation=f"[dry-run] se escribirian {len(payload)} bytes en {rel}\n{preview}",
            data={"path": rel, "dry_run": True, "bytes": len(payload)},
            bytes_written=len(payload), artifacts=((rel, digest),),
        )

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        workspace.confirm_after_write(target)
    except OSError as exc:
        return ToolResult.failure("write_file", "internal", f"no se pudo escribir '{path}': {exc}")

    return ToolResult(
        ok=True, tool="write_file",
        observation=f"escrito {rel} ({len(payload)} bytes, sha256 {digest[:12]}…)",
        data={"path": rel, "bytes": len(payload), "created": not existed, "sha256": digest},
        bytes_written=len(payload), artifacts=((rel, digest),),
    )


def edit_file(
    workspace: Workspace, path: str, old_text: str, new_text: str = "", count: int = 1
) -> ToolResult:
    target = workspace.resolve(path, for_write=True)
    if not target.exists():
        return ToolResult.failure("edit_file", "not_found", f"no existe: {path}")

    original = _read_text(target)
    if original is None:
        return ToolResult.failure("edit_file", "bad_params", f"'{path}' parece binario")
    if not old_text:
        return ToolResult.failure("edit_file", "bad_params", "old_text no puede estar vacio")

    occurrences = original.count(old_text)
    if occurrences == 0:
        return ToolResult.failure(
            "edit_file", "not_found",
            f"old_text no aparece en '{path}'. Lineas mas parecidas:\n{_nearest(original, old_text)}\n"
            "Copia el fragmento exacto tal cual sale de read_file, sin los numeros de linea.",
        )
    wanted = max(1, int(count))
    if occurrences > wanted:
        return ToolResult.failure(
            "edit_file", "ambiguous",
            f"old_text aparece {occurrences} veces en '{path}' y count={wanted}. "
            "Amplia old_text con mas contexto, o sube count.",
        )

    updated = original.replace(old_text, new_text, wanted)
    payload = updated.encode("utf-8")
    if len(payload) > MAX_WRITE_BYTES:
        return ToolResult.failure(
            "edit_file", "too_large", f"el resultado ocuparia {len(payload)} bytes (limite {MAX_WRITE_BYTES})"
        )

    rel = workspace.relative(target)
    diff = _diff(original, updated, rel)
    digest = workspace.digest(payload)
    if workspace.dry_run:
        return ToolResult(
            ok=True, tool="edit_file", observation=f"[dry-run] no se ha escrito nada:\n{diff}",
            data={"path": rel, "dry_run": True, "replacements": wanted},
            bytes_written=len(payload), artifacts=((rel, digest),),
        )

    try:
        target.write_bytes(payload)
        workspace.confirm_after_write(target)
    except OSError as exc:
        return ToolResult.failure("edit_file", "internal", f"no se pudo escribir '{path}': {exc}")

    return ToolResult(
        ok=True, tool="edit_file", observation=diff or f"{rel}: sin cambios visibles",
        data={"path": rel, "replacements": wanted, "sha256": digest},
        bytes_written=len(payload), artifacts=((rel, digest),),
    )


def _diff(before: str, after: str, label: str) -> str:
    lines = list(
        difflib.unified_diff(
            before.splitlines(), after.splitlines(),
            fromfile=f"a/{label}", tofile=f"b/{label}", lineterm="", n=2,
        )
    )
    if not lines:
        return ""
    if len(lines) > 120:
        lines = lines[:120] + [f"[truncado: {len(lines) - 120} lineas de diff mas]"]
    return "\n".join(lines)


def _nearest(haystack: str, needle: str, limit: int = 3) -> str:
    """Closest lines to the first line of `needle`, so a failed match is actionable."""
    probe = needle.strip().splitlines()[0] if needle.strip() else needle
    lines = haystack.splitlines()
    scored = sorted(
        ((difflib.SequenceMatcher(None, probe, line).ratio(), index, line) for index, line in enumerate(lines, 1)),
        reverse=True,
    )
    return "\n".join(f"{index:>5}| {line}" for _, index, line in scored[:limit]) or "(archivo vacio)"
