"""Documentation handoff to an external web chat (ChatGPT / Claude).

Manual-first by design, and that is not a limitation being apologised for: the
pack is built locally, you paste it into whichever chat you already pay for, and
you paste the answer back. No credentials leave the machine, nothing depends on
a third-party UI staying the same, and the expensive model is used where it is
actually cheapest for the operator.

    build_pack   selected files -> a Markdown pack with a token budget
    save_pack    persist it and register it in the `artifacts` ledger
    save_result  ingest the answer, ready to publish into Atlas
"""

from __future__ import annotations

from app.handoff.pack import ContextPack, PackedFile, build as build_pack, render
from app.handoff.store import (
    KIND_PACK,
    KIND_RESULT,
    list_packs,
    load_pack,
    read_markdown,
    read_result,
    save_pack,
    save_result,
)

__all__ = [
    "ContextPack",
    "KIND_PACK",
    "KIND_RESULT",
    "PackedFile",
    "build_pack",
    "list_packs",
    "load_pack",
    "read_markdown",
    "read_result",
    "render",
    "save_pack",
    "save_result",
]
