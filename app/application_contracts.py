"""Compatibility import; implementation lives in app.application.contracts."""
import sys as _sys
from app.application import contracts as _implementation
_sys.modules[__name__] = _implementation
