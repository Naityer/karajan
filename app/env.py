"""Compatibility import; implementation lives in app.configuration.env."""
import sys as _sys
from app.configuration import env as _implementation
_sys.modules[__name__] = _implementation
