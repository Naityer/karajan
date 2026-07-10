"""Facade de compatibilidad hacia `code_graph.analysis.scanner`."""
from __future__ import annotations

import sys as _sys

from code_graph.analysis import scanner as _impl

_sys.modules[__name__] = _impl
