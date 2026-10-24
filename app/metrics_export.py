"""Compatibility import; implementation lives in app.execution.metrics_export."""
import sys as _sys
from app.execution import metrics_export as _implementation
_sys.modules[__name__] = _implementation
