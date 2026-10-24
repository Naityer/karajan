"""Compatibility import; implementation lives in app.application.management."""
import sys as _sys
from app.application import management as _implementation
_sys.modules[__name__] = _implementation
