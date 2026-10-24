"""Compatibility import; implementation lives in app.resources.nested_resources."""
import sys as _sys
from app.resources import nested_resources as _implementation
_sys.modules[__name__] = _implementation
