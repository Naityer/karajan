"""Compatibility import; implementation lives in app.resources.resource_sources."""
import sys as _sys
from app.resources import resource_sources as _implementation
_sys.modules[__name__] = _implementation
