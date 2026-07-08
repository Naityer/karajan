"""Python static extraction using the stdlib `ast` module (no new deps).

Emits a file node plus class/function/method nodes and raw import edges. Import
edges are left *unresolved* here (the dotted module string lives in
`dst_unresolved`); the scanner's second pass maps those to internal file nodes
once the whole-repo module map is known. A `SyntaxError` (e.g. a stray py2 file)
degrades to a bare file node instead of aborting the repo scan.
"""

from __future__ import annotations

import ast
from pathlib import Path

from app.analysis import file_node_id, make_edge_id, make_node_id
from app.models import GraphEdge, GraphNode

# Node types that add a branch to a rough McCabe cyclomatic estimate.
_BRANCH_NODES = (
    ast.If, ast.For, ast.AsyncFor, ast.While, ast.Try, ast.ExceptHandler,
    ast.With, ast.AsyncWith, ast.Assert, ast.BoolOp, ast.comprehension,
)


def _complexity(node: ast.AST) -> int:
    """1 + number of branch-introducing descendants (simple McCabe approx)."""
    return 1 + sum(1 for child in ast.walk(node) if isinstance(child, _BRANCH_NODES))


def _loc(node: ast.AST) -> int:
    end = getattr(node, "end_lineno", None) or getattr(node, "lineno", 1)
    start = getattr(node, "lineno", 1)
    return max(1, end - start + 1)


def analyze_file(abs_path: Path, rel_path: str, repo_id: str) -> tuple[list[GraphNode], list[GraphEdge]]:
    fid = file_node_id(repo_id, rel_path)
    file_node = GraphNode(
        id=fid,
        repo_id=repo_id,
        file_id=fid,
        kind="file",
        name=Path(rel_path).name,
        qualified_name=rel_path,
        parent_id=None,
        start_line=1,
        extraction_method="ast",
    )
    nodes: list[GraphNode] = [file_node]
    edges: list[GraphEdge] = []

    text = abs_path.read_text(encoding="utf-8", errors="replace")
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError):
        # Broken/py2/binary file — keep the file node, skip symbol extraction.
        return nodes, edges

    file_node.end_line = len(text.splitlines()) or 1

    module_prefix = _module_dotted(rel_path)

    for stmt in tree.body:
        if isinstance(stmt, ast.ClassDef):
            _emit_class(stmt, repo_id, rel_path, fid, nodes, edges)
        elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            nodes.append(_func_node(stmt, "function", stmt.name, repo_id, rel_path, fid, fid))

    # Imports can appear anywhere; ast.walk covers nested/conditional imports too.
    seen: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                _add_import_edge(alias.name, repo_id, fid, seen, edges)
        elif isinstance(node, ast.ImportFrom):
            spec = _resolve_from_module(node, module_prefix)
            if spec:
                _add_import_edge(spec, repo_id, fid, seen, edges)

    return nodes, edges


def _emit_class(
    cls: ast.ClassDef,
    repo_id: str,
    rel_path: str,
    file_id: str,
    nodes: list[GraphNode],
    edges: list[GraphEdge],
) -> None:
    methods = [b for b in cls.body if isinstance(b, (ast.FunctionDef, ast.AsyncFunctionDef))]
    class_id = make_node_id(repo_id, rel_path, "class", cls.name, cls.lineno)
    nodes.append(
        GraphNode(
            id=class_id,
            repo_id=repo_id,
            file_id=file_id,
            kind="class",
            name=cls.name,
            qualified_name=cls.name,
            parent_id=file_id,
            start_line=cls.lineno,
            end_line=getattr(cls, "end_lineno", cls.lineno),
            method_count=len(methods),
            loc=_loc(cls),
            complexity_estimate=_complexity(cls),
            extraction_method="ast",
        )
    )
    seen_attrs: set[str] = set()
    for attr_name, line in _class_attributes(cls):
        if attr_name in seen_attrs:
            continue
        seen_attrs.add(attr_name)
        nodes.append(_attr_node(attr_name, cls.name, repo_id, rel_path, file_id, class_id, line))
    for method in methods:
        qn = f"{cls.name}.{method.name}"
        nodes.append(_func_node(method, "method", qn, repo_id, rel_path, file_id, class_id))


def _class_attributes(cls: ast.ClassDef) -> list[tuple[str, int]]:
    attrs: list[tuple[str, int]] = []

    def add_from_target(target: ast.AST, line: int) -> None:
        if isinstance(target, ast.Name):
            attrs.append((target.id, line))
        elif (
            isinstance(target, ast.Attribute)
            and isinstance(target.value, ast.Name)
            and target.value.id == "self"
        ):
            attrs.append((target.attr, line))
        elif isinstance(target, (ast.Tuple, ast.List)):
            for item in target.elts:
                add_from_target(item, line)

    for stmt in cls.body:
        if isinstance(stmt, ast.Assign):
            for target in stmt.targets:
                add_from_target(target, getattr(stmt, "lineno", cls.lineno))
        elif isinstance(stmt, ast.AnnAssign):
            add_from_target(stmt.target, getattr(stmt, "lineno", cls.lineno))
        elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for child in ast.walk(stmt):
                if isinstance(child, ast.Assign):
                    for target in child.targets:
                        add_from_target(target, getattr(child, "lineno", stmt.lineno))
                elif isinstance(child, ast.AnnAssign):
                    add_from_target(child.target, getattr(child, "lineno", stmt.lineno))
    return attrs


def _attr_node(
    name: str,
    class_name: str,
    repo_id: str,
    rel_path: str,
    file_id: str,
    parent_id: str,
    line: int,
) -> GraphNode:
    qualified_name = f"{class_name}.{name}"
    return GraphNode(
        id=make_node_id(repo_id, rel_path, "attribute", qualified_name, line),
        repo_id=repo_id,
        file_id=file_id,
        kind="attribute",
        name=name,
        qualified_name=qualified_name,
        parent_id=parent_id,
        start_line=line,
        end_line=line,
        loc=1,
        extraction_method="ast",
    )


def _func_node(
    fn: ast.AST,
    kind: str,
    qualified_name: str,
    repo_id: str,
    rel_path: str,
    file_id: str,
    parent_id: str,
) -> GraphNode:
    start_line = getattr(fn, "lineno", 1)
    return GraphNode(
        id=make_node_id(repo_id, rel_path, kind, qualified_name, start_line),
        repo_id=repo_id,
        file_id=file_id,
        kind=kind,
        name=getattr(fn, "name", qualified_name),
        qualified_name=qualified_name,
        parent_id=parent_id,
        start_line=start_line,
        end_line=getattr(fn, "end_lineno", getattr(fn, "lineno", 1)),
        loc=_loc(fn),
        complexity_estimate=_complexity(fn),
        extraction_method="ast",
    )


def _add_import_edge(
    module: str,
    repo_id: str,
    src_id: str,
    seen: set[str],
    edges: list[GraphEdge],
) -> None:
    if not module or module in seen:
        return
    seen.add(module)
    edges.append(
        GraphEdge(
            id=make_edge_id(repo_id, src_id, "imports", module),
            repo_id=repo_id,
            src_node_id=src_id,
            dst_node_id=None,
            edge_type="imports",
            dst_unresolved=module,
        )
    )


def _module_dotted(rel_path: str) -> str:
    """Dotted module path of a file, e.g. app/foo/bar.py -> app.foo.bar."""
    p = rel_path[:-3] if rel_path.endswith(".py") else rel_path
    if p.endswith("/__init__"):
        p = p[: -len("/__init__")]
    return p.replace("/", ".")


def _resolve_from_module(node: ast.ImportFrom, module_prefix: str) -> str | None:
    """Turn a `from x import y` into a dotted module string, resolving relatives.

    `from . import x` / `from ..pkg import y` use `node.level` to walk up from
    the importing module's package so relative imports become internal-resolvable
    dotted paths in the scanner's second pass.
    """
    if not node.level:
        return node.module
    parts = module_prefix.split(".") if module_prefix else []
    # A module's own name drops off; each extra dot climbs another package level.
    base = parts[: len(parts) - node.level] if len(parts) >= node.level else []
    if node.module:
        base = base + node.module.split(".")
    return ".".join(base) if base else (node.module or None)
