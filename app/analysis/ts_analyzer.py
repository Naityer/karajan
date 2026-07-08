"""TypeScript/JavaScript extraction.

Primary path uses tree-sitter (via `tree_sitter_language_pack`) for a real parse
of classes, functions, top-level arrow-function consts, methods and imports.
When tree-sitter is unavailable the module falls back to a regex extractor so
the optional dependency is never a hard requirement; regex-derived nodes are
marked `extraction_method="regex"` so the UI can flag their lower confidence.
Either way a single unparseable file yields just a file node, never an exception
that aborts the whole repo scan.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.analysis import file_node_id, make_edge_id, make_node_id
from app.models import GraphEdge, GraphNode

try:  # optional dependency — regex fallback covers its absence
    from tree_sitter_language_pack import get_parser

    TREE_SITTER_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised via monkeypatch in tests
    TREE_SITTER_AVAILABLE = False


_EXT_TO_LANG = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".jsx": "tsx",  # tsx grammar parses JSX; the js grammar does not
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
}

# Descendant node types that add a branch to the complexity estimate.
_TS_BRANCH_TYPES = {
    "if_statement", "for_statement", "for_in_statement", "while_statement",
    "do_statement", "catch_clause", "ternary_expression", "case_statement",
}
_TS_PROPERTY_TYPES = {
    "field_definition", "public_field_definition", "property_signature",
    "abstract_property_signature", "property_declaration",
}


def analyze_file(abs_path: Path, rel_path: str, repo_id: str) -> tuple[list[GraphNode], list[GraphEdge]]:
    fid = file_node_id(repo_id, rel_path)
    text = abs_path.read_text(encoding="utf-8", errors="replace")
    file_node = GraphNode(
        id=fid,
        repo_id=repo_id,
        file_id=fid,
        kind="file",
        name=Path(rel_path).name,
        qualified_name=rel_path,
        parent_id=None,
        start_line=1,
        end_line=len(text.splitlines()) or 1,
        extraction_method="tree_sitter" if TREE_SITTER_AVAILABLE else "regex",
    )
    nodes: list[GraphNode] = [file_node]
    edges: list[GraphEdge] = []

    try:
        if TREE_SITTER_AVAILABLE:
            _tree_sitter_extract(text, rel_path, repo_id, fid, nodes, edges)
        else:
            _regex_fallback(text, rel_path, repo_id, fid, nodes, edges)
    except Exception:
        # Any parser hiccup on a pathological file -> keep just the file node.
        return [file_node], []

    return nodes, edges


# --- tree-sitter path --------------------------------------------------------


def _lang_for(rel_path: str) -> str:
    return _EXT_TO_LANG.get(Path(rel_path).suffix.lower(), "typescript")


def _node_text(node) -> str:
    return node.text.decode("utf-8", errors="replace")


def _child_field(node, field: str):
    return node.child_by_field_name(field)


def _ts_complexity(node) -> int:
    count = 1
    stack = list(node.children)
    while stack:
        cur = stack.pop()
        if cur.type in _TS_BRANCH_TYPES:
            count += 1
        elif cur.type == "binary_expression":
            op = _child_field(cur, "operator")
            if op is not None and _node_text(op) in ("&&", "||"):
                count += 1
        stack.extend(cur.children)
    return count


def _loc(node) -> int:
    return max(1, node.end_point[0] - node.start_point[0] + 1)


def _add_symbol(
    kind: str,
    name: str,
    qualified_name: str,
    node,
    repo_id: str,
    rel_path: str,
    file_id: str,
    parent_id: str,
    nodes: list[GraphNode],
    method_count: int | None = None,
) -> str:
    start_line = node.start_point[0] + 1
    node_id = make_node_id(repo_id, rel_path, kind, qualified_name, start_line)
    nodes.append(
        GraphNode(
            id=node_id,
            repo_id=repo_id,
            file_id=file_id,
            kind=kind,
            name=name,
            qualified_name=qualified_name,
            parent_id=parent_id,
            start_line=start_line,
            end_line=node.end_point[0] + 1,
            method_count=method_count,
            loc=_loc(node),
            complexity_estimate=_ts_complexity(node),
            extraction_method="tree_sitter",
        )
    )
    return node_id


def _tree_sitter_extract(
    text: str,
    rel_path: str,
    repo_id: str,
    file_id: str,
    nodes: list[GraphNode],
    edges: list[GraphEdge],
) -> None:
    parser = get_parser(_lang_for(rel_path))
    tree = parser.parse(text.encode("utf-8"))
    seen_imports: set[str] = set()

    def visit(node, parent_id: str) -> None:
        for child in node.children:
            t = child.type
            if t in ("class_declaration", "abstract_class_declaration"):
                name_node = _child_field(child, "name")
                name = _node_text(name_node) if name_node else "(anonymous)"
                body = _child_field(child, "body")
                methods = [c for c in (body.children if body else []) if c.type == "method_definition"]
                class_id = _add_symbol(
                    "class", name, name, child, repo_id, rel_path, file_id,
                    parent_id, nodes, method_count=len(methods),
                )
                for m in methods:
                    mname_node = _child_field(m, "name")
                    mname = _node_text(mname_node) if mname_node else "(method)"
                    _add_symbol(
                        "method", mname, f"{name}.{mname}", m, repo_id, rel_path,
                        file_id, class_id, nodes,
                    )
                seen_attrs: set[str] = set()
                for prop in [c for c in (body.children if body else []) if c.type in _TS_PROPERTY_TYPES]:
                    pname_node = _child_field(prop, "name")
                    pname = _node_text(pname_node) if pname_node else ""
                    if not pname or pname in seen_attrs:
                        continue
                    seen_attrs.add(pname)
                    _add_symbol(
                        "attribute", pname, f"{name}.{pname}", prop, repo_id, rel_path,
                        file_id, class_id, nodes,
                    )
                continue
            if t == "function_declaration":
                name_node = _child_field(child, "name")
                name = _node_text(name_node) if name_node else "(anonymous)"
                _add_symbol("function", name, name, child, repo_id, rel_path, file_id, parent_id, nodes)
                continue
            if t == "lexical_declaration":
                _try_arrow_const(child, repo_id, rel_path, file_id, parent_id, nodes)
            elif t == "import_statement":
                _capture_import(child, repo_id, file_id, seen_imports, edges)
            # Descend into export statements / blocks to reach the real declarations.
            if t in ("export_statement", "program", "statement_block"):
                visit(child, parent_id)

    visit(tree.root_node, file_id)


def _try_arrow_const(decl, repo_id, rel_path, file_id, parent_id, nodes) -> None:
    """Best-effort: `const foo = () => {…}` / `const foo = function(){…}`."""
    for child in decl.children:
        if child.type != "variable_declarator":
            continue
        name_node = _child_field(child, "name")
        value = _child_field(child, "value")
        if name_node is None or value is None:
            continue
        if value.type in ("arrow_function", "function_expression"):
            name = _node_text(name_node)
            _add_symbol("function", name, name, value, repo_id, rel_path, file_id, parent_id, nodes)


def _capture_import(node, repo_id, file_id, seen: set[str], edges: list[GraphEdge]) -> None:
    source = _child_field(node, "source")
    if source is None:
        return
    spec = _node_text(source).strip("\"'`")
    if not spec or spec in seen:
        return
    seen.add(spec)
    edges.append(
        GraphEdge(
            id=make_edge_id(repo_id, file_id, "imports", spec),
            repo_id=repo_id,
            src_node_id=file_id,
            dst_node_id=None,
            edge_type="imports",
            dst_unresolved=spec,
        )
    )


# --- regex fallback ----------------------------------------------------------

_RE_CLASS = re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)", re.MULTILINE)
_RE_FUNCTION = re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)", re.MULTILINE)
_RE_ARROW = re.compile(r"^\s*(?:export\s+)?(?:default\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::[^=]+)?=>", re.MULTILINE)
_RE_IMPORT = re.compile(r"""import\s+(?:[^;'"]*?\s+from\s+)?['"]([^'"]+)['"]""")
_RE_CLASS_BLOCK = re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)[^{]*\{(?P<body>.*?)^\s*\}", re.MULTILINE | re.DOTALL)
_RE_CLASS_PROP = re.compile(r"^\s*(?:public|private|protected|readonly|static\s+)*(\w+)\s*(?::[^=;({]+)?(?:=|;)", re.MULTILINE)


def _line_of(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def _regex_fallback(
    text: str,
    rel_path: str,
    repo_id: str,
    file_id: str,
    nodes: list[GraphNode],
    edges: list[GraphEdge],
) -> None:
    for kind, pattern in (("class", _RE_CLASS), ("function", _RE_FUNCTION), ("function", _RE_ARROW)):
        for match in pattern.finditer(text):
            name = match.group(1)
            line = _line_of(text, match.start())
            nodes.append(
                GraphNode(
                    id=make_node_id(repo_id, rel_path, kind, name, line),
                    repo_id=repo_id,
                    file_id=file_id,
                    kind=kind,
                    name=name,
                    qualified_name=name,
                    parent_id=file_id,
                    start_line=line,
                    end_line=line,
                    extraction_method="regex",
                )
            )
    class_nodes = {n.name: n for n in nodes if n.kind == "class"}
    for cls_match in _RE_CLASS_BLOCK.finditer(text):
        class_name = cls_match.group(1)
        class_node = class_nodes.get(class_name)
        if class_node is None:
            continue
        body = cls_match.group("body")
        for prop_match in _RE_CLASS_PROP.finditer(body):
            name = prop_match.group(1)
            if name in {"constructor", "get", "set", "if", "for", "while", "return"}:
                continue
            line = _line_of(text, cls_match.start("body") + prop_match.start())
            nodes.append(
                GraphNode(
                    id=make_node_id(repo_id, rel_path, "attribute", f"{class_name}.{name}", line),
                    repo_id=repo_id,
                    file_id=file_id,
                    kind="attribute",
                    name=name,
                    qualified_name=f"{class_name}.{name}",
                    parent_id=class_node.id,
                    start_line=line,
                    end_line=line,
                    loc=1,
                    extraction_method="regex",
                )
            )
    seen: set[str] = set()
    for match in _RE_IMPORT.finditer(text):
        spec = match.group(1)
        if not spec or spec in seen:
            continue
        seen.add(spec)
        edges.append(
            GraphEdge(
                id=make_edge_id(repo_id, file_id, "imports", spec),
                repo_id=repo_id,
                src_node_id=file_id,
                dst_node_id=None,
                edge_type="imports",
                dst_unresolved=spec,
            )
        )
