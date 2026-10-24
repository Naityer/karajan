"""Compatibility import; implementation lives in app.application.errors."""
import sys as _sys
from app.application import errors as _implementation
_sys.modules[__name__] = _implementation
