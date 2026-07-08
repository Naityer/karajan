from __future__ import annotations

from pathlib import Path

from app.analysis import python_analyzer

SNIPPET = '''\
import os
from .helpers import util
from ..pkg import thing


class Widget:
    def __init__(self, x):
        self.x = x

    def render(self, items):
        for item in items:
            if item:
                print(item)
        return self.x


def top_level(n):
    while n > 0:
        n -= 1
    return n
'''


def _analyze(tmp_path: Path, text: str, rel: str = "app/mod.py"):
    f = tmp_path / "mod.py"
    f.write_text(text, encoding="utf-8")
    return python_analyzer.analyze_file(f, rel, "repo_test")


def test_extracts_class_methods_and_function(tmp_path: Path) -> None:
    nodes, edges = _analyze(tmp_path, SNIPPET)
    by_kind: dict[str, list] = {}
    for n in nodes:
        by_kind.setdefault(n.kind, []).append(n)

    assert len(by_kind["file"]) == 1
    assert [n.name for n in by_kind["class"]] == ["Widget"]
    assert by_kind["class"][0].method_count == 2
    assert {n.qualified_name for n in by_kind["attribute"]} == {"Widget.x"}
    assert {n.qualified_name for n in by_kind["method"]} == {"Widget.__init__", "Widget.render"}
    assert [n.name for n in by_kind["function"]] == ["top_level"]

    # render has a `for` + `if` -> complexity 3; top_level has a `while` -> 2.
    render = next(n for n in by_kind["method"] if n.name == "render")
    top = by_kind["function"][0]
    assert render.complexity_estimate == 3
    assert top.complexity_estimate == 2

    # method parent is the class node; class parent is the file node.
    cls = by_kind["class"][0]
    assert render.parent_id == cls.id
    assert cls.parent_id == by_kind["file"][0].id
    assert all(n.extraction_method == "ast" for n in nodes)


def test_extracts_class_and_instance_attributes(tmp_path: Path) -> None:
    nodes, _ = _analyze(
        tmp_path,
        '''\
class Account:
    status: str = "open"

    def __init__(self, owner):
        self.owner = owner
        self.balance: int = 0
''',
    )

    attributes = [n for n in nodes if n.kind == "attribute"]
    assert {n.qualified_name for n in attributes} == {
        "Account.status",
        "Account.owner",
        "Account.balance",
    }
    cls = next(n for n in nodes if n.kind == "class")
    assert all(n.parent_id == cls.id for n in attributes)


def test_import_edges_emitted_unresolved(tmp_path: Path) -> None:
    _, edges = _analyze(tmp_path, SNIPPET)
    specs = {e.dst_unresolved for e in edges if e.edge_type == "imports"}
    # `import os` plus two relative imports resolved to dotted module strings.
    assert "os" in specs
    assert "app.helpers" in specs  # from .helpers (relative to app/mod.py -> app.helpers)
    assert all(e.dst_node_id is None for e in edges)  # resolution happens in scanner


def test_syntax_error_degrades_to_file_node(tmp_path: Path) -> None:
    nodes, edges = _analyze(tmp_path, "def broken(:\n    pass\n")
    assert len(nodes) == 1
    assert nodes[0].kind == "file"
    assert edges == []


# Regression: same-named symbols that legitimately coexist in one file (a
# @property/@setter pair here) must get distinct node ids, or they collide on
# the graph_nodes.id primary key and abort the whole repo scan with an
# IntegrityError (observed scanning OCR_Naityer).
SAME_NAME_SNIPPET = '''\
class Config:
    @property
    def value(self):
        return self._value

    @value.setter
    def value(self, v):
        self._value = v
'''


def test_same_named_methods_get_unique_ids(tmp_path: Path) -> None:
    nodes, _ = _analyze(tmp_path, SAME_NAME_SNIPPET)
    methods = [n for n in nodes if n.kind == "method"]
    assert len(methods) == 2
    assert {n.qualified_name for n in methods} == {"Config.value"}
    # Distinct start lines -> distinct ids despite identical (kind, qualified_name).
    assert methods[0].id != methods[1].id
    assert len({n.id for n in nodes}) == len(nodes)
