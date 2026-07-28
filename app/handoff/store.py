"""Persistence for the documentation handoff.

Packs and their pasted-back results live in `artifacts` rather than in a new
table: they *are* artifacts of a task — files produced while working on it — and
reusing the ledger means they show up in `GET /tasks/{id}/artifacts` and in the
Monitor with no extra plumbing.

The body itself goes on disk under `data/handoff/`, because `artifacts` stores
a path and a hash, not a blob.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.handoff.pack import ContextPack, PackedFile

HANDOFF_DIR = Path("data/handoff")

KIND_PACK = "context_pack"
KIND_RESULT = "doc_result"


def _dir(base: Path | None = None) -> Path:
    target = Path(base or HANDOFF_DIR)
    target.mkdir(parents=True, exist_ok=True)
    return target


def save_pack(pack: ContextPack, store: Any | None = None, *, base: Path | None = None) -> Path:
    """Write the pack (markdown + metadata) and register it as an artifact."""
    directory = _dir(base)
    markdown_path = directory / f"{pack.id}.md"
    markdown_path.write_text(pack.markdown(), encoding="utf-8")

    meta = asdict(pack)
    # The rendered markdown is the artifact; keeping the bodies twice would
    # double the size of every pack on disk for no reader.
    meta["files"] = [
        {"path": item.path, "truncated": item.truncated, "skipped_reason": item.skipped_reason}
        for item in pack.files
    ]
    (directory / f"{pack.id}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    if store is not None:
        try:
            store.record_artifact(
                task_id=pack.task_id, run_id=None, kind=KIND_PACK,
                file_path=markdown_path.as_posix(), size_bytes=len(pack.markdown().encode("utf-8")),
                content_hash=None,
            )
        except Exception:  # noqa: BLE001 - the pack is still usable without the ledger row
            pass
    return markdown_path


def load_pack(pack_id: str, *, base: Path | None = None) -> ContextPack | None:
    directory = _dir(base)
    meta_path = directory / f"{pack_id}.json"
    markdown_path = directory / f"{pack_id}.md"
    if not meta_path.exists() or not markdown_path.exists():
        return None
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    pack = ContextPack(
        id=meta["id"], task_id=meta["task_id"], prompt=meta["prompt"],
        workspace_root=meta["workspace_root"], rationale=meta.get("rationale", ""),
        created_at=meta.get("created_at", ""), total_chars=meta.get("total_chars", 0),
    )
    pack.files = [
        PackedFile(item["path"], "", truncated=item.get("truncated", False),
                   skipped_reason=item.get("skipped_reason"))
        for item in meta.get("files", [])
    ]
    return pack


def read_markdown(pack_id: str, *, base: Path | None = None) -> str | None:
    path = _dir(base) / f"{pack_id}.md"
    return path.read_text(encoding="utf-8") if path.exists() else None


def save_result(
    pack_id: str, task_id: str, markdown: str, store: Any | None = None, *, base: Path | None = None
) -> Path:
    """Store what came back from the web chat, ready to publish to Atlas."""
    directory = _dir(base)
    path = directory / f"{pack_id}.result.md"
    path.write_text(markdown, encoding="utf-8")
    (directory / f"{pack_id}.result.json").write_text(
        json.dumps(
            {"pack_id": pack_id, "task_id": task_id, "received_at": datetime.now(timezone.utc).isoformat()},
            ensure_ascii=False, indent=2,
        ),
        encoding="utf-8",
    )
    if store is not None:
        try:
            store.record_artifact(
                task_id=task_id, run_id=None, kind=KIND_RESULT,
                file_path=path.as_posix(), size_bytes=len(markdown.encode("utf-8")), content_hash=None,
            )
        except Exception:  # noqa: BLE001
            pass
    return path


def read_result(pack_id: str, *, base: Path | None = None) -> str | None:
    path = _dir(base) / f"{pack_id}.result.md"
    return path.read_text(encoding="utf-8") if path.exists() else None


def list_packs(*, base: Path | None = None) -> list[dict]:
    """Newest first, with whether a result has already been pasted back.

    This is what Atlas polls to find documents ready to accept.
    """
    directory = _dir(base)
    items: list[dict] = []
    for meta_path in directory.glob("*.json"):
        if meta_path.name.endswith(".result.json"):
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        pack_id = meta.get("id", meta_path.stem)
        items.append(
            {
                "id": pack_id,
                "task_id": meta.get("task_id"),
                "prompt": meta.get("prompt", "")[:300],
                "created_at": meta.get("created_at", ""),
                "files": len([f for f in meta.get("files", []) if not f.get("skipped_reason")]),
                "total_chars": meta.get("total_chars", 0),
                "status": "ready" if (directory / f"{pack_id}.result.md").exists() else "pending",
            }
        )
    return sorted(items, key=lambda item: item["created_at"], reverse=True)
