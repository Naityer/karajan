"""Compatibility import; implementation lives in app.execution.validation."""
import sys as _sys
from app.execution import validation as _implementation
_sys.modules[__name__] = _implementation
