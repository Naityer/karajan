"""Compatibility import; implementation lives in app.routing.routing_rules."""
import sys as _sys
from app.routing import routing_rules as _implementation
_sys.modules[__name__] = _implementation
