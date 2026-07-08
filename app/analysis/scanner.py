"""Scan orchestrator: walk a repo, extract per file, resolve imports, persist.

The expensive work (reading + parsing a file) is skipped when a file's
`mtime_ns` and `size` match the cached `graph_files` row — that is the
incremental-rescan cache. Changed files are re-parsed and their graph rows
replaced atomically (delete-then-reinsert per file). The cheap directory
scaffold (repo/dir nodes + structural `contains` edges) is rebuilt in full on
every scan since it needs no file IO. Import specifiers are resolved to internal
file nodes in a second pass once the whole-repo module map is known; anything
external stays as `dst_unresolved`.
"""

from __future__ import annotations

import fnmatch
import hashlib
import os
import time
from collections.abc import Iterator
from pathlib import Path, PurePosixPath

from app.analysis import file_node_id, make_edge_id, make_node_id
from app.analysis import python_analyzer, ts_analyzer
from app.graph_store import GraphStore, safe_resolve, _utcnow_iso
from app.models import GraphEdge, GraphNode, RepoConfig, ScanSummary

DEFAULT_EXCLUDES: frozenset[str] = frozenset(
    {
        ".venv", "venv", ".git", "node_modules", "__pycache__", "dist", "build",
        ".next", ".turbo", ".pytest_cache", ".mypy_cache", ".ruff_cache",
        "site-packages", ".tmp", ".idea", ".vscode",
    }
)

_PY_EXTS = frozenset({".py"})
_TS_EXTS = frozenset({".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"})
_ANALYZABLE = _PY_EXTS | _TS_EXTS

# Skip pathological files (minified bundles, generated blobs) to keep scans fast.
_MAX_FILE_BYTES = 1_500_000


def _matches_glob(name: str, globs: list[str]) -> bool:
    return any(fnmatch.fnmatch(name, g) for g in globs)


def walk_repo(root: Path, exclude_globs: list[str]) -> Iterator[Path]:
    """Yield analyzable files under `root`, pruning excluded dirs in place.

    Pruning `dirnames[:]` stops `os.walk` from ever descending into `.venv`,
    `node_modules`, etc., which is what keeps a scan cheap on a real repo.
    """
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            d for d in dirnames
            if d not in DEFAULT_EXCLUDES and not _matches_glob(d, exclude_globs)
        ]
        for filename in filenames:
            if Path(filename).suffix.lower() not in _ANALYZABLE:
                continue
            if _matches_glob(filename, exclude_globs):
                continue
            full = Path(dirpath) / filename
            try:
                if full.stat().st_size > _MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            yield full


def _rel_posix(root: Path, abs_path: Path) -> str:
    return PurePosixPath(abs_path.relative_to(root).as_posix()).as_posix()


def _language_for(rel_path: str) -> str:
    return "python" if PurePosixPath(rel_path).suffix.lower() in _PY_EXTS else "typescript"


def scan_repo(repo: RepoConfig, store: GraphStore) -> ScanSummary:
    started = time.monotonic()
    summary = ScanSummary(repo_id=repo.id)
    root = Path(repo.root_path).resolve()

    if not root.exists() or not root.is_dir():
        summary.errors.append(f"root_path missing: {root}")
        store.update_scan_result(repo.id, "error", summary.model_dump_json())
        return summary

    # --- Pass 1: enumerate files + build resolution maps -------------------
    files: list[tuple[Path, str]] = []  # (abs_path, rel_path)
    rel_to_fid: dict[str, str] = {}
    py_module_map: dict[str, str] = {}
    for abs_path in walk_repo(root, repo.exclude_globs):
        rel = _rel_posix(root, abs_path)
        fid = file_node_id(repo.id, rel)
        files.append((abs_path, rel))
        rel_to_fid[rel] = fid
        if PurePosixPath(rel).suffix.lower() in _PY_EXTS:
            py_module_map[python_analyzer._module_dotted(rel)] = fid

    current_rel = {rel for _, rel in files}

    # --- Pass 2: per-file cache check + parse + write ----------------------
    for abs_path, rel in files:
        try:
            stat = abs_path.stat()
        except OSError as exc:
            summary.errors.append(f"stat {rel}: {exc}")
            continue

        cached = store.get_file_row(repo.id, rel)
        if cached and cached["mtime_ns"] == stat.st_mtime_ns and cached["size"] == stat.st_size:
            summary.files_skipped_unchanged += 1
            continue

        try:
            # safe_resolve guards against a rel_path escaping the repo root.
            safe_abs = safe_resolve(root, rel)
            nodes, edges = _analyze(safe_abs, rel, repo.id)
        except Exception as exc:  # never let one file abort the scan
            summary.errors.append(f"analyze {rel}: {exc}")
            continue

        _resolve_imports(rel, edges, rel_to_fid, py_module_map)
        _link_contains(nodes, edges, repo.id)
        # Defensive net: even with line-discriminated ids, a pathological file
        # that somehow yields two nodes/edges sharing a primary key must degrade
        # to "keep first" rather than 500 the whole scan on an IntegrityError.
        nodes = _dedupe_by_id(nodes)
        edges = _dedupe_by_id(edges)

        content_hash = hashlib.sha1(abs_path.read_bytes()).hexdigest()
        file_row = {
            "id": rel_to_fid[rel],
            "repo_id": repo.id,
            "rel_path": rel,
            "language": _language_for(rel),
            "mtime_ns": stat.st_mtime_ns,
            "size": stat.st_size,
            "content_hash": content_hash,
            "last_scanned_at": _utcnow_iso(),
        }
        # Point the file node at its directory so the tree is consistent even
        # for files whose dir node is (re)built in the structural pass.
        nodes[0].parent_id = _dir_id_for(repo.id, rel)
        store.replace_file_graph(repo.id, file_row, nodes, edges)
        summary.files_scanned += 1
        summary.nodes_created += len(nodes)
        summary.edges_created += len(edges)

    # --- Prune files that vanished from disk -------------------------------
    for stale in set(store.list_file_rel_paths(repo.id)) - current_rel:
        store.delete_file_graph(repo.id, stale)

    # --- Rebuild repo/dir scaffold + structural contains edges -------------
    struct_nodes, struct_edges = _build_structure(repo, current_rel, rel_to_fid)
    store.replace_structure(repo.id, struct_nodes, struct_edges)
    summary.nodes_created += len(struct_nodes)
    summary.edges_created += len(struct_edges)

    summary.duration_ms = int((time.monotonic() - started) * 1000)
    status = "error" if summary.errors else "ok"
    store.update_scan_result(repo.id, status, summary.model_dump_json())
    return summary


def _analyze(abs_path: Path, rel: str, repo_id: str) -> tuple[list[GraphNode], list[GraphEdge]]:
    if PurePosixPath(rel).suffix.lower() in _PY_EXTS:
        return python_analyzer.analyze_file(abs_path, rel, repo_id)
    return ts_analyzer.analyze_file(abs_path, rel, repo_id)


def _resolve_imports(
    rel: str,
    edges: list[GraphEdge],
    rel_to_fid: dict[str, str],
    py_module_map: dict[str, str],
) -> None:
    """Second-pass resolution: point import edges at internal file nodes."""
    is_py = PurePosixPath(rel).suffix.lower() in _PY_EXTS
    own_fid = rel_to_fid.get(rel)
    for edge in edges:
        if edge.edge_type != "imports" or not edge.dst_unresolved:
            continue
        spec = edge.dst_unresolved
        target = py_module_map.get(spec) if is_py else _resolve_ts_spec(rel, spec, rel_to_fid)
        if target and target != own_fid:
            edge.dst_node_id = target
            edge.dst_unresolved = None


def _resolve_ts_spec(importer_rel: str, spec: str, rel_to_fid: dict[str, str]) -> str | None:
    """Resolve a relative TS/JS import to an internal file node id.

    Bare specifiers (packages) and unresolved aliases (e.g. `@atlas/*`) return
    None and stay in `dst_unresolved`, per the plan's Atlas-alias guidance.
    """
    if not spec.startswith("."):
        return None
    base = (PurePosixPath(importer_rel).parent / spec)
    # Normalize '..' / '.' segments without touching the filesystem.
    parts: list[str] = []
    for part in base.parts:
        if part == "..":
            if parts:
                parts.pop()
        elif part != ".":
            parts.append(part)
    target = "/".join(parts)
    candidates = [
        target,
        *(f"{target}{ext}" for ext in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")),
        *(f"{target}/index{ext}" for ext in (".ts", ".tsx", ".js", ".jsx")),
    ]
    for cand in candidates:
        if cand in rel_to_fid:
            return rel_to_fid[cand]
    return None


def _dedupe_by_id(items: list) -> list:
    """Keep the first item per `.id`, preserving order.

    Works for both GraphNode and GraphEdge (both key on a unique `id` primary
    key in SQLite). This is a safety net, not the primary uniqueness mechanism —
    line-discriminated node ids already prevent legitimate collisions.
    """
    seen: set[str] = set()
    unique = []
    for item in items:
        if item.id in seen:
            continue
        seen.add(item.id)
        unique.append(item)
    return unique


def _link_contains(nodes: list[GraphNode], edges: list[GraphEdge], repo_id: str) -> None:
    """Emit `contains` edges from each symbol node to its parent (file/class)."""
    for node in nodes:
        if node.parent_id and node.kind in ("class", "function", "method"):
            edges.append(
                GraphEdge(
                    id=make_edge_id(repo_id, node.parent_id, "contains", node.id),
                    repo_id=repo_id,
                    src_node_id=node.parent_id,
                    dst_node_id=node.id,
                    edge_type="contains",
                )
            )


def _repo_node_id(repo_id: str) -> str:
    return make_node_id(repo_id, "", "repo", repo_id)


def _dir_id_for(repo_id: str, rel: str) -> str:
    parent = PurePosixPath(rel).parent
    if str(parent) in ("", "."):
        return _repo_node_id(repo_id)
    return make_node_id(repo_id, str(parent), "dir", str(parent))


def _build_structure(
    repo: RepoConfig,
    rel_paths: set[str],
    rel_to_fid: dict[str, str],
) -> tuple[list[GraphNode], list[GraphEdge]]:
    """Build the repo node, dir nodes and repo->dir / dir->dir / dir->file edges."""
    repo_id = repo.id
    repo_node = GraphNode(
        id=_repo_node_id(repo_id),
        repo_id=repo_id,
        kind="repo",
        name=repo.name,
        qualified_name=repo.name,
        extraction_method=None,
    )
    nodes: list[GraphNode] = [repo_node]
    edges: list[GraphEdge] = []
    dir_ids: dict[str, str] = {}  # dir posix path -> node id

    def ensure_dir(dir_path: str) -> str:
        if dir_path in ("", "."):
            return repo_node.id
        if dir_path in dir_ids:
            return dir_ids[dir_path]
        node_id = make_node_id(repo_id, dir_path, "dir", dir_path)
        dir_ids[dir_path] = node_id
        parent = str(PurePosixPath(dir_path).parent)
        parent_id = ensure_dir(parent if parent != dir_path else "")
        nodes.append(
            GraphNode(
                id=node_id,
                repo_id=repo_id,
                kind="dir",
                name=PurePosixPath(dir_path).name,
                qualified_name=dir_path,
                parent_id=parent_id,
            )
        )
        edges.append(
            GraphEdge(
                id=make_edge_id(repo_id, parent_id, "contains", node_id),
                repo_id=repo_id,
                src_node_id=parent_id,
                dst_node_id=node_id,
                edge_type="contains",
            )
        )
        return node_id

    for rel in sorted(rel_paths):
        parent = str(PurePosixPath(rel).parent)
        parent_id = ensure_dir(parent)
        fid = rel_to_fid[rel]
        edges.append(
            GraphEdge(
                id=make_edge_id(repo_id, parent_id, "contains", fid),
                repo_id=repo_id,
                src_node_id=parent_id,
                dst_node_id=fid,
                edge_type="contains",
            )
        )
    return nodes, edges
