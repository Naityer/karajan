"""Compatibility import; implementation lives in app.resources.tutorial."""
import sys as _sys
from app.resources import tutorial as _implementation
_sys.modules[__name__] = _implementation
