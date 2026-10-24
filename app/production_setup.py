"""Compatibility import; implementation lives in app.configuration.production_setup."""
import sys as _sys
from app.configuration import production_setup as _implementation
_sys.modules[__name__] = _implementation
