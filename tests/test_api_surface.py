"""Contrato congelado de la superficie HTTP.

La modularización de Karajan (nota "Plan de mejora", §17) mueve ~90 endpoints
desde `app/main.py` a routers por módulo. Mover rutas es exactamente el tipo de
refactor donde una se queda por el camino, cambia de método o pierde su
`response_model` sin que ningún test lo note: los tests existentes cubren
comportamiento, no *inventario*.

Este test es el inventario. Compara la superficie viva contra
`tests/fixtures/api_surface.json`; cualquier alta, baja o cambio de firma falla
con el diff exacto.

Cuando el cambio es intencionado (endpoint nuevo, retirada deliberada), se
regenera la instantánea:

    KARAJAN_UPDATE_API_SURFACE=1 pytest tests/test_api_surface.py

y el diff queda revisable en el commit, que es justo lo que se quiere.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, get_args, get_origin

from fastapi.routing import APIRoute
from starlette.routing import Mount, Route

from app.main import app

FIXTURE = Path(__file__).parent / "fixtures" / "api_surface.json"

# `HEAD`/`OPTIONS` los añade Starlette sola; incluirlos solo añadiría ruido.
IMPLICIT_METHODS = {"HEAD", "OPTIONS"}


def _model_name(model: Any) -> str | None:
    """Nombre estable del `response_model`.

    `list[TaskRecord].__name__` es solo `"list"` en 3.10+, y perder el tipo del
    contenido dejaría pasar justo el error que este test busca (una lista que
    cambia de modelo al mudarse de fichero), así que los genéricos se
    reconstruyen a mano.
    """
    if model is None:
        return None
    origin = get_origin(model)
    if origin is not None:
        args = ", ".join(_model_name(arg) or "None" for arg in get_args(model))
        return f"{_model_name(origin)}[{args}]"
    name = getattr(model, "__name__", None)
    return name or str(model).replace("typing.", "")


def _walk(routes: Any, prefix: str = "") -> list[dict[str, Any]]:
    """Aplana las rutas de la app, entrando en los routers incluidos.

    FastAPI 0.139 no fusiona un `include_router` dentro de `app.routes`: mete un
    `_IncludedRouter` que envuelve al router original. Recorrer solo el primer
    nivel haría que este test diese por desaparecida cada ruta que se mueve a un
    módulo — justo lo contrario de lo que debe vigilar.
    """
    rows: list[dict[str, Any]] = []
    for route in routes:
        included = getattr(route, "original_router", None)
        if included is not None:
            context = getattr(route, "include_context", None)
            rows.extend(_walk(included.routes, prefix + (getattr(context, "prefix", "") or "")))
        elif isinstance(route, APIRoute):
            rows.append(
                {
                    "kind": "route",
                    "path": prefix + route.path,
                    "methods": sorted(set(route.methods) - IMPLICIT_METHODS),
                    "response_model": _model_name(route.response_model),
                }
            )
        elif isinstance(route, Mount):
            rows.append({"kind": "mount", "path": prefix + route.path, "name": route.name})
        elif isinstance(route, Route):  # rutas Starlette sueltas (p.ej. redirecciones)
            rows.append(
                {
                    "kind": "starlette",
                    "path": prefix + route.path,
                    "methods": sorted(set(route.methods or ()) - IMPLICIT_METHODS),
                }
            )
    return rows


def current_surface() -> list[dict[str, Any]]:
    return sorted(_walk(app.routes), key=lambda row: (row["path"], str(row.get("methods", ""))))


def test_api_surface_is_unchanged() -> None:
    surface = current_surface()

    if os.environ.get("KARAJAN_UPDATE_API_SURFACE") in ("1", "true", "True"):
        FIXTURE.write_text(json.dumps(surface, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    assert FIXTURE.exists(), (
        "falta la instantánea de la API; genérala con "
        "KARAJAN_UPDATE_API_SURFACE=1 pytest tests/test_api_surface.py"
    )
    expected = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def key(row: dict[str, Any]) -> str:
        return f"{row['path']} [{','.join(row.get('methods') or [])}]"

    live = {key(row): row for row in surface}
    frozen = {key(row): row for row in expected}

    missing = sorted(frozen.keys() - live.keys())
    added = sorted(live.keys() - frozen.keys())
    changed = sorted(k for k in live.keys() & frozen.keys() if live[k] != frozen[k])

    assert not missing, f"rutas que han desaparecido: {missing}"
    assert not added, f"rutas nuevas sin registrar en la instantánea: {added}"
    assert not changed, f"rutas con firma distinta: {[(k, frozen[k], live[k]) for k in changed]}"
