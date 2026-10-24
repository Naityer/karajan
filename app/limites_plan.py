"""Compatibility import; implementation lives in app.configuration.limites_plan."""
import sys as _sys
from app.configuration import limites_plan as _implementation
_sys.modules[__name__] = _implementation
