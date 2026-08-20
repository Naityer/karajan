"""`create_app(runtime)`: la única función que sabe montar un `FastAPI` de
Karajan (nota "Plan de mejora", §16). Antes de esto, `app/main.py` construía
la app *y* la instalación standalone en el mismo módulo, al importarse — no
había forma de pedir "esta misma API, pero con otro runtime" sin duplicar
~170 líneas de cableado (lifespan, CORS, `include_router` x7, estáticos).

`create_standalone_app()` / `create_atlas_addon_app()` / `create_saas_app()`
(en `app/distributions/`) son configuraciones distintas de esta misma
factoría — no tres implementaciones separadas.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
from collections.abc import Sequence
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from app import KARAJAN_VERSION, events
from app.logging_config import get_logger
from app.modules.agents import api as agents_api
from app.modules.configuration import api as configuration_api
from app.modules.decision import api as decision_api
from app.modules.inspiration import api as inspiration_api
from app.modules.monitoring import api as monitoring_api
from app.modules.shared import api as shared_api
from app.modules.tasks import api as tasks_api
from app.runtime import KarajanRuntime, set_current

logger = get_logger("api")

DEFAULT_STATIC_DIR = Path(__file__).resolve().parent.parent.parent / "dashboard" / "static"

_ROUTERS = (
    decision_api.router,
    tasks_api.router,
    monitoring_api.router,
    agents_api.router,
    inspiration_api.router,
    configuration_api.router,
    shared_api.router,
)


def _static_asset_version(static_dir: Path) -> str:
    """Fingerprint of the served JS/CSS, used to cache-bust static asset URLs.

    Without this, a browser (or the pywebview/WebView2 control the desktop
    launcher uses) can keep serving an old app.js/styles.css from its own
    cache even after the files on disk changed, because the URL never
    changes. Deriving the version from each file's mtime means the URL
    changes the moment the content does, with nothing to remember to bump.
    """
    parts = []
    for name in ("app.js", "styles.css"):
        path = static_dir / name
        if path.exists():
            parts.append(str(path.stat().st_mtime_ns))
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:10]


def _mount_dashboard(app: FastAPI, static_dir: Path) -> None:
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

    @app.get("/", include_in_schema=False)
    def index() -> HTMLResponse:
        html = (static_dir / "index.html").read_text(encoding="utf-8")
        html = re.sub(r"\?v=[\w.-]+", f"?v={_static_asset_version(static_dir)}", html)
        return HTMLResponse(
            html,
            headers={
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Expires": "0",
            },
        )


def _make_lifespan(runtime: KarajanRuntime):
    resource_refresh_task: asyncio.Task | None = None

    async def resource_refresh_loop() -> None:
        """Run repository maintenance independently from the Inspiration browser view."""
        await asyncio.sleep(2)
        while True:
            try:
                await asyncio.to_thread(runtime.resource_refresh.run_due, limit=None)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("scheduled resource reanalysis failed")
            await asyncio.sleep(60 * 60)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        nonlocal resource_refresh_task
        set_current(runtime)
        events.set_loop(asyncio.get_running_loop())  # let sync routes publish SSE events onto this loop
        runtime.scheduler.start()
        resource_refresh_task = asyncio.create_task(resource_refresh_loop())
        try:
            yield
        finally:
            if resource_refresh_task is not None:
                resource_refresh_task.cancel()
                try:
                    await resource_refresh_task
                except asyncio.CancelledError:
                    pass
                resource_refresh_task = None
            await runtime.scheduler.stop()

    return lifespan


def create_app(
    runtime: KarajanRuntime,
    *,
    title: str = "KARAJAN AI Harness Router",
    description: str = "Local harness for task classification, local/API delegation, and audit monitoring.",
    cors_origins: Sequence[str] = ("*",),
    serve_static: bool = True,
    static_dir: Path = DEFAULT_STATIC_DIR,
) -> FastAPI:
    """Construye el `FastAPI` de Karajan para una instalación ya construida.

    `set_current(runtime)` se llama tanto aquí (para que esté activo desde el
    primer `import`, como hoy) como dentro del lifespan (por si el proceso
    sirve más de un runtime a la vez — SaaS multi-tenant, ver
    `app/distributions/saas.py`). Los routers siempre son los mismos 7: lo que
    cambia entre standalone/add-on/SaaS es el runtime que hay detrás, no la
    superficie de la API.
    """
    set_current(runtime)

    app = FastAPI(
        title=title,
        version=KARAJAN_VERSION,
        description=description,
        lifespan=_make_lifespan(runtime),
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(cors_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["*"],
    )

    for router in _ROUTERS:
        app.include_router(router)

    if serve_static:
        _mount_dashboard(app, static_dir)

    return app
