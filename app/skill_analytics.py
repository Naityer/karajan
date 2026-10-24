"""Compatibility import; implementation lives in app.resources.skill_analytics."""
import sys as _sys
from app.resources import skill_analytics as _implementation
_sys.modules[__name__] = _implementation
