from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

from app.models import RoutingLayout


DEFAULT_LAYOUT_PATH = Path("data/routing_layout.json")


class RoutingLayoutStore:
    def __init__(self, path: Path | str = DEFAULT_LAYOUT_PATH) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.backup_path = self.path.with_suffix(f"{self.path.suffix}.bak")

    def load(self) -> RoutingLayout:
        return self._load_path(self.path) or self._load_path(self.backup_path) or RoutingLayout()

    def _load_path(self, path: Path) -> RoutingLayout | None:
        """Read one layout file defensively.

        The diagram is autosaved from the browser. If a process dies mid-write
        or a previous version leaves null bytes behind, the API should not boot
        into a broken state. Invalid files are ignored and the caller can fall
        back to the backup or to the default empty layout.
        """
        if not path.exists():
            return None
        try:
            raw = path.read_text(encoding="utf-8")
            if not raw.strip() or "\x00" in raw:
                return None
            payload = json.loads(raw)
            return RoutingLayout.model_validate(payload)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValidationError):
            return None

    def save(self, layout: RoutingLayout) -> RoutingLayout:
        """Persist the diagram atomically and keep the previous file as backup."""
        saved = layout.model_copy(deep=True)
        saved.updated_at = datetime.now(timezone.utc)
        payload = saved.model_dump_json(indent=2)
        # Validate the exact bytes that will be written before touching disk.
        RoutingLayout.model_validate_json(payload)

        tmp_path = self.path.with_suffix(f"{self.path.suffix}.tmp")
        tmp_path.write_text(payload, encoding="utf-8")
        if not self.path.exists():
            tmp_path.replace(self.path)
            return saved

        try:
            shutil.copy2(self.path, self.backup_path)
            tmp_path.replace(self.path)
        finally:
            if tmp_path.exists():
                tmp_path.unlink()
        return saved
