"""Facade de compatibilidad: el grafo se extrajo al paquete `code_graph`.

Este modulo re-exporta la API publica desde `code_graph.store` para que el
resto de Karajan (`app.*`) y sus tests sigan importando `app.graph_store` sin
cambios. La implementacion real vive ahora en el paquete compartido.
"""
from __future__ import annotations

from code_graph.store import (  # noqa: F401
    DEFAULT_DB_PATH,
    GraphStore,
    _utcnow_iso,
    safe_resolve,
)

__all__ = ["DEFAULT_DB_PATH", "GraphStore", "safe_resolve", "_utcnow_iso"]
