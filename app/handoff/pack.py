"""Context packs: what a local agent selected, packaged for an external chat.

The documentation flow the operator asked for:

    agente local explora → decide que archivos son relevantes
    → KARAJAN los empaqueta → se pega en ChatGPT/Claude
    → la respuesta vuelve lista para Atlas

Step one is not new code: it is the `doc` tool profile plus the terminal
`propose_context` tool, which is the first real use of the agent loop. This
module is step two.

Conventions borrowed from `audit_code/src/audit_code/context/builder.py`, which
already solved this problem for the build prompt: fixed sections, *reference
before copy*, and a hard refusal to include anything that looks like a secret.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from app.agent_tools.workspace import Workspace

# Roughly 4 chars per token (same estimate `app/execution.py` uses); 120k chars
# keeps a pack inside a normal web-chat context with room for the answer.
DEFAULT_MAX_CHARS = 120_000
MAX_FILE_CHARS = 30_000


@dataclass
class PackedFile:
    path: str
    content: str
    truncated: bool = False
    skipped_reason: str | None = None


@dataclass
class ContextPack:
    id: str
    task_id: str
    prompt: str
    workspace_root: str
    files: list[PackedFile] = field(default_factory=list)
    rationale: str = ""
    created_at: str = ""
    total_chars: int = 0

    def markdown(self) -> str:
        return render(self)


def _digest(*parts: str) -> str:
    return hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()[:16]


def _language(path: str) -> str:
    return {
        ".py": "python", ".ts": "typescript", ".tsx": "tsx", ".js": "javascript",
        ".jsx": "jsx", ".json": "json", ".md": "markdown", ".yml": "yaml",
        ".yaml": "yaml", ".sql": "sql", ".sh": "bash", ".html": "html", ".css": "css",
    }.get(Path(path).suffix.lower(), "")


def build(
    workspace: Workspace,
    task_id: str,
    prompt: str,
    paths: list[str],
    *,
    rationale: str = "",
    max_chars: int = DEFAULT_MAX_CHARS,
) -> ContextPack:
    """Read the selected files under the workspace guards and pack them.

    Paths are re-resolved through `Workspace.resolve` rather than trusted: the
    selection came from a model, and the secret-file and containment rules must
    hold on the way *out* of KARAJAN just as they did on the way in — a context
    pack is about to be pasted into a third-party chat.
    """
    pack = ContextPack(
        id=f"pack_{_digest(task_id, prompt, *paths)}",
        task_id=task_id,
        prompt=prompt,
        workspace_root=str(workspace.root),
        rationale=rationale.strip(),
        created_at=datetime.now(timezone.utc).isoformat(),
    )

    budget = max_chars
    for raw_path in paths:
        try:
            resolved = workspace.resolve(raw_path)
        except Exception as exc:  # noqa: BLE001 - ToolDenied or anything else
            pack.files.append(PackedFile(raw_path, "", skipped_reason=str(exc)))
            continue
        if not resolved.is_file():
            pack.files.append(PackedFile(raw_path, "", skipped_reason="no existe o no es un archivo"))
            continue

        rel = workspace.relative(resolved)
        try:
            data = resolved.read_bytes()
        except OSError as exc:
            pack.files.append(PackedFile(rel, "", skipped_reason=f"no se pudo leer: {exc}"))
            continue
        if b"\0" in data[:8000]:
            pack.files.append(PackedFile(rel, "", skipped_reason="binario"))
            continue

        text = data.decode("utf-8", errors="replace")
        truncated = False
        if len(text) > MAX_FILE_CHARS:
            text = text[:MAX_FILE_CHARS]
            truncated = True
        if budget <= 0:
            pack.files.append(PackedFile(rel, "", skipped_reason="presupuesto del paquete agotado"))
            continue
        if len(text) > budget:
            text = text[:budget]
            truncated = True

        budget -= len(text)
        pack.total_chars += len(text)
        pack.files.append(PackedFile(rel, text, truncated=truncated))

    return pack


def render(pack: ContextPack) -> str:
    """The Markdown that goes to the web chat.

    Structured so the answer comes back paste-ready: the instruction says what
    to produce and, explicitly, what *not* to wrap it in.
    """
    included = [item for item in pack.files if item.skipped_reason is None]
    skipped = [item for item in pack.files if item.skipped_reason is not None]

    lines = [
        "# Solicitud de documentacion",
        "",
        "## Que necesito",
        "",
        pack.prompt.strip(),
        "",
        "## Instrucciones de formato",
        "",
        "- Responde **solo** con el documento final en Markdown, listo para pegar.",
        "- Sin preambulo, sin explicar lo que vas a hacer y sin envolverlo en un bloque de codigo.",
        "- Usa encabezados `##`, y enlaza los archivos por su ruta relativa tal cual aparece abajo.",
        "- Si algo no se deduce del codigo incluido, dilo explicitamente en vez de inventarlo.",
        "",
        "## Contexto",
        "",
        f"- Repositorio: `{pack.workspace_root}`",
        f"- Archivos incluidos: {len(included)}",
    ]
    if pack.rationale:
        lines += ["", f"Por que estos archivos: {pack.rationale}"]
    if skipped:
        lines += ["", "Archivos descartados:"]
        lines += [f"- `{item.path}` — {item.skipped_reason}" for item in skipped]

    lines += ["", "## Archivos", ""]
    for item in included:
        fence = _language(item.path)
        lines += [f"### `{item.path}`", "", f"```{fence}", item.content.rstrip(), "```"]
        if item.truncated:
            lines.append("_(archivo truncado por tamano)_")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"
