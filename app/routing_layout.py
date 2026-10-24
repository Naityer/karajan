"""Compatibility import; implementation lives in app.routing.routing_layout."""
import sys as _sys
from app.routing import routing_layout as _implementation
_sys.modules[__name__] = _implementation
