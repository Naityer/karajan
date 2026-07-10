"""Facade de compatibilidad hacia `code_graph.analysis.ts_analyzer`."""
from __future__ import annotations

import sys as _sys

from code_graph.analysis import ts_analyzer as _impl

_sys.modules[__name__] = _impl
