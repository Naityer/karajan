"""Compatibility import; implementation lives in app.security.auth."""
import sys as _sys
from app.security import auth as _implementation
_sys.modules[__name__] = _implementation
