"""Compatibility import; implementation lives in app.application.dto."""
import sys as _sys
from app.application import dto as _implementation
_sys.modules[__name__] = _implementation
