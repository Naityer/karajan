from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone

LOG_LEVEL_ENV = "KARAJAN_LOG_LEVEL"
ROOT_LOGGER = "karajan"
_configured = False


class JsonFormatter(logging.Formatter):
    """One JSON object per line, with arbitrary structured context fields.

    Context is passed via `extra={"context": {...}}` so log lines stay
    machine-parseable for production monitoring instead of free-form strings.
    """

    def format(self, record: logging.LogRecord) -> str:
        payload: dict = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "event": record.getMessage(),
        }
        context = getattr(record, "context", None)
        if isinstance(context, dict):
            payload.update(context)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging() -> None:
    """Install the JSON handler on the `karajan` root logger once (idempotent)."""
    global _configured
    if _configured:
        return
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger(ROOT_LOGGER)
    root.handlers = [handler]
    root.setLevel(os.environ.get(LOG_LEVEL_ENV, "INFO").upper())
    root.propagate = False
    _configured = True


def get_logger(name: str) -> logging.Logger:
    configure_logging()
    return logging.getLogger(f"{ROOT_LOGGER}.{name}")


def log_event(logger: logging.Logger, level: int, event: str, **context) -> None:
    """Emit a structured event: a short machine-readable name plus context kv."""
    logger.log(level, event, extra={"context": context})
