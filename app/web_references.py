"""Compatibility import; implementation lives in app.resources.web_references."""
import sys as _sys
from app.resources import web_references as _implementation
_sys.modules[__name__] = _implementation
