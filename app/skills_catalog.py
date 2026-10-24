"""Compatibility import; implementation lives in app.resources.skills_catalog."""
import sys as _sys
from app.resources import skills_catalog as _implementation
_sys.modules[__name__] = _implementation
