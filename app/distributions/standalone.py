"""Modo standalone: un operador, un directorio de datos, sin Atlas delante.

Es el comportamiento de siempre — `app/main.py` es ahora un `create_app`
llamado desde aquí, no al revés.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI

from app.api.factory import create_app
from app.platform.persistence.sqlite import DEFAULT_DATA_DIR
from app.runtime import build_standalone_runtime


def create_standalone_app(data_dir: Path | str = DEFAULT_DATA_DIR) -> FastAPI:
    runtime = build_standalone_runtime(data_dir)
    return create_app(runtime)
