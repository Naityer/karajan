"""Compatibility import; implementation lives in app.resources.resource_library."""
import sys as _sys
from app.resources import resource_library as _implementation
_sys.modules[__name__] = _implementation
