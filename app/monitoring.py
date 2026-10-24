"""Compatibility import; implementation lives in app.execution.monitoring."""
import sys as _sys
from app.execution import monitoring as _implementation
_sys.modules[__name__] = _implementation
