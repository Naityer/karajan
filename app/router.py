"""Compatibility import; implementation lives in app.routing.router."""
import sys as _sys
from app.routing import router as _implementation
_sys.modules[__name__] = _implementation
