"""Compatibility import; implementation lives in app.configuration.config."""
import sys as _sys
from app.configuration import config as _implementation
_sys.modules[__name__] = _implementation
