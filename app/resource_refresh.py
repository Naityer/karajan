"""Compatibility import; implementation lives in app.resources.resource_refresh."""
import sys as _sys
from app.resources import resource_refresh as _implementation
_sys.modules[__name__] = _implementation
