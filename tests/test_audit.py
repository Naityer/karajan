from __future__ import annotations

from pathlib import Path

from app.analysis import audit
from app.graph_store import GraphStore
from app.models import GraphEdge, GraphNode, RepoConfig


def _file(repo_id: str, rel: str, *, loc: int | None = None, end: int | None = None) -> GraphNode:
    return GraphNode(
        id=f"file::{rel}", repo_id=repo_id, file_id=f"file::{rel}", kind="file",
        name=rel.split("/")[-1], qualified_name=rel, start_line=1, end_line=end, loc=loc,
    )


def _cls(repo_id: str, name: str, file_id: str, method_count: int) -> GraphNode:
    return GraphNode(
        id=f"cls::{name}", repo_id=repo_id, file_id=file_id, kind="class",
        name=name, qualified_name=name, parent_id=file_id, method_count=method_count,
    )


def _fn(repo_id: str, name: str, file_id: str, *, loc: int = 0, cx: int = 0, kind: str = "function") -> GraphNode:
    return GraphNode(
        id=f"fn::{name}", repo_id=repo_id, file_id=file_id, kind=kind, name=name,
        qualified_name=name, parent_id=file_id, loc=loc, complexity_estimate=cx,
    )


# --- Individual deterministic detectors --------------------------------------


def test_god_class() -> None:
    nodes = [_cls("r", "Big", "f", 16), _cls("r", "Small", "f", 5)]
    out = audit.detect_god_class("r", nodes)
    assert len(out) == 1
    assert out[0].detector == "god_class"
    assert out[0].severity == "warning"
    assert out[0].node_id == "cls::Big"
    assert "16" in out[0].message


def test_large_file_by_loc_and_symbols() -> None:
    big = _file("r", "big.py", loc=700)
    small = _file("r", "small.py", loc=50)
    wide = _file("r", "wide.py", loc=100)
    symbols = [_fn("r", f"g{i}", wide.id) for i in range(26)]
    out = audit.detect_large_file("r", [big, small, wide, *symbols])
    flagged = {f.node_id for f in out}
    assert big.id in flagged  # by loc
    assert wide.id in flagged  # by symbol count
    assert small.id not in flagged


def test_long_function_severity() -> None:
    nodes = [
        _fn("r", "ok", "f", loc=40),
        _fn("r", "warn", "f", loc=90),
        _fn("r", "crit", "f", loc=200),
    ]
    out = {f.node_id: f.severity for f in audit.detect_long_function("r", nodes)}
    assert "fn::ok" not in out
    assert out["fn::warn"] == "warning"
    assert out["fn::crit"] == "critical"


def test_high_complexity_severity() -> None:
    nodes = [
        _fn("r", "ok", "f", cx=5),
        _fn("r", "warn", "f", cx=15),
        _fn("r", "crit", "f", cx=25, kind="method"),
    ]
    out = {f.node_id: f.severity for f in audit.detect_high_complexity("r", nodes)}
    assert "fn::ok" not in out
    assert out["fn::warn"] == "warning"
    assert out["fn::crit"] == "critical"


def test_circular_imports_two_cycle() -> None:
    a = _file("r", "a.py")
    b = _file("r", "b.py")
    edges = [
        GraphEdge(id="e1", repo_id="r", src_node_id=a.id, dst_node_id=b.id, edge_type="imports"),
        GraphEdge(id="e2", repo_id="r", src_node_id=b.id, dst_node_id=a.id, edge_type="imports"),
    ]
    out = audit.detect_circular_imports("r", [a, b], edges)
    assert len(out) == 2  # one finding per file in the cycle
    assert {f.node_id for f in out} == {a.id, b.id}
    assert all(f.detector == "circular_imports" for f in out)
    assert all("a.py" in f.message and "b.py" in f.message for f in out)


def test_circular_imports_no_false_positive_on_acyclic() -> None:
    a = _file("r", "a.py")
    b = _file("r", "b.py")
    edges = [GraphEdge(id="e1", repo_id="r", src_node_id=a.id, dst_node_id=b.id, edge_type="imports")]
    assert audit.detect_circular_imports("r", [a, b], edges) == []


def test_hardcoded_secret_detects_aws_and_redacts() -> None:
    fake = "AKIAIOSFODNN7EXAMPLE"  # fake AWS key shape (AKIA + 16 chars)
    text = f'aws_key = "{fake}"\n'
    out = audit.scan_secrets_in_text(text)
    assert len(out) == 1
    line, sev, msg = out[0]
    assert sev == "critical"
    assert fake not in msg  # redaction: raw secret never echoed
    assert "AKIA****" in msg


def test_hardcoded_secret_ignores_env_reference() -> None:
    text = 'token = os.environ["MY_TOKEN"]\n'
    assert audit.scan_secrets_in_text(text) == []


def test_hardcoded_secret_ignores_placeholder() -> None:
    text = 'password = "changeme-please"\napi_key = "<your-api-key>"\n'
    assert audit.scan_secrets_in_text(text) == []


def test_hardcoded_secret_generic_assignment_no_value_leak() -> None:
    secret = "s3cr3t-p@ssw0rd-value-123"
    text = f'password = "{secret}"\n'
    out = audit.scan_secrets_in_text(text)
    assert len(out) == 1
    assert secret not in out[0][2]
    assert "password" in out[0][2]


def test_todo_density(tmp_path: Path) -> None:
    src = "\n".join([f"# TODO item {i}" for i in range(10)])
    f = tmp_path / "busy.py"
    f.write_text(src, encoding="utf-8")
    node = _file("r", "busy.py")
    out = audit.detect_file_text_issues("r", [node], tmp_path)
    todos = [x for x in out if x.detector == "todo_density"]
    assert len(todos) == 1
    assert todos[0].severity == "info"


# --- Orchestration: persistence round-trip -----------------------------------


def test_run_audit_persists_and_list_findings(tmp_path: Path) -> None:
    store = GraphStore(tmp_path / "graph.db")
    repo = store.add_repo(RepoConfig(name="T", root_path=str(tmp_path)))

    file_node = _file(repo.id, "mod.py", loc=700)
    god = _cls(repo.id, "Huge", file_node.id, 20)
    # Persist a graph snapshot the audit will read back.
    store.replace_file_graph(
        repo.id,
        {"id": file_node.id, "rel_path": "mod.py", "language": "python",
         "mtime_ns": 0, "size": 1, "content_hash": "x", "last_scanned_at": "now"},
        [file_node, god],
        [],
    )

    result = audit.run_audit(repo.id, store, include_llm=False)
    assert result.counts_by_severity["warning"] >= 2  # large_file + god_class
    detectors = {f.detector for f in result.findings}
    assert "god_class" in detectors and "large_file" in detectors

    persisted = store.list_findings(repo.id)
    assert len(persisted) == len(result.findings)
    assert {f.detector for f in persisted} == detectors


def test_run_audit_empty_repo_does_not_crash(tmp_path: Path) -> None:
    store = GraphStore(tmp_path / "graph.db")
    repo = store.add_repo(RepoConfig(name="E", root_path=str(tmp_path)))
    result = audit.run_audit(repo.id, store, include_llm=False)
    assert result.findings == []
    assert result.counts_by_severity == {"info": 0, "warning": 0, "critical": 0}
