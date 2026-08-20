"""Modo add-on de Atlas: mismo runtime que standalone salvo la identidad —
`AtlasCapabilityIdentityProvider` verifica el JWT de capacidad que Atlas firma
por instalación, en vez del secreto compartido `KARAJAN_TOKEN`.

CORS se deja abierto a propósito: las peticiones reales las hace el backend de
Atlas por cuenta del iframe sandboxed (origen opaco, no puede ni sostener
cookies ni pasar CORS por sí mismo — ver `dashboard/static/atlas-relay.js`),
así que la política de CORS de este proceso no es la barrera de seguridad —
lo es `AtlasCapabilityIdentityProvider` + el proxy de Atlas.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI

from app.api.factory import create_app
from app.platform.persistence.sqlite import DEFAULT_DATA_DIR
from app.runtime import build_addon_runtime


def create_atlas_addon_app(data_dir: Path | str = DEFAULT_DATA_DIR) -> FastAPI:
    runtime = build_addon_runtime(data_dir)
    return create_app(runtime, title="KARAJAN (add-on de Atlas)")
