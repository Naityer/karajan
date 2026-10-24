"""Compatibility import; implementation lives in app.configuration.setup_status."""
import sys as _sys
from app.configuration import setup_status as _implementation
_sys.modules[__name__] = _implementation
