"""Compatibility import; implementation lives in app.resources.resource_installer."""
import sys as _sys
from app.resources import resource_installer as _implementation
_sys.modules[__name__] = _implementation
