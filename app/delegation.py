"""Compatibility import; implementation lives in app.execution.delegation."""
import sys as _sys
from app.execution import delegation as _implementation
_sys.modules[__name__] = _implementation
