from __future__ import annotations

from pathlib import Path

import pytest

from app.analysis import ts_analyzer

TS_SNIPPET = '''\
import { helper } from "./helper";
import React from "react";

export abstract class Base {
    ready = false;
    title: string;

    render(): void {
        if (this.ready) {
            return;
        }
    }
    dispose() {}
}

export function compute(n: number): number {
    for (let i = 0; i < n; i++) {
        if (i % 2 === 0) {
            n += i;
        }
    }
    return n;
}

export const arrow = (x: number) => x * 2;
'''


def _analyze(tmp_path: Path, text: str, name: str = "widget.ts", rel: str = "src/widget.ts"):
    f = tmp_path / name
    f.write_text(text, encoding="utf-8")
    return ts_analyzer.analyze_file(f, rel, "repo_ts")


def test_tree_sitter_extraction(tmp_path: Path) -> None:
    if not ts_analyzer.TREE_SITTER_AVAILABLE:
        pytest.skip("tree-sitter not installed in this environment")

    nodes, edges = _analyze(tmp_path, TS_SNIPPET)
    by_kind: dict[str, list] = {}
    for n in nodes:
        by_kind.setdefault(n.kind, []).append(n)

    assert [n.name for n in by_kind["class"]] == ["Base"]
    assert by_kind["class"][0].method_count == 2
    assert {n.qualified_name for n in by_kind["attribute"]} == {"Base.ready", "Base.title"}
    assert {n.qualified_name for n in by_kind["method"]} == {"Base.render", "Base.dispose"}
    func_names = {n.name for n in by_kind["function"]}
    assert "compute" in func_names
    assert "arrow" in func_names  # arrow-const best-effort
    assert all(n.extraction_method == "tree_sitter" for n in nodes)

    specs = {e.dst_unresolved for e in edges if e.edge_type == "imports"}
    assert specs == {"./helper", "react"}

    compute = next(n for n in by_kind["function"] if n.name == "compute")
    assert compute.complexity_estimate >= 3  # for + if (+ base 1)


def test_regex_fallback_forced(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Force the fallback even though tree-sitter is installed.
    monkeypatch.setattr(ts_analyzer, "TREE_SITTER_AVAILABLE", False)

    nodes, edges = _analyze(tmp_path, TS_SNIPPET)
    by_kind: dict[str, list] = {}
    for n in nodes:
        by_kind.setdefault(n.kind, []).append(n)

    assert [n.name for n in by_kind["class"]] == ["Base"]
    func_names = {n.name for n in by_kind["function"]}
    assert "compute" in func_names
    assert "arrow" in func_names
    assert all(n.extraction_method == "regex" for n in nodes if n.kind != "file")

    specs = {e.dst_unresolved for e in edges if e.edge_type == "imports"}
    assert specs == {"./helper", "react"}
