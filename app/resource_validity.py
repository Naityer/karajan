"""Compatibility import; implementation lives in app.resources.resource_validity."""
import sys as _sys
from app.resources import resource_validity as _implementation
_sys.modules[__name__] = _implementation
