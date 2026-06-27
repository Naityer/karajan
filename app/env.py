from __future__ import annotations

import os
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = PROJECT_ROOT / ".env"


DEFAULT_ENV = """# KARAJAN local environment
# Leave KARAJAN_TOKEN empty to keep local mutation auth disabled.
KARAJAN_TOKEN=
KARAJAN_LOG_LEVEL=INFO

# Optional provider keys:
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# GOOGLE_API_KEY=
# GEMINI_API_KEY=
# GROQ_API_KEY=
# DEEPSEEK_API_KEY=
# ZAI_API_KEY=
# TOGETHER_API_KEY=
# OPENROUTER_API_KEY=
# HF_TOKEN=
# MOONSHOT_API_KEY=
# MISTRAL_API_KEY=
"""


def ensure_project_env(path: Path = ENV_FILE) -> None:
    """Create a safe local .env with no secrets when it is missing."""
    if not path.exists():
        path.write_text(DEFAULT_ENV, encoding="utf-8")


def load_project_env(path: Path = ENV_FILE) -> None:
    """Load simple KEY=VALUE lines from .env without overriding real env vars."""
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value
