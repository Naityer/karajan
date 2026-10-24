"""Compatibility import; implementation lives in app.resources.resource_intelligence."""
import sys as _sys
from app.resources import resource_intelligence as _implementation
_sys.modules[__name__] = _implementation
