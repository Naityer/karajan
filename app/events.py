"""Compatibility import; implementation lives in app.execution.events."""
import sys as _sys
from app.execution import events as _implementation
_sys.modules[__name__] = _implementation
