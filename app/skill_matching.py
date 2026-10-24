"""Compatibility import; implementation lives in app.resources.skill_matching."""
import sys as _sys
from app.resources import skill_matching as _implementation
_sys.modules[__name__] = _implementation
