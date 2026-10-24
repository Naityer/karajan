"""Compatibility import; implementation lives in app.clients.local_client."""
import sys as _sys
from app.clients import local_client as _implementation
_sys.modules[__name__] = _implementation
