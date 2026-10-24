"""Compatibility import; implementation lives in app.resources.curated_resources."""
import sys as _sys
from app.resources import curated_resources as _implementation
_sys.modules[__name__] = _implementation
