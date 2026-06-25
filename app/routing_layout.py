from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from app.models import RoutingLayout


DEFAULT_LAYOUT_PATH = Path("data/routing_layout.json")


class RoutingLayoutStore:
    def __init__(self, path: Path | str = DEFAULT_LAYOUT_PATH) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def load(self) -> RoutingLayout:
        if not self.path.exists():
            return RoutingLayout()
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return RoutingLayout()
        return RoutingLayout.model_validate(payload)

    def save(self, layout: RoutingLayout) -> RoutingLayout:
        layout.updated_at = datetime.now(timezone.utc)
        self.path.write_text(layout.model_dump_json(indent=2), encoding="utf-8")
        return layout
