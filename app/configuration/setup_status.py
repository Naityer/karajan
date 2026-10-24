from __future__ import annotations

from pathlib import Path

from app.env import PROJECT_ROOT
from app.tutorial import navigation_tutorial_markdown

# Dedicated marker, deliberately decoupled from data/active_config.json — a
# user who explicitly wants to keep the default config shouldn't have that
# read as "never onboarded" and get the first-run overlay again.
MARKER_PATH = PROJECT_ROOT / "data" / ".setup_complete"
TUTORIAL_PATH = PROJECT_ROOT / "docs" / "TUTORIAL_NAVEGACION.md"


def is_complete() -> bool:
    return MARKER_PATH.exists()


def mark_complete() -> Path:
    """Record that setup has run (terminal or web) and write the tutorial doc.

    Idempotent — safe to call again (e.g. the terminal installer runs after
    the web overlay already completed, or vice versa).
    """
    MARKER_PATH.parent.mkdir(parents=True, exist_ok=True)
    MARKER_PATH.write_text("ok\n", encoding="utf-8")
    return write_tutorial()


def write_tutorial() -> Path:
    TUTORIAL_PATH.parent.mkdir(parents=True, exist_ok=True)
    TUTORIAL_PATH.write_text(navigation_tutorial_markdown(), encoding="utf-8")
    return TUTORIAL_PATH
