"""Static analysis engine (Fase B) — repo walking + per-language extraction.

Turns a registered repository into `graph_nodes`/`graph_edges` rows without any
LLM involvement: pure `ast` for Python and tree-sitter (regex fallback) for
TS/JS. Node ids are deterministic hashes so re-scans reuse the same ids where a
symbol is unchanged, keeping the graph stable for the frontend.
"""

from __future__ import annotations

import hashlib


def make_node_id(
    repo_id: str,
    rel_path: str,
    kind: str,
    qualified_name: str,
    discriminator: object = "",
) -> str:
    """Deterministic node id from its identity (repo, file, kind, qualified name).

    Deterministic so a rescan that finds the same symbol produces the same id —
    edges pointing at it survive across scans. `\\x00` separators keep component
    boundaries unambiguous.

    `discriminator` disambiguates same-named symbols that legitimately coexist in
    one file — e.g. a `@property`/`@x.setter` pair, `@overload` stubs, or a
    conditionally-redefined function — which share (kind, qualified_name) and
    would otherwise collide on the `graph_nodes.id` primary key. Callers pass the
    symbol's start line, which is stable across rescans as long as code above it
    is unchanged. File/dir/repo nodes are unique per path and pass no
    discriminator, keeping their ids stable regardless.
    """
    raw = f"{repo_id}\x00{rel_path}\x00{kind}\x00{qualified_name}\x00{discriminator}"
    return "n_" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]


def make_edge_id(repo_id: str, src_node_id: str, edge_type: str, discriminator: str) -> str:
    """Deterministic edge id; `discriminator` disambiguates parallel edges."""
    raw = f"{repo_id}\x00{src_node_id}\x00{edge_type}\x00{discriminator}"
    return "e_" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]


def file_node_id(repo_id: str, rel_path: str) -> str:
    """Id shared by a file's graph_files row and its kind='file' node."""
    return make_node_id(repo_id, rel_path, "file", rel_path)
