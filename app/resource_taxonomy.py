"""Compatibility import; implementation lives in app.resources.resource_taxonomy."""
import sys as _sys
from app.resources import resource_taxonomy as _implementation
_sys.modules[__name__] = _implementation
