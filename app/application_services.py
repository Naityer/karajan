"""Compatibility import; implementation lives in app.application.services."""
import sys as _sys
from app.application import services as _implementation
_sys.modules[__name__] = _implementation
