"""Compatibility import; implementation lives in app.resources.inspiration_feed."""
import sys as _sys
from app.resources import inspiration_feed as _implementation
_sys.modules[__name__] = _implementation
