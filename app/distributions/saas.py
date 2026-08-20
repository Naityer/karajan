"""Modo SaaS: un proceso, muchos workspaces, aislados por `WorkspaceContext`
sobre una única base Postgres (nota "Plan de mejora", §14-§15).

A diferencia de standalone/add-on (un `KarajanRuntime` fijo, construido una
vez al arrancar), aquí el runtime activo depende de QUIÉN llama: cada petición
autentica con `SaaSIdentityProvider`, resuelve su `WorkspaceContext` y activa
—vía `runtime.set_current()`, que ahora es un `ContextVar` seguro para
peticiones concurrentes (`app/runtime.py`)— el `KarajanRuntime` de ESE
workspace, nunca el de otro que esté en vuelo a la vez.

`_WorkspaceRuntimeCache` mantiene un runtime por workspace vivo en memoria
(evita reabrir el `TaskScheduler` en cada petición) — sin expulsión por
inactividad todavía: es una simplificación deliberada de esta primera pasada,
no un diseño terminado para producción a largo plazo con miles de workspaces.
"""

from __future__ import annotations

import asyncio
import threading

from fastapi import FastAPI, HTTPException, Request

from app.api.factory import create_app
from app.github_resources import GitHubResourceAnalyzer
from app.inspiration_feed import InspirationFeed
from app.local_resources import LocalResourceAnalyzer
from app.naityer_resources import NaityerAdapter
from app.nested_resources import NestedResourceIndexer
from app.platform.auth.identity import SaaSIdentityProvider
from app.platform.multitenancy import WorkspaceContext
from app.platform.persistence.postgres import (
    PostgresConfigRepository,
    PostgresResourceRepository,
    PostgresRoutingRepository,
    PostgresTaskRepository,
    ensure_schema,
    get_pool,
)
from app.resource_installer import SkillRepositoryManager
from app.resource_intelligence import ResourceRankingEngine
from app.resource_refresh import ResourceRefreshCoordinator
from app.runtime import KarajanRuntime, set_current
from app.scheduler import TaskScheduler
from app.web_references import WebReferenceAnalyzer
from app import events


class _WorkspaceRuntimeCache:
    """Un `KarajanRuntime` vivo por workspace, construido perezosamente."""

    def __init__(self, pool) -> None:
        self._pool = pool
        self._runtimes: dict[tuple[str, str], KarajanRuntime] = {}
        self._lock = threading.Lock()
        # Los analizadores no guardan estado por tenant (solo llaman a APIs
        # externas), así que uno solo por proceso basta y evita reabrir un
        # `httpx.Client` por workspace.
        self._resource_analyzer = GitHubResourceAnalyzer(summarizer=None)
        self._web_reference_analyzer = WebReferenceAnalyzer()
        self._local_resource_analyzer = LocalResourceAnalyzer()
        self._resource_ranking_engine = ResourceRankingEngine()
        self._inspiration_feed = InspirationFeed()

    def get(self, workspace: WorkspaceContext) -> KarajanRuntime:
        key = (workspace.tenant_id, workspace.workspace_id)
        with self._lock:
            runtime = self._runtimes.get(key)
            if runtime is not None:
                return runtime

            resources = PostgresResourceRepository(self._pool, workspace)
            tasks = PostgresTaskRepository(self._pool, workspace)
            runtime = KarajanRuntime(
                mode="saas",
                data_dir=None,  # sin directorio local: todo vive en Postgres
                tasks=tasks,
                routing=PostgresRoutingRepository(self._pool, workspace),
                resources=resources,
                config_repo=PostgresConfigRepository(self._pool, workspace),
                identity=SaaSIdentityProvider(),
                scheduler=TaskScheduler(store=tasks),
                resource_refresh=ResourceRefreshCoordinator(
                    resources,
                    self._resource_analyzer,
                    web_analyzer=self._web_reference_analyzer,
                    local_analyzer=self._local_resource_analyzer,
                    nested_indexer=NestedResourceIndexer(resources),
                    publish=events.publish,
                ),
                resource_analyzer=self._resource_analyzer,
                web_reference_analyzer=self._web_reference_analyzer,
                resource_installer=SkillRepositoryManager(resources),
                naityer_adapter=NaityerAdapter(resources),
                nested_resource_indexer=NestedResourceIndexer(resources),
                local_resource_analyzer=self._local_resource_analyzer,
                resource_ranking_engine=self._resource_ranking_engine,
                inspiration_feed=self._inspiration_feed,
            )
            self._runtimes[key] = runtime
            return runtime

    async def start_scheduler(self, runtime: KarajanRuntime) -> None:
        runtime.scheduler.start()  # ya es idempotente (no-op si _task no es None)


def create_saas_app(dsn: str | None = None) -> FastAPI:
    """Construye el `FastAPI` de Karajan en modo SaaS.

    A diferencia de `create_standalone_app`/`create_atlas_addon_app`, no hay
    UN runtime que activar en el lifespan — el middleware lo hace por
    petición. `create_app()` sigue montando los mismos 7 routers y sirviendo
    el dashboard estático; lo único distinto es cómo se resuelve
    `runtime.current()` en cada petición.
    """
    pool = get_pool(dsn)
    ensure_schema(pool)
    cache = _WorkspaceRuntimeCache(pool)

    # El runtime "por defecto" del lifespan nunca debería resolver una petición
    # real (el middleware siempre lo sustituye primero) — existe solo para que
    # `create_app` tenga algo que activar de fábrica al arrancar.
    from app.runtime import build_runtime

    bootstrap_runtime = build_runtime(mode="saas", identity=SaaSIdentityProvider())
    app = create_app(bootstrap_runtime, title="KARAJAN (SaaS)", serve_static=False)

    @app.middleware("http")
    async def bind_workspace_runtime(request: Request, call_next):
        identity: SaaSIdentityProvider = bootstrap_runtime.identity
        try:
            context = identity.authenticate(authorization=request.headers.get("authorization"))
        except HTTPException as exc:
            from fastapi.responses import JSONResponse

            return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

        workspace = WorkspaceContext.from_request_context(context)
        runtime = cache.get(workspace)
        await cache.start_scheduler(runtime)
        set_current(runtime)
        request.state.workspace = workspace
        request.state.request_context = context
        return await call_next(request)

    return app
