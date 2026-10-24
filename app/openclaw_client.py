"""Compatibility import; implementation lives in app.clients.openclaw_client."""
import sys as _sys
from app.clients import openclaw_client as _implementation
_sys.modules[__name__] = _implementation
