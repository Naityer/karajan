"""Compatibility import; implementation lives in app.application.container."""
import sys as _sys
from app.application import container as _implementation
_sys.modules[__name__] = _implementation
