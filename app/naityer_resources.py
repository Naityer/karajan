"""Compatibility import; implementation lives in app.resources.naityer_resources."""
import sys as _sys
from app.resources import naityer_resources as _implementation
_sys.modules[__name__] = _implementation
