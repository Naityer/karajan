"""Compatibility import; implementation lives in app.resources.resource_inventory."""
import sys as _sys
from app.resources import resource_inventory as _implementation
_sys.modules[__name__] = _implementation
