"""Compatibility import; implementation lives in app.resources.local_resources."""
import sys as _sys
from app.resources import local_resources as _implementation
_sys.modules[__name__] = _implementation
