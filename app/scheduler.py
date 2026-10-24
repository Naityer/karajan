"""Compatibility import; implementation lives in app.routing.scheduler."""
import sys as _sys
from app.routing import scheduler as _implementation
_sys.modules[__name__] = _implementation
