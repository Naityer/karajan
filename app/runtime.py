"""Compatibility import; implementation lives in app.application.runtime."""
import sys as _sys
from app.application import runtime as _implementation
_sys.modules[__name__] = _implementation
