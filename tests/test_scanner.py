from __future__ import annotations

from pathlib import Path

from app.analysis import scanner
from app.graph_store import GraphStore
from app.models import RepoConfig

PY_FILE = '''\
from .other import thing


class Service:
    def run(self):
        if thing:
            return 1
        return 0


def helper():
    return 42
'''

OTHER_PY = "thing = 1\n"

TS_FILE = '''\
import { Service } from "./svc";

export class Widget {
    mount() {}
}

export function boot() {
    return new Widget();
}
'''


def _make_repo(tmp_path: Path) -> tuple[RepoConfig, GraphStore]:
    root = tmp_path / "proj"
    (root / "pkg").mkdir(parents=True)
    (root / "pkg" / "mod.py").write_text(PY_FILE, encoding="utf-8")
    (root / "pkg" / "other.py").write_text(OTHER_PY, encoding="utf-8")
    (root / "web.ts").write_text(TS_FILE, encoding="utf-8")
    # An excluded dir that must never be walked.
    (root / "node_modules").mkdir()
    (root / "node_modules" / "junk.js").write_text("export class Nope {}\n", encoding="utf-8")

    store = GraphStore(tmp_path / "graph.db")
    repo = store.add_repo(RepoConfig(name="Proj", root_path=str(root)))
    return repo, store


def test_scan_extracts_symbols_and_counts(tmp_path: Path) -> None:
    repo, store = _make_repo(tmp_path)
    summary = scanner.scan_repo(repo, store)

    assert summary.files_scanned == 3  # mod.py, other.py, web.ts (node_modules pruned)
    assert summary.files_skipped_unchanged == 0
    assert summary.errors == []

    snap = store.get_snapshot(repo.id)
    kinds = {n.kind for n in snap.nodes}
    assert {"repo", "dir", "file", "class", "function", "method"} <= kinds

    names = {(n.kind, n.name) for n in snap.nodes}
    assert ("class", "Service") in names
    assert ("method", "run") in names
    assert ("function", "helper") in names
    assert ("class", "Widget") in names

    # Python internal import resolved to a node; the TS ./svc import stays unresolved.
    import_edges = [e for e in snap.edges if e.edge_type == "imports"]
    resolved = [e for e in import_edges if e.dst_node_id]
    assert any(resolved)  # .other resolved to other.py's file node
    # node_modules was pruned -> no "Nope" class.
    assert ("class", "Nope") not in names


def test_rescan_uses_mtime_cache(tmp_path: Path) -> None:
    repo, store = _make_repo(tmp_path)
    first = scanner.scan_repo(repo, store)
    assert first.files_scanned == 3

    second = scanner.scan_repo(repo, store)
    assert second.files_scanned == 0
    assert second.files_skipped_unchanged == 3

    # Snapshot must be preserved across the cached rescan.
    assert {n.name for n in store.get_snapshot(repo.id).nodes} == {
        n.name for n in store.get_snapshot(repo.id).nodes
    }
    assert any(n.kind == "class" for n in store.get_snapshot(repo.id).nodes)
