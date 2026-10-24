"""Compatibility import; implementation lives in app.routing.flow_policy."""
import sys as _sys
from app.routing import flow_policy as _implementation
_sys.modules[__name__] = _implementation
