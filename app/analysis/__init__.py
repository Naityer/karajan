"""Facade de compatibilidad hacia `code_graph.analysis` (ids deterministas)."""
from __future__ import annotations

from code_graph.analysis import file_node_id, make_edge_id, make_node_id  # noqa: F401

__all__ = ["make_node_id", "make_edge_id", "file_node_id"]
