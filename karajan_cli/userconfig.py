"""Small per-user config file (`~/.karajan/config.json`) so `karajan activate
--start` can locate the repo from any directory after the first successful
activation, instead of only working from inside the Karajan repo.
"""

from __future__ import annotations

import json
from pathlib import Path

CONFIG_DIR = Path.home() / ".karajan"
CONFIG_FILE = CONFIG_DIR / "config.json"


def load() -> dict:
    if not CONFIG_FILE.exists():
        return {}
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def save(data: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def get_repo_root() -> Path | None:
    value = load().get("repo_root")
    return Path(value) if value else None


def remember_repo_root(path: Path) -> None:
    data = load()
    if data.get("repo_root") == str(path):
        return
    data["repo_root"] = str(path)
    save(data)
