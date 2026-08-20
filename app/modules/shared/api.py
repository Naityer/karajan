"""API del módulo Shared.

Endpoints transversales que no pertenecen a una sola vista: el stream de eventos en vivo, el health-check y el ciclo de vida de los paquetes de contexto (handoff).

Movida tal cual desde `app/main.py` (nota "Plan de mejora", §17): mismas
rutas, mismos modelos de respuesta, mismas guardas de autenticación. Lo
único que cambia es que el almacén y los servicios ya no son globals del
módulo `main` — se resuelven contra el runtime activo en cada petición.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os

from app import (
    agent_tools,
    events,
    handoff,
)
from app.atlas_auth import require_atlas_token
from app.auth import (
    TOKEN_ENV_VAR,
    require_token,
)
from app.logging_config import log_event
from app.models import (
    ContextPackDetail,
    ContextPackRequest,
    ContextPackSummary,
    DocResultRequest,
    HealthStatus,
)
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
)
from fastapi.responses import StreamingResponse

from app import KARAJAN_VERSION
from app import runtime as runtime_module
from app.logging_config import get_logger, log_event
from app.modules.agents.manifest import MANIFEST as _agents_manifest
from app.modules.configuration.manifest import MANIFEST as _configuration_manifest
from app.modules.decision.manifest import MANIFEST as _decision_manifest
from app.modules.inspiration.manifest import MANIFEST as _inspiration_manifest
from app.modules.monitoring.manifest import MANIFEST as _monitoring_manifest
from app.modules.shared.manifest import MANIFEST as _shared_manifest
from app.modules.tasks.manifest import MANIFEST as _tasks_manifest


logger = get_logger("api")
router = APIRouter(tags=["shared"])

# Los 7 manifiestos de módulo (nota "Plan de mejora", §10/§24), agregados aquí
# y no en `app/core/module.py`: ese módulo no puede importar `app.modules.*`
# sin crear un ciclo (cada módulo ya importa `app.core.module`).
_MODULE_MANIFESTS = (
    _decision_manifest,
    _tasks_manifest,
    _monitoring_manifest,
    _agents_manifest,
    _inspiration_manifest,
    _configuration_manifest,
    _shared_manifest,
)

# Mismo índice de vistas que `atlas/apps/web/src/features/addons/adapters/karajan.adapter.ts`
# y `atlas/packaging/karajan.pack.json` — publicarlo aquí es lo que le permite a
# `EmbeddedAddonAdapter.fetchManifest()` dejar de depender de esas dos copias
# estáticas en el repo de Atlas (ver su docstring: "el add-on aporta... vistas").
_ATLAS_VIEWS = (
    {"id": "human", "label": "Control humano", "icon": "UserCheck"},
    {"id": "monitor", "label": "Estadísticas", "icon": "Activity"},
    {"id": "decision", "label": "Decisión", "icon": "GitBranch"},
    {"id": "agents", "label": "Agentes", "icon": "Bot"},
    {"id": "resources", "label": "Inspiration", "icon": "Sparkles"},
    {"id": "flow", "label": "Configuración", "icon": "Settings"},
)


@router.get("/manifest", include_in_schema=False)
def manifest() -> dict:
    """Manifiesto agregado: módulos, rutas y objetos UI de esta instalación.

    Espejo backend de `window.karajan.manifest`
    (`dashboard/static/src/registry-bootstrap.js`): un host puede leer esta
    ruta sin arrancar el dashboard para saber qué hay montable.
    """
    return {
        "id": "karajan",
        "version": KARAJAN_VERSION,
        "modules": [m.to_dict() for m in _MODULE_MANIFESTS],
        "modes": ["standalone", "addon", "saas"],
    }


@router.get("/atlas-addon.json", include_in_schema=False)
def atlas_addon_manifest() -> dict:
    """Manifiesto en la forma que `EmbeddedAddonAdapter.fetchManifest()` de
    Atlas ya sabe leer (`AddonManifest`: id/version/views/objects) — una lista
    plana, no la agrupación por módulo de `/manifest`.
    """
    objects = [obj.to_dict() for module in _MODULE_MANIFESTS for obj in module.objects]
    return {
        "id": "karajan",
        "name": "Karajan",
        "version": KARAJAN_VERSION,
        "icon": "Workflow",
        "views": [dict(view) for view in _ATLAS_VIEWS],
        "objects": objects,
    }


@router.get("/events", include_in_schema=False)
async def events_stream() -> StreamingResponse:
    """Server-Sent Events stream that pushes live "something changed" signals.

    The dashboard opens one `EventSource` and refreshes the affected view the
    instant a task/config change is published, instead of waiting for the
    fallback poll. A 15s heartbeat keeps the
    connection (and any proxy) from timing out; `EventSource` auto-reconnects.
    """
    queue = events.subscribe()

    async def generator():
        try:
            yield "retry: 3000\n\n"  # client reconnect backoff
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"data: {json.dumps(payload)}\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            events.unsubscribe(queue)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # disable proxy buffering so events flush
        },
    )


@router.get("/health", response_model=HealthStatus)
def health() -> HealthStatus:
    """Cheap probe for production monitoring: DB reachability + active profile."""
    db_ok = True
    total = 0
    try:
        total = runtime_module.current().tasks.count_tasks()
    except Exception as exc:  # noqa: BLE001 - any DB failure means not-ready
        db_ok = False
        log_event(logger, logging.ERROR, "health_db_error", error=f"{type(exc).__name__}: {exc}")
    return HealthStatus(
        status="ok" if db_ok else "degraded",
        version=KARAJAN_VERSION,
        backend=runtime_module.current().config.backend.value,
        profile=runtime_module.current().config.profile.value,
        auth_enabled=bool(os.environ.get(TOKEN_ENV_VAR)),
        db_ok=db_ok,
        total_tasks=total,
    )


def _pack_detail(pack, *, status: str) -> ContextPackDetail:
    return ContextPackDetail(
        id=pack.id,
        task_id=pack.task_id,
        prompt=pack.prompt,
        created_at=pack.created_at,
        files=len([item for item in pack.files if item.skipped_reason is None]),
        total_chars=pack.total_chars,
        status=status,
        workspace_root=pack.workspace_root,
        rationale=pack.rationale,
        markdown=handoff.read_markdown(pack.id) or "",
        skipped=[f"{item.path}: {item.skipped_reason}" for item in pack.files if item.skipped_reason],
        result_markdown=handoff.read_result(pack.id),
    )


@router.post("/handoff/packs", response_model=ContextPackDetail)
def create_context_pack(
    request: ContextPackRequest, _: None = Depends(require_token), __: dict | None = Depends(require_atlas_token)
) -> ContextPackDetail:
    """Package the selected files for an external chat (ChatGPT / Claude).

    The selection is re-resolved through the workspace guards rather than
    trusted: it came from a model, and the containment and secret rules must
    hold on the way *out* too — this content is about to be pasted into a
    third-party chat.
    """
    plan = agent_tools.plan(
        runtime_module.current().config, requested_workspace=request.workspace_root, requested_profile="doc"
    )
    if plan.workspace is None:
        raise HTTPException(status_code=422, detail=plan.reason or "sin raiz de trabajo utilizable")

    pack = handoff.build_pack(
        plan.workspace, request.task_id, request.prompt, request.paths, rationale=request.rationale
    )
    if not any(item.skipped_reason is None for item in pack.files):
        raise HTTPException(
            status_code=422,
            detail="ninguno de los archivos seleccionados se pudo incluir: "
            + "; ".join(f"{i.path}: {i.skipped_reason}" for i in pack.files),
        )
    handoff.save_pack(pack, runtime_module.current().tasks)
    events.publish("task_changed", task_id=request.task_id)
    return _pack_detail(pack, status="pending")


@router.get("/handoff/packs", response_model=list[ContextPackSummary])
def list_context_packs(
    status: str | None = Query(default=None, pattern="^(pending|ready)$")
) -> list[ContextPackSummary]:
    """Newest-first packs. `status=ready` is what Atlas polls for documents to accept."""
    items = handoff.list_packs()
    if status:
        items = [item for item in items if item["status"] == status]
    return [ContextPackSummary(**item) for item in items]


@router.get("/handoff/packs/{pack_id}", response_model=ContextPackDetail)
def get_context_pack(pack_id: str) -> ContextPackDetail:
    pack = handoff.load_pack(pack_id)
    if pack is None:
        raise HTTPException(status_code=404, detail="context pack not found")
    return _pack_detail(pack, status="ready" if handoff.read_result(pack_id) else "pending")


@router.post("/handoff/packs/{pack_id}/result", response_model=ContextPackDetail)
def submit_doc_result(
    pack_id: str, request: DocResultRequest, _: None = Depends(require_token), __: dict | None = Depends(require_atlas_token)
) -> ContextPackDetail:
    """Ingest the answer pasted back from the web chat."""
    pack = handoff.load_pack(pack_id)
    if pack is None:
        raise HTTPException(status_code=404, detail="context pack not found")
    handoff.save_result(pack_id, pack.task_id, request.markdown, runtime_module.current().tasks)
    events.publish("task_changed", task_id=pack.task_id)
    return _pack_detail(pack, status="ready")
