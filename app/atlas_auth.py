"""Compatibility import; implementation lives in app.security.atlas_auth."""
import sys as _sys
from app.security import atlas_auth as _implementation
_sys.modules[__name__] = _implementation
