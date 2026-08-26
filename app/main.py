"""Punto de entrada ASGI y factoría de la instalación standalone.

Tras la modularización (nota "Plan de mejora", §14-§17) este fichero ya no
contiene lógica de negocio: construye el `KarajanRuntime`, monta los routers
de cada módulo (`app/modules/*/api.py`) y sirve el dashboard estático. Cada
router resuelve sus propias dependencias (modelos, servicios, catálogos)
directamente — `main.py` no necesita importarlas para reenviarlas.

Las asignaciones `store = runtime.tasks`, `active_config = runtime.config`,
etc. son vistas de compatibilidad: un puñado de tests y `karajan_mcp`/scripts
todavía las referencian por nombre. Los endpoints ya no las usan — leen
`runtime.current()` en cada petición (ver cualquier `app/modules/*/api.py`).
"""

from __future__ import annotations

import asyncio
import hashlib
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from app import KARAJAN_VERSION
from app.env import load_project_env

load_project_env()

from app import events
from app.runtime import build_standalone_runtime, set_current as _set_current_runtime
from app.modules.agents import api as agents_api
from app.modules.configuration import api as configuration_api
from app.modules.decision import api as decision_api
from app.modules.inspiration import api as inspiration_api
from app.modules.monitoring import api as monitoring_api
from app.modules.shared import api as shared_api
from app.modules.tasks import api as tasks_api
from app.modules.v1 import api as v1_api
from app.logging_config import get_logger
from app.models import KarajanConfig

_loop: asyncio.AbstractEventLoop | None = None
_resource_refresh_task: asyncio.Task | None = None


@asynccontextmanager
async def _lifespan(_: FastAPI):
    global _loop, _resource_refresh_task
    _loop = asyncio.get_running_loop()
    events.set_loop(_loop)  # let sync routes publish SSE events onto this loop
    scheduler.start()
    _resource_refresh_task = asyncio.create_task(_resource_refresh_loop())
    try:
        yield
    finally:
        if _resource_refresh_task is not None:
            _resource_refresh_task.cancel()
            try:
                await _resource_refresh_task
            except asyncio.CancelledError:
                pass
            _resource_refresh_task = None
        await scheduler.stop()


app = FastAPI(
    title="KARAJAN AI Harness Router",
    version=KARAJAN_VERSION,
    description="Local harness for task classification, local/API delegation, and audit monitoring.",
    lifespan=_lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)

logger = get_logger("api")

# La instalación entera —almacenes, planificador, analizadores, configuración—
# la construye ahora `app/runtime.py`, no este módulo al importarse. Los nombres
# que siguen son **vistas** de ese runtime: se conservan mientras los endpoints
# vivan aquí (los tests sustituyen `main.store`, `main.layout_store` y
# `main.active_config`) y van desapareciendo según cada grupo de endpoints se
# muda a su router de módulo.
runtime = build_standalone_runtime()
_set_current_runtime(runtime)

store = runtime.tasks
layout_store = runtime.routing
active_config: KarajanConfig = runtime.config
scheduler = runtime.scheduler
STATIC_DIR = Path(__file__).resolve().parent.parent / "dashboard" / "static"

resource_store = runtime.resources
resource_analyzer = runtime.resource_analyzer
web_reference_analyzer = runtime.web_reference_analyzer
resource_installer = runtime.resource_installer
naityer_adapter = runtime.naityer_adapter
nested_resource_indexer = runtime.nested_resource_indexer
local_resource_analyzer = runtime.local_resource_analyzer
resource_ranking_engine = runtime.resource_ranking_engine
inspiration_feed = runtime.inspiration_feed
resource_refresh = runtime.resource_refresh



async def _resource_refresh_loop() -> None:
    """Run repository maintenance independently from the Inspiration browser view."""
    await asyncio.sleep(2)
    while True:
        try:
            await asyncio.to_thread(resource_refresh.run_due, limit=None)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("scheduled resource reanalysis failed")
        await asyncio.sleep(60 * 60)

# --- routers por módulo (nota "Plan de mejora", §17) ------------------------
# Cada vista del producto es un módulo con su propia API. `main.py` deja de
# ser el sitio donde viven los endpoints y pasa a ser quien los compone.
app.include_router(decision_api.router)
app.include_router(tasks_api.router)
app.include_router(monitoring_api.router)
app.include_router(agents_api.router)
app.include_router(inspiration_api.router)
app.include_router(configuration_api.router)
app.include_router(shared_api.router)
app.include_router(v1_api.router)

class _NoCacheStaticFiles(StaticFiles):
    """`StaticFiles` that always revalidates instead of trusting browser heuristics.

    `_static_asset_version()` below only busts the cache for `app.js`/`styles.css`
    referenced directly from `index.html`. Everything they import — `src/main.js`
    and every `src/modules/*.js` — is requested by its bare URL with no `?v=`,
    so a browser (or the pywebview/WebView2 control the desktop launcher uses)
    can go on serving a long-cached copy of an edited module for the lifetime
    of that browser profile, even after a plain reload. `Cache-Control: no-cache`
    forces a conditional GET on every request instead, so edits under `src/`
    take effect on the next reload without needing a full app restart. This
    still allows cheap 304s via the ETag/Last-Modified Starlette already sets.
    """

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/static", _NoCacheStaticFiles(directory=STATIC_DIR), name="static")


def _static_asset_version() -> str:
    """Fingerprint of the served JS/CSS, used to cache-bust static asset URLs.

    Without this, a browser (or the pywebview/WebView2 control the desktop
    launcher uses) can keep serving an old app.js/styles.css from its own
    cache even after the files on disk changed, because the URL never
    changes. Deriving the version from each file's mtime means the URL
    changes the moment the content does, with nothing to remember to bump.
    """
    parts = []
    for name in ("app.js", "styles.css"):
        path = STATIC_DIR / name
        if path.exists():
            parts.append(str(path.stat().st_mtime_ns))
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:10]


@app.get("/", include_in_schema=False)
def index() -> HTMLResponse:
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    html = re.sub(r"\?v=[\w.-]+", f"?v={_static_asset_version()}", html)
    return HTMLResponse(
        html,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )
