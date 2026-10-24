"""Compatibility import; implementation lives in app.providers.credentials."""
import sys as _sys
from app.providers import credentials as _implementation
_sys.modules[__name__] = _implementation
