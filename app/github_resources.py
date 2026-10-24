"""Compatibility import; implementation lives in app.resources.github_resources."""
import sys as _sys
from app.resources import github_resources as _implementation
_sys.modules[__name__] = _implementation
