"""Compatibility import; implementation lives in app.resources.resource_activation."""
import sys as _sys
from app.resources import resource_activation as _implementation
_sys.modules[__name__] = _implementation
