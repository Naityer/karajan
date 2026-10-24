"""Compatibility import; implementation lives in app.execution.agent_console."""
import sys as _sys
from app.execution import agent_console as _implementation
_sys.modules[__name__] = _implementation
