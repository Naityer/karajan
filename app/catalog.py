"""Compatibility import; implementation lives in app.providers.catalog."""
import sys as _sys
from app.providers import catalog as _implementation
_sys.modules[__name__] = _implementation
