"""Modo producción de Karajan, del lado nativo (Python).

El paquete de Atlas dev (`atlas/src/modo.ts`) y este servidor leen el mismo
fichero, `<data_dir>/modo.json` (`{"modo": "produccion"}` o `{"modo":
"desarrollo"}`). En producción, las rutas que cambian la configuración
—perfiles, reglas, configuración activa, instalación de skills— exigen el id
de una tarea de Atlas dev ya aceptada (encolada o en marcha) en la cabecera
`x-karajan-tarea`; si no, responden 423. Así el servidor nativo y
`karajan_cli` no son una puerta trasera del modo.

Sin fichero, el nativo queda en desarrollo (instalaciones sueltas y tests);
el paquete escribe `modo.json` en producción al arrancar, y desde ahí manda.
El modo no se cambia por API: solo editando el fichero.
"""

from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path

from fastapi import HTTPException, Request

ACEPTADA = {"encolada", "ejecutando"}


def leer_modo(data_dir: Path | None) -> str:
    if data_dir is None:
        return "desarrollo"
    try:
        modo = json.loads((Path(data_dir) / "modo.json").read_text(encoding="utf-8")).get("modo")
    except FileNotFoundError:
        return "desarrollo"
    except (OSError, ValueError, AttributeError):
        return "produccion"
    return "desarrollo" if modo == "desarrollo" else "produccion"


def estado_tarea_atlas(tarea: str) -> str | None:
    """El estado de una tarea de la cola de Atlas dev, o None si no existe o no responde."""
    base = os.environ.get("ATLAS_DEV_API", "http://127.0.0.1:4100").rstrip("/")
    peticion = urllib.request.Request(f"{base}/operaciones/tareas/{tarea}")
    if os.environ.get("ATLAS_DEV_TOKEN"):
        peticion.add_header("x-atlas-dev-token", os.environ["ATLAS_DEV_TOKEN"])
    try:
        with urllib.request.urlopen(peticion, timeout=3) as respuesta:  # noqa: S310 - API local de Atlas dev
            return json.loads(respuesta.read()).get("tarea", {}).get("estado")
    except (OSError, ValueError):
        return None


def comprobar_tarea_aceptada(data_dir: Path | None, tarea: str = "") -> None:
    """Aplica la misma política de producción a adaptadores HTTP y embebidos."""
    if leer_modo(data_dir) == "desarrollo":
        return
    tarea = tarea.strip()
    if tarea and len(tarea) <= 40 and tarea.replace("-", "").replace("_", "").isalnum() and estado_tarea_atlas(tarea) in ACEPTADA:
        return
    raise HTTPException(
        status_code=423,
        detail=(
            "Karajan está en producción: este cambio necesita una tarea aceptada de Atlas dev "
            "(cabecera x-karajan-tarea). Propónlo desde el paquete (se abre como borrador) o acepta la tarea que lo pide."
        ),
    )


def require_tarea_aceptada(request: Request) -> None:
    """Dependencia FastAPI para las operaciones protegidas."""
    from app.application import runtime as runtime_module

    comprobar_tarea_aceptada(runtime_module.current().data_dir, request.headers.get("x-karajan-tarea") or "")
