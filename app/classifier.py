"""Compatibility import; implementation lives in app.routing.classifier."""
import sys as _sys
from app.routing import classifier as _implementation
_sys.modules[__name__] = _implementation
