from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from app.providers import catalog
from app.core.logging_config import get_logger, log_event
from app.domain.models import (
    ClassificationResult,
    DecisionLogEntry,
    DelegationResult,
    Metrics,
    MetricsHistory,
    MetricsHistoryPoint,
    TaskRecord,
    TaskStatus,
    TaskV2Status,
)

from .task_store_common import DEFAULT_DB_PATH, _DENORM_COLUMNS, _now_iso, _denorm_values, _group, logger

from .task_store_schema import SchemaMixin
from .task_store_runs import RunsMixin
from .task_store_writes import WritesMixin
from .task_store_queries import QueriesMixin


class TaskStore(SchemaMixin, RunsMixin, WritesMixin, QueriesMixin):
    def __init__(self, db_path: Path | str = DEFAULT_DB_PATH) -> None:
        self.db_path = Path(db_path)
        self._memory_uri: str | None = None
        self._memory_anchor: sqlite3.Connection | None = None
        if str(db_path) == ":memory:":
            self._memory_uri = f"file:karajan-{uuid4().hex}?mode=memory&cache=shared"
            self._memory_anchor = sqlite3.connect(self._memory_uri, uri=True)
        else:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
        # Flipped to False by `_init_fts` if this machine's sqlite3 lacks FTS5;
        # `search_tasks` reads it to decide FTS-MATCH vs. LIKE-scan fallback.
        self._fts_available = True
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            self._memory_uri or self.db_path,
            uri=self._memory_uri is not None,
            check_same_thread=False,
        )
        conn.row_factory = sqlite3.Row
        # WAL lets the dashboard read while a delegation writes, instead of
        # serializing behind a single lock; NORMAL keeps that safe and fast.
        # busy_timeout avoids spurious "database is locked" under contention.
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    def close(self) -> None:
        if self._memory_anchor is not None:
            self._memory_anchor.close()
            self._memory_anchor = None
