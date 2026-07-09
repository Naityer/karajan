"""Detect/start/wait-for-health logic for `karajan activate` (and any other
command that offers to bring the server up rather than just reporting it's down).
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

from karajan_cli import userconfig
from karajan_cli.client import KarajanClient

LAUNCH_HINTS = [
    'KARAJAN Desktop.bat  (doble clic, arranca en el puerto 8001)',
    'python desktop_app.py  (ventana nativa pywebview, elige un puerto libre)',
    '.venv\\Scripts\\python -m uvicorn app.main:app --host 127.0.0.1 --port 8001  (arranque manual)',
]


def _is_repo_root(path: Path) -> bool:
    return (path / "app" / "main.py").is_file()


def find_repo_root(start: Path | None = None) -> Path | None:
    """Locate the Karajan repo root so it can be launched from any directory.

    Tries, in order: walking up from `start` (default cwd) looking for
    `app/main.py`, then the path remembered in `~/.karajan/config.json` from a
    previous successful `activate` — this is what lets `karajan activate
    --start` work from inside *any* other repository once it has succeeded
    once from inside (or with `--repo` pointing at) the real Karajan repo.
    """
    current = (start or Path.cwd()).resolve()
    for candidate in (current, *current.parents):
        if _is_repo_root(candidate):
            return candidate
    remembered = userconfig.get_repo_root()
    if remembered and _is_repo_root(remembered):
        return remembered
    return None


def start_server(repo_root: Path, port: int) -> subprocess.Popen:
    """Launch `uvicorn app.main:app` with cwd=repo_root.

    cwd must be the repo root: `app/config.py`'s `RUNTIME_CONFIG_PATH` and
    `app/routing_layout.py`'s `DEFAULT_LAYOUT_PATH` resolve `data/*.json`
    relative to the process's working directory, not the package location.
    """
    return subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(repo_root),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def wait_for_health(client: KarajanClient, timeout_s: float) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if client.is_running():
            return True
        time.sleep(0.5)
    return client.is_running()
