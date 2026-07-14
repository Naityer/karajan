from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import threading
import uuid
from collections.abc import Callable
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from app.env import load_project_env

load_project_env()

from app import (
    agent_console,
    catalog,
    classifier,
    config as config_module,
    credentials,
    delegation,
    events,
    metrics_export,
    monitoring,
    openclaw_client,
    production_setup,
    routing_layout,
    scheduler as scheduler_module,
    setup_status,
    skills_catalog,
)
from app.auth import TOKEN_ENV_VAR, require_token
from app.logging_config import get_logger, log_event
from app.providers.registry import resolve_by_name, resolve_entity
from app.models import ClassificationResult
from app.database import TaskStore
from app.graph_store import GraphStore, safe_resolve
from app.analysis import scanner as graph_scanner
from app.analysis import audit as graph_audit
from app.analytics import duckdb_ops
from app.analytics import ml as ml_ops
from app.analytics.duckdb_ops import AnalyticsUnavailable
from app.tutorial import navigation_tutorial_markdown
from app.models import (
    AgentPerformance,
    CredentialStatus,
    DecisionLogEntry,
    DefaultConfigApplyResult,
    DelegationRequest,
    HealthStatus,
    IngestRequest,
    KarajanConfig,
    Metrics,
    MetricsHistory,
    OpenClawChannelInfo,
    OpenClawDaemonStatus,
    OpenClawInstallRequest,
    OpenClawOperationResult,
    OpenClawPluginInfo,
    OpenClawPluginInstallRequest,
    OpenClawSetupCommand,
    OpenClawSkillInfo,
    OpenClawStatus,
    OpenClawUpdateRequest,
    PredictTaskRequest,
    PredictTaskResponse,
    AuditRequest,
    AuditResult,
    ExplainRequest,
    ExplainResult,
    FixFindingRequest,
    FixFindingResult,
    FixJobStarted,
    FixJobStatus,
    Finding,
    GraphSnapshot,
    ObservabilitySnapshot,
    ProviderInfo,
    ProviderRunRequest,
    ProviderRunResult,
    ProviderSetup,
    RecommendedModel,
    RepoConfig,
    RepoCreateRequest,
    RepoFileResponse,
    RepoFileSaveRequest,
    RepoFileSaveResponse,
    ScanSummary,
    RoutingLayout,
    SetupStatus,
    SetupTutorial,
    SkillInfo,
    SkillInstallResult,
    TaskRecord,
    TaskRequest,
    TaskStatus,
)

_loop: asyncio.AbstractEventLoop | None = None


@asynccontextmanager
async def _lifespan(_: FastAPI):
    global _loop
    _loop = asyncio.get_running_loop()
    events.set_loop(_loop)  # let sync routes publish SSE events onto this loop
    scheduler.start()
    try:
        yield
    finally:
        await scheduler.stop()


app = FastAPI(
    title="KARAJAN AI Harness Router",
    version="0.2.0",
    description="Local harness for task classification, real/local/simulated delegation, and audit monitoring.",
    lifespan=_lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT"],
    allow_headers=["*"],
)

logger = get_logger("api")
store = TaskStore()
graph_store = GraphStore()
layout_store = routing_layout.RoutingLayoutStore()
active_config: KarajanConfig = config_module.load_config()
scheduler = scheduler_module.TaskScheduler(store=store)
STATIC_DIR = Path(__file__).resolve().parent.parent / "dashboard" / "static"

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def _static_asset_version() -> str:
    """Fingerprint of the served JS/CSS, used to cache-bust static asset URLs.

    Without this, a browser (or the pywebview/WebView2 control the desktop
    launcher uses) can keep serving an old app.js/styles.css from its own
    cache even after the files on disk changed, because the URL never
    changes. Deriving the version from each file's mtime means the URL
    changes the moment the content does, with nothing to remember to bump.
    """
    parts = []
    for name in ("app.js", "styles.css", "graph.html"):
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


@app.get("/events", include_in_schema=False)
async def events_stream() -> StreamingResponse:
    """Server-Sent Events stream that pushes live "something changed" signals.

    The dashboard (and the Grafo iframe) open one `EventSource` and refresh the
    affected view the instant a scan/audit/task/config change is published,
    instead of waiting for the fallback poll. A 15s heartbeat keeps the
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


@app.post("/classify-task", response_model=TaskRecord)
def classify_task(request: TaskRequest, _: None = Depends(require_token)) -> TaskRecord:
    classification = classifier.classify(request.prompt, active_config)
    decision = monitoring.build_classify_decision(classification)
    record = store.save_classification(classification, decision)
    events.publish("task_changed", task_id=record.task_id)
    return record


@app.post("/ingest", response_model=TaskRecord)
def ingest(request: IngestRequest, _: None = Depends(require_token)) -> TaskRecord:
    """Ingest a classification produced by the model in its own console (/karajan).

    The model is the parent router; KARAJAN reconciles the numeric routing
    deterministically and persists it for monitoring/audit.
    """
    classification = classifier.reconcile(
        request.model_dump(exclude_none=True), active_config, source="model:/karajan"
    )
    decision = monitoring.build_classify_decision(classification)
    record = store.save_classification(classification, decision)
    events.publish("task_changed", task_id=record.task_id)
    return record


@app.post("/tasks/{task_id}/decisions", response_model=DecisionLogEntry)
def append_decision(task_id: str, entry: DecisionLogEntry, _: None = Depends(require_token)) -> DecisionLogEntry:
    """Append a real execution decision reported by the model (live audit trail)."""
    try:
        store.get_task(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="task not found") from exc
    entry.task_id = task_id
    store.add_decisions([entry])
    return entry


def _spent_today() -> float:
    """Sum estimated cost of tasks delegated today (UTC), for the daily budget gate."""
    today = datetime.now(timezone.utc).date()
    total = 0.0
    for record in store.list_tasks():
        if record.delegation and record.updated_at.date() == today:
            total += record.delegation.total_estimated_cost_usd
    return round(total, 5)


def _enforce_daily_budget(classification: ClassificationResult) -> None:
    """Block delegation up front when it would push today's spend over the cap."""
    cap = active_config.orchestration.max_daily_cost_usd
    if not cap:
        return
    estimated = delegation.estimate_task_cost(classification, active_config)
    spent = _spent_today()
    if spent + estimated > cap:
        log_event(
            logger,
            logging.WARNING,
            "daily_budget_blocked",
            task_id=classification.task_id,
            spent=spent,
            estimated=estimated,
            cap=cap,
        )
        store.add_decisions(
            [
                DecisionLogEntry(
                    task_id=classification.task_id,
                    phase="validate",
                    decision=f"daily_budget=blocked;spent={spent};estimated={estimated};cap={cap}",
                    reason="Daily cost budget would be exceeded; execution withheld.",
                )
            ]
        )
        raise HTTPException(
            status_code=409,
            detail=f"daily budget {cap} would be exceeded (spent={spent}, estimated={estimated})",
        )


@app.post("/delegate-task", response_model=TaskRecord)
def delegate_task(request: DelegationRequest, _: None = Depends(require_token)) -> TaskRecord:
    """Delegate a classified task. `force_provider`/`force_entity_id` bypass the
    tier-based routing to force the whole task onto one named catalog provider
    or routing entity (the CLI/MCP "assign to a specific agent" command) — not
    supported under `dispatch_mode="queue"`, whose async scheduler has no hook
    for a caller-supplied resolution.
    """
    try:
        record = store.get_task(request.task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="task not found") from exc

    _enforce_daily_budget(record.classification)

    if request.force_provider or request.force_entity_id:
        if request.force_provider and request.force_entity_id:
            raise HTTPException(status_code=400, detail="pass only one of force_provider or force_entity_id")
        if active_config.orchestration.dispatch_mode == "queue":
            raise HTTPException(
                status_code=400,
                detail="force_provider/force_entity_id is not supported with dispatch_mode=queue",
            )
        layout = layout_store.load()
        tier = record.classification.subtasks[0].recommended_model
        if request.force_entity_id:
            entity = next((e for e in layout.entities if e.id == request.force_entity_id), None)
            if entity is None:
                raise HTTPException(status_code=404, detail=f"routing entity '{request.force_entity_id}' not found")
            preresolved = resolve_entity(entity, tier)
        else:
            preresolved = resolve_by_name(request.force_provider, tier)
        if preresolved is None:
            raise HTTPException(
                status_code=422,
                detail="target provider/entity is unknown to the catalog or doesn't support this task's tier",
            )
        result, decisions = delegation.delegate(
            record.classification, active_config, layout=layout, store=store, preresolved=preresolved
        )
        saved = store.save_delegation(result, decisions)
        events.publish("task_changed", task_id=request.task_id)
        return saved

    if active_config.orchestration.dispatch_mode == "queue":
        store.mark_status(request.task_id, TaskStatus.QUEUED)
        layout = layout_store.load()
        assert _loop is not None, "scheduler event loop not started yet"
        future = asyncio.run_coroutine_threadsafe(
            scheduler.enqueue(record.classification, active_config, layout), _loop
        )
        future.result(timeout=5)
        events.publish("task_changed", task_id=request.task_id)
        return store.get_task(request.task_id)

    result, decisions = delegation.delegate(
        record.classification, active_config, layout=layout_store.load(), store=store
    )
    saved = store.save_delegation(result, decisions)
    events.publish("task_changed", task_id=request.task_id)
    return saved


@app.get("/queue/status")
def queue_status(_: None = Depends(require_token)) -> dict:
    """Pending depth and live per-agent availability, for the `queue` dispatch mode."""
    availability = {
        entity_id: {"in_flight": in_flight, "capacity": capacity}
        for entity_id, (in_flight, capacity) in scheduler.availability.snapshot().items()
    }
    return {"pending": scheduler.queue_depth(), "availability": availability}


@app.get("/tasks", response_model=list[TaskRecord])
def list_tasks(
    limit: int | None = Query(default=None, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[TaskRecord]:
    """Newest-first task history. Pass `limit`/`offset` to paginate large logs."""
    return store.list_tasks(limit=limit, offset=offset)


@app.get("/tasks/{task_id}", response_model=TaskRecord)
def get_task(task_id: str) -> TaskRecord:
    try:
        return store.get_task(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="task not found") from exc


@app.get("/tasks/{task_id}/decisions", response_model=list[DecisionLogEntry])
def task_decisions(task_id: str) -> list[DecisionLogEntry]:
    return store.list_decisions(task_id)


@app.post("/tasks/{task_id}/approve-review", response_model=TaskRecord)
def approve_review(task_id: str, _: None = Depends(require_token)) -> TaskRecord:
    """Lift the human-review gate and actually run the previously withheld task.

    Execution happens *after* approval, so a critical task spends nothing on real
    backends until a human signs off.
    """
    try:
        record = store.get_task(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="task not found") from exc
    if not record.classification.requires_human_review:
        raise HTTPException(status_code=400, detail="task does not require human review")

    approval = DecisionLogEntry(
        task_id=task_id,
        phase="validate",
        decision="human_review_gate=approved",
        reason="Approved from KARAJAN monitor; releasing withheld execution.",
    )
    result, decisions = delegation.delegate(
        record.classification,
        active_config,
        human_approved=True,
        layout=layout_store.load(),
        store=store,
    )
    saved = store.save_delegation(result, [approval, *decisions])
    events.publish("task_changed", task_id=task_id)
    return saved


@app.get("/health", response_model=HealthStatus)
def health() -> HealthStatus:
    """Cheap probe for production monitoring: DB reachability + active profile."""
    db_ok = True
    total = 0
    try:
        total = store.count_tasks()
    except Exception as exc:  # noqa: BLE001 - any DB failure means not-ready
        db_ok = False
        log_event(logger, logging.ERROR, "health_db_error", error=f"{type(exc).__name__}: {exc}")
    return HealthStatus(
        status="ok" if db_ok else "degraded",
        version=app.version,
        backend=active_config.backend.value,
        profile=active_config.profile.value,
        auth_enabled=bool(os.environ.get(TOKEN_ENV_VAR)),
        db_ok=db_ok,
        total_tasks=total,
    )


@app.get("/metrics", response_model=Metrics)
def metrics() -> Metrics:
    return store.metrics()


@app.get("/agents/performance", response_model=list[AgentPerformance])
def agents_performance() -> list[AgentPerformance]:
    """Provider-keyed cost/latency/error aggregation from `runs` (Fase 1).

    The stable, SQL-`GROUP BY provider_name` replacement for the old fuzzy
    model-name/level-alias attribution in `monitoring._execution_owner()`.
    """
    return store.agent_performance()


# --- Search & analytics (Fase 3) — read-only, no auth ---------------------


@app.get("/search/tasks")
def search_tasks(q: str = Query(default="", description="full-text query"), limit: int = Query(default=20, ge=1, le=100)) -> dict:
    """FTS5 full-text search over tasks (title/summary/tags/task_type/full prompt).

    Ranked by bm25 when FTS5 is available, with a transparent LIKE fallback.
    """
    try:
        results = store.search_tasks(q, limit=limit)
    except Exception as exc:  # noqa: BLE001 - never 500 on a search query
        log_event(logger, logging.WARNING, "search_tasks_error", error=f"{type(exc).__name__}: {exc}")
        results = []
    return {"query": q, "count": len(results), "results": results}


@app.get("/analytics/dashboard")
def analytics_dashboard(days: int = Query(default=30, ge=1, le=365)) -> dict:
    """Richer DuckDB analytics (cost/latency trends, percentiles, leaderboards).

    Additive to `/agents/performance`. If DuckDB (an optional extra) is not
    installed, returns `{"available": false, "reason": ...}` with a 200 so the
    frontend can show a friendly "analytics unavailable" state, never a 500.
    """
    try:
        return duckdb_ops.dashboard(days=days)
    except AnalyticsUnavailable as exc:
        return {"available": False, "reason": str(exc)}
    except Exception as exc:  # noqa: BLE001 - degrade instead of 500 on any analytics error
        log_event(logger, logging.WARNING, "analytics_dashboard_error", error=f"{type(exc).__name__}: {exc}")
        return {"available": False, "reason": f"{type(exc).__name__}: {exc}"}


@app.get("/metrics/prometheus", response_class=PlainTextResponse, include_in_schema=False)
def metrics_prometheus() -> PlainTextResponse:
    """Same KPIs as `/metrics`, in Prometheus text format for external scrapers."""
    db_up = True
    try:
        snapshot = store.metrics()
    except Exception as exc:  # noqa: BLE001 - expose scrape-time DB failure as db_up=0
        db_up = False
        log_event(logger, logging.ERROR, "prometheus_db_error", error=f"{type(exc).__name__}: {exc}")
        snapshot = Metrics(
            total_tasks=0,
            by_level={},
            by_model={},
            by_backend={},
            human_review_required=0,
            total_estimated_cost_usd=0.0,
            average_complexity_score=0.0,
        )
    body = metrics_export.render_prometheus(snapshot, db_up=db_up)
    return PlainTextResponse(body, media_type=metrics_export.CONTENT_TYPE)


@app.get("/observability", response_model=ObservabilitySnapshot)
def observability() -> ObservabilitySnapshot:
    try:
        records = store.list_tasks()
    except Exception as exc:
        log_event(logger, logging.WARNING, "observability_db_degraded", error=f"{type(exc).__name__}: {exc}")
        records = []
    try:
        decisions = store.list_decisions()
    except Exception as exc:
        log_event(logger, logging.WARNING, "observability_decisions_degraded", error=f"{type(exc).__name__}: {exc}")
        decisions = []
    return monitoring.compute_observability(records, decisions, layout_store.load())


@app.get("/observability/history", response_model=MetricsHistory)
def observability_history(limit: int = Query(default=200, ge=1, le=1000)) -> MetricsHistory:
    """Rolling KPI trend (cost/tokens/latency over time), one point per completed delegation."""
    return store.metrics_history(limit=limit)


# --- Configuration & providers ----------------------------------------------


@app.get("/config", response_model=KarajanConfig)
def get_config() -> KarajanConfig:
    return active_config


@app.put("/config", response_model=KarajanConfig)
def update_config(new_config: KarajanConfig, _: None = Depends(require_token)) -> KarajanConfig:
    global active_config
    active_config = new_config
    config_module.save_runtime_config(new_config)
    log_event(logger, logging.INFO, "config_updated", backend=new_config.backend.value, profile=new_config.profile.value)
    events.publish("config_changed")
    return active_config


@app.get("/routing-layout", response_model=RoutingLayout)
def get_routing_layout() -> RoutingLayout:
    return layout_store.load()


@app.put("/routing-layout", response_model=RoutingLayout)
def update_routing_layout(layout: RoutingLayout, _: None = Depends(require_token)) -> RoutingLayout:
    saved = layout_store.save(layout)
    events.publish("layout_changed")
    return saved


@app.get("/catalog", response_model=list[ProviderInfo])
def get_catalog() -> list[ProviderInfo]:
    return catalog.all_providers()


@app.get("/skills", response_model=list[SkillInfo])
def list_skills() -> list[SkillInfo]:
    return skills_catalog.list_skills()


@app.post("/skills/{name}/install", response_model=SkillInstallResult)
def install_skill(name: str, _: None = Depends(require_token)) -> SkillInstallResult:
    return skills_catalog.install_skill(name)


@app.get("/integrations/openclaw/status", response_model=OpenClawStatus)
def openclaw_status() -> OpenClawStatus:
    return openclaw_client.OpenClawClient(active_config).status()


@app.get("/integrations/openclaw/skills", response_model=list[OpenClawSkillInfo])
def openclaw_skills() -> list[OpenClawSkillInfo]:
    return openclaw_client.OpenClawClient(active_config).skills()


@app.post("/integrations/openclaw/skills/install", response_model=OpenClawOperationResult)
def openclaw_install_skill(
    request: OpenClawInstallRequest,
    _: None = Depends(require_token),
) -> OpenClawOperationResult:
    return openclaw_client.OpenClawClient(active_config).install_skill(request)


@app.post("/integrations/openclaw/skills/update", response_model=OpenClawOperationResult)
def openclaw_update_skill(
    request: OpenClawUpdateRequest,
    _: None = Depends(require_token),
) -> OpenClawOperationResult:
    return openclaw_client.OpenClawClient(active_config).update_skill(request)


@app.get("/integrations/openclaw/channels", response_model=list[OpenClawChannelInfo])
def openclaw_channels() -> list[OpenClawChannelInfo]:
    return openclaw_client.OpenClawClient(active_config).channels()


@app.get("/integrations/openclaw/setup-commands", response_model=list[OpenClawSetupCommand])
def openclaw_setup_commands() -> list[OpenClawSetupCommand]:
    return openclaw_client.OpenClawClient(active_config).setup_commands()


@app.get("/integrations/openclaw/channels/catalog", response_model=list[OpenClawChannelInfo])
def openclaw_channel_catalog() -> list[OpenClawChannelInfo]:
    return openclaw_client.OpenClawClient(active_config).channel_catalog()


@app.get("/integrations/openclaw/daemon-status", response_model=OpenClawDaemonStatus)
def openclaw_daemon_status() -> OpenClawDaemonStatus:
    return openclaw_client.OpenClawClient(active_config).daemon_status()


@app.get("/integrations/openclaw/plugins", response_model=list[OpenClawPluginInfo])
def openclaw_plugins() -> list[OpenClawPluginInfo]:
    return openclaw_client.OpenClawClient(active_config).plugins()


@app.post("/integrations/openclaw/plugins/install", response_model=OpenClawOperationResult)
def openclaw_install_plugin(
    request: OpenClawPluginInstallRequest,
    _: None = Depends(require_token),
) -> OpenClawOperationResult:
    return openclaw_client.OpenClawClient(active_config).install_plugin(request.spec, request.acknowledge_clawhub_risk)


@app.get("/providers", response_model=list[CredentialStatus])
def list_providers() -> list[CredentialStatus]:
    return credentials.detect_all()


@app.get("/providers/{name}/setup", response_model=ProviderSetup)
def provider_setup(name: str) -> ProviderSetup:
    setup = credentials.guided_setup(name)
    if setup is None:
        raise HTTPException(status_code=404, detail="provider not found")
    return setup


@app.post("/providers/{name}/run", response_model=ProviderRunResult)
def provider_run(name: str, request: ProviderRunRequest, _: None = Depends(require_token)) -> ProviderRunResult:
    """Run a provider's catalog-defined login/probe command for the Agentes console.

    Only `login_command`/`probe_command` from the static catalog can run — see
    `app/agent_console.py` for why this can't become arbitrary command execution.
    """
    provider = catalog.get_provider(name)
    if provider is None:
        raise HTTPException(status_code=404, detail="provider not found")
    return agent_console.run_provider_command(provider, request.slot)


@app.post("/setup/apply-default", response_model=DefaultConfigApplyResult)
def apply_default_config(_: None = Depends(require_token)) -> DefaultConfigApplyResult:
    """Restore the reference production hierarchy (Claude / ChatGPT / Qwen+DeepSeek local)
    from data/production_baseline/ and report what's still missing to run real tasks.

    Backed by `app/production_setup.py`, the same module `scripts/setup_production.py`
    uses from the command line — this is its "apply from the GUI" entry point.
    """
    global active_config
    backups = production_setup.reset_config()
    active_config = config_module.load_config()
    layout_store.load()

    required = production_setup.ollama_required_models()
    installed = production_setup.ollama_installed_models()
    missing_models = [model for model in required if model not in installed]

    creds: dict[str, CredentialStatus] = {}
    next_steps: list[str] = []
    for provider_name in production_setup.REQUIRED_API_PROVIDERS:
        status = production_setup.check_api_key(provider_name)
        creds[provider_name] = status
        if not status.ready:
            next_steps.append(f"Configura la credencial de {provider_name} en .env ({status.detail})")
    for model in missing_models:
        next_steps.append(f"ollama pull {model}")
    for provider_name in production_setup.CLOUD_PROVIDERS:
        provider = catalog.get_provider(provider_name)
        if provider is not None:
            models = ", ".join(dict.fromkeys(provider.tiers.values()))
            next_steps.append(
                f"Opcional (L1, requiere cuenta Ollama): {provider.login_command} y luego usa {models}"
            )

    log_event(logger, logging.INFO, "default_config_applied", backups=len(backups), missing_models=len(missing_models))
    return DefaultConfigApplyResult(
        ok=True,
        restored=["data/active_config.json", "data/routing_layout.json"],
        backups=backups,
        ollama_installed=[model for model in required if model in installed],
        ollama_missing=missing_models,
        credentials=creds,
        next_steps=next_steps,
    )


@app.post("/setup/apply-queue-config", response_model=DefaultConfigApplyResult)
def apply_queue_config(_: None = Depends(require_token)) -> DefaultConfigApplyResult:
    """Turn on the availability-driven queue + validator loop and make sure every
    tier (raíz/L1/L2) of the pyramidal hierarchy is present in the routing graph.

    Purely additive and idempotent: existing entities/customizations are never
    touched, only missing baseline hierarchy nodes get appended, and running
    this again when everything's already configured is a harmless no-op.
    """
    global active_config
    layout = layout_store.load()
    merged_layout, added_ids = production_setup.ensure_queue_hierarchy_entities(layout)
    if added_ids:
        layout_store.save(merged_layout)

    active_config.orchestration.dispatch_mode = "queue"
    active_config.orchestration.enable_validator_loop = True
    config_module.save_runtime_config(active_config)

    required = production_setup.ollama_required_models()
    installed = production_setup.ollama_installed_models()
    missing_models = [model for model in required if model not in installed]

    next_steps: list[str] = [f"ollama pull {model}" for model in missing_models]
    for provider_name in production_setup.CLOUD_PROVIDERS:
        provider = catalog.get_provider(provider_name)
        if provider is not None:
            models = ", ".join(dict.fromkeys(provider.tiers.values()))
            next_steps.append(
                f"Opcional (L1, requiere cuenta Ollama): {provider.login_command} y luego usa {models}"
            )

    log_event(
        logger,
        logging.INFO,
        "queue_hierarchy_applied",
        added_entities=len(added_ids),
        missing_models=len(missing_models),
    )
    return DefaultConfigApplyResult(
        ok=True,
        restored=[f"routing-layout: +{len(added_ids)} agente(s) añadidos"] if added_ids else [],
        ollama_installed=[model for model in required if model in installed],
        ollama_missing=missing_models,
        next_steps=next_steps,
    )


# --- Graph / multi-repo ------------------------------------------------------


@app.get("/repos", response_model=list[RepoConfig])
def list_repos() -> list[RepoConfig]:
    return graph_store.list_repos()


@app.get("/repos/{repo_id}", response_model=RepoConfig)
def get_repo(repo_id: str) -> RepoConfig:
    repo = graph_store.get_repo(repo_id)
    if repo is None:
        raise HTTPException(status_code=404, detail="repo not found")
    return repo


@app.get("/system/pick-folder")
def pick_folder(_: None = Depends(require_token)) -> dict[str, str]:
    """Open a native folder picker on the local Karajan host."""
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as exc:  # pragma: no cover - platform dependent
        raise HTTPException(status_code=503, detail=f"folder picker unavailable: {exc}") from exc

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        selected = filedialog.askdirectory(title="Selecciona la carpeta del proyecto")
    finally:
        root.destroy()
    return {"path": selected or ""}


@app.post("/repos", response_model=RepoConfig)
def create_repo(payload: RepoCreateRequest, _: None = Depends(require_token)) -> RepoConfig:
    """Register a repository by its filesystem root.

    The raw `root_path` is resolved to an absolute path and validated as an
    existing directory; the resolved form is what gets stored so later
    path-safety checks (Fase C/D) have a reliable anchor. Registering the same
    resolved path twice is a 409.
    """
    resolved = Path(payload.root_path).resolve()
    if not resolved.exists() or not resolved.is_dir():
        raise HTTPException(status_code=400, detail="root_path does not exist or is not a directory")
    root_str = str(resolved)
    if any(existing.root_path == root_str for existing in graph_store.list_repos()):
        raise HTTPException(status_code=409, detail="repo already registered")
    repo = RepoConfig(
        name=payload.name,
        root_path=root_str,
        language_hint=payload.language_hint,
        provider_override=payload.provider_override,
        exclude_globs=payload.exclude_globs,
    )
    return graph_store.add_repo(repo)


@app.delete("/repos/{repo_id}")
def delete_repo(repo_id: str, _: None = Depends(require_token)) -> dict:
    if not graph_store.delete_repo(repo_id):
        raise HTTPException(status_code=404, detail="repo not found")
    return {"deleted": True}


@app.post("/repos/{repo_id}/scan", response_model=ScanSummary)
def scan_repo(repo_id: str, _: None = Depends(require_token)) -> ScanSummary:
    """Run static analysis over a registered repo, returning a `ScanSummary`.

    Synchronous: even the largest workspace repo (~235 files) parses in well
    under the request budget, and a rescan skips unchanged files via the
    mtime/size cache. Populates `graph_nodes`/`graph_edges` for the frontend.
    """
    repo = graph_store.get_repo(repo_id)
    if repo is None:
        raise HTTPException(status_code=404, detail="repo not found")
    summary = graph_scanner.scan_repo(repo, graph_store)
    events.publish("repo_scanned", repo_id=repo_id)
    return summary


@app.get("/repos/{repo_id}/graph", response_model=GraphSnapshot)
def get_repo_graph(repo_id: str) -> GraphSnapshot:
    """Full node+edge snapshot for a repo (consumed by the Fase C frontend)."""
    if graph_store.get_repo(repo_id) is None:
        raise HTTPException(status_code=404, detail="repo not found")
    return graph_store.get_snapshot(repo_id)


@app.get("/repos/{repo_id}/file", response_model=RepoFileResponse)
def get_repo_file(repo_id: str, path: str = Query(..., min_length=1)) -> RepoFileResponse:
    """Read a repo-relative file for the embedded graph editor."""
    repo = graph_store.get_repo(repo_id)
    if repo is None:
        raise HTTPException(status_code=404, detail="repo not found")
    try:
        abs_path = safe_resolve(Path(repo.root_path), path)
        if not abs_path.exists() or not abs_path.is_file():
            raise HTTPException(status_code=404, detail="file not found")
        content = abs_path.read_text(encoding="utf-8", errors="replace")
        stat = abs_path.stat()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"invalid path: {exc}")
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"cannot read file: {exc}")
    return RepoFileResponse(
        repo_id=repo_id,
        path=path,
        content=content,
        size=stat.st_size,
        modified_at=datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
    )


@app.put("/repos/{repo_id}/file", response_model=RepoFileSaveResponse)
def save_repo_file(
    repo_id: str,
    payload: RepoFileSaveRequest,
    _: None = Depends(require_token),
) -> RepoFileSaveResponse:
    """Save a repo-relative file from the embedded graph editor."""
    repo = graph_store.get_repo(repo_id)
    if repo is None:
        raise HTTPException(status_code=404, detail="repo not found")
    try:
        abs_path = safe_resolve(Path(repo.root_path), payload.path)
        if abs_path.exists() and not abs_path.is_file():
            raise HTTPException(status_code=400, detail="path is not a file")
        if not abs_path.parent.exists():
            raise HTTPException(status_code=400, detail="parent directory does not exist")
        abs_path.write_text(payload.content, encoding="utf-8")
        stat = abs_path.stat()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"invalid path: {exc}")
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"cannot save file: {exc}")
    return RepoFileSaveResponse(
        repo_id=repo_id,
        path=payload.path,
        size=stat.st_size,
        modified_at=datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
    )


@app.post("/repos/{repo_id}/audit", response_model=AuditResult)
def audit_repo(repo_id: str, payload: AuditRequest, _: None = Depends(require_token)) -> AuditResult:
    """Run the deterministic code audit over a repo's stored graph (Fase D).

    Persists findings (replacing any prior run) and, when `include_llm=true`,
    layers a best-effort Spanish narrative on top. The deterministic findings are
    the guaranteed value: an LLM failure degrades to `llm_summary=null`, it never
    500s the endpoint.
    """
    if graph_store.get_repo(repo_id) is None:
        raise HTTPException(status_code=404, detail="repo not found")
    result = graph_audit.run_audit(
        repo_id, graph_store, include_llm=payload.include_llm, config=active_config
    )
    events.publish("repo_audited", repo_id=repo_id)
    return result


@app.get("/repos/{repo_id}/findings", response_model=list[Finding])
def list_findings(repo_id: str) -> list[Finding]:
    """Persisted findings for a repo (drives the frontend severity badges)."""
    if graph_store.get_repo(repo_id) is None:
        raise HTTPException(status_code=404, detail="repo not found")
    return graph_store.list_findings(repo_id)


def _fixer_resolution(repo: RepoConfig):
    from app.providers import registry

    layout = layout_store.load()
    for entity in layout.entities:
        tags = set(entity.role_tags or [])
        if "fixer" not in tags:
            continue
        for tier in (
            RecommendedModel.STRONG_MODEL_WITH_HUMAN_REVIEW,
            RecommendedModel.STRONG_MODEL,
            RecommendedModel.MEDIUM_MODEL,
        ):
            resolution = registry.resolve_entity(entity, tier)
            if resolution is not None:
                return resolution
    return graph_audit.resolve_graph_provider(repo, active_config)


def _extract_file_block(output: str) -> str | None:
    match = re.search(r"```(?:file|python|py|typescript|ts|javascript|js)?\s*\n([\s\S]*?)\n```", output)
    return match.group(1) if match else None


def _extract_file_blocks(output: str) -> list[tuple[str, str]]:
    blocks: list[tuple[str, str]] = []
    pattern = re.compile(r"```file(?P<header>[^\n]*)\n(?P<body>[\s\S]*?)\n```", re.IGNORECASE)
    for match in pattern.finditer(output):
        header = match.group("header").strip()
        body = match.group("body")
        path_match = re.search(r"path=(?P<quote>[\"']?)(?P<path>[^\"'\s]+)(?P=quote)", header)
        rel_path = path_match.group("path").strip() if path_match else header.strip()
        if not rel_path:
            first_line, _, rest = body.partition("\n")
            if first_line.strip().lower().startswith("path:"):
                rel_path = first_line.split(":", 1)[1].strip()
                body = rest
        if rel_path:
            blocks.append((rel_path, body))
    return blocks


def _fix_findings_report(
    repo_id: str,
    repo: RepoConfig,
    payload: FixFindingRequest,
    progress: Callable[[str], None] = lambda _msg: None,
) -> FixFindingResult:
    all_findings = graph_store.list_findings(repo_id)
    requested_ids = set(payload.finding_ids or [payload.finding_id])
    selected = [finding for finding in all_findings if finding.id in requested_ids] if requested_ids else all_findings
    if not selected:
        raise HTTPException(status_code=404, detail="findings not found")
    progress(f"Hallazgos seleccionados: {len(selected)}.")

    resolution = _fixer_resolution(repo)
    finding_id = selected[0].id
    if resolution is None:
        progress("No hay agente Fixeador ni proveedor de grafo disponible.")
        return FixFindingResult(
            repo_id=repo_id,
            finding_id=finding_id,
            error="no hay agente Fixeador ni proveedor de grafo disponible",
            attempted_count=len(selected),
        )
    progress(f"Agente resuelto: {resolution.provider_name} · modelo {resolution.model_id}.")

    report = payload.report or "\n".join(
        f"- [{finding.severity}] {finding.detector}: {finding.message} ({finding.node_id})"
        for finding in selected
    )
    instruction = (
        "Eres el rol Fixeador de Karajan, asignado desde Decisión para intervenir "
        "sobre problemas detectados en el panel de Grafo.\n"
        "Recibirás el REPORTE COMPLETO de hallazgos. Intenta corregirlos con parches "
        "acotados y verificables. No hagas refactors amplios que no estén justificados "
        "por los hallazgos.\n\n"
        "Si tu CLI puede editar el workspace directamente, aplica los cambios. "
        "Si respondes con cambios para que Karajan los aplique, usa un bloque por fichero "
        "con este formato exacto:\n"
        "```file path=ruta/relativa.py\n<contenido completo del fichero>\n```\n\n"
        "No uses rutas absolutas. Tras tu intervención Karajan reescaneará el proyecto "
        "y volverá a ejecutar la auditoría para verificar qué queda pendiente.\n\n"
        f"Repositorio: {repo.name}\n"
        f"Ruta raíz: {repo.root_path}\n\n"
        f"{report}"
    )
    progress("Enviando reporte completo al agente Fixeador (puede tardar varios minutos)...")
    try:
        run = resolution.provider.run(instruction, resolution.model_id, timeout_s=600)
    except Exception as exc:  # noqa: BLE001
        progress(f"Fallo del agente Fixeador: {exc}")
        return FixFindingResult(
            repo_id=repo_id,
            finding_id=finding_id,
            provider=resolution.provider_name,
            model=resolution.model_id,
            error=f"fallo del agente Fixeador: {exc}",
            attempted_count=len(selected),
        )
    if run.error:
        progress(f"El agente devolvió un error: {run.error}")
        return FixFindingResult(
            repo_id=repo_id,
            finding_id=finding_id,
            provider=resolution.provider_name,
            model=resolution.model_id,
            error=run.error,
            attempted_count=len(selected),
        )
    progress(f"Respuesta recibida ({len(run.output or '')} caracteres). Extrayendo parches...")

    applied_files: list[str] = []
    if payload.apply:
        blocks = _extract_file_blocks(run.output or "")
        progress(f"Bloques de fichero detectados: {len(blocks)}.")
        for rel_path, content in blocks:
            try:
                abs_path = safe_resolve(Path(repo.root_path), rel_path)
                abs_path.write_text(content, encoding="utf-8")
                applied_files.append(rel_path)
                progress(f"Aplicado: {rel_path}")
            except (OSError, ValueError) as exc:
                progress(f"No se pudo aplicar {rel_path}: {exc}")
                continue

    progress("Re-escaneando el repositorio...")
    graph_scanner.scan_repo(repo, graph_store)
    progress("Ejecutando auditoría de verificación...")
    result = graph_audit.run_audit(repo_id, graph_store, include_llm=False, config=active_config)
    selected_signatures = {(f.detector, f.node_id, f.message) for f in selected}
    remaining = sum(1 for f in result.findings if (f.detector, f.node_id, f.message) in selected_signatures)
    resolved = max(0, len(selected) - remaining)
    events.publish("repo_scanned", repo_id=repo_id)
    events.publish("repo_audited", repo_id=repo_id)
    progress(f"Auditoría completada: {resolved} resueltos, {remaining} pendientes.")
    return FixFindingResult(
        repo_id=repo_id,
        finding_id=finding_id,
        applied=bool(applied_files) or payload.apply,
        verified=remaining == 0,
        provider=resolution.provider_name,
        model=resolution.model_id,
        message=(
            f"reporte completo enviado al Fixeador; {resolved} resueltos, "
            f"{remaining} pendientes tras auditoría"
        ),
        summary=(run.output or "")[:4000],
        attempted_count=len(selected),
        resolved_count=resolved,
    )


def _fix_single_finding(
    repo_id: str,
    repo: RepoConfig,
    payload: FixFindingRequest,
    progress: Callable[[str], None] = lambda _msg: None,
) -> FixFindingResult:
    finding = next((f for f in graph_store.list_findings(repo_id) if f.id == payload.finding_id), None)
    if finding is None:
        raise HTTPException(status_code=404, detail="finding not found")
    progress(f"Hallazgo: {finding.detector} ({finding.severity}) · {finding.message}")
    snapshot = graph_store.get_snapshot(repo_id)
    node = next((n for n in snapshot.nodes if n.id == finding.node_id), None)
    if node is None:
        raise HTTPException(status_code=404, detail="finding node not found")
    file_node = node
    if node.kind != "file" and node.file_id:
        file_node = next((n for n in snapshot.nodes if n.id == node.file_id), node)
    rel_path = file_node.qualified_name
    if not rel_path:
        raise HTTPException(status_code=400, detail="finding has no source file")

    try:
        abs_path = safe_resolve(Path(repo.root_path), rel_path)
        original = abs_path.read_text(encoding="utf-8", errors="replace")
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"cannot read source: {exc}")

    lines = original.splitlines()
    start = max(1, (node.start_line or 1) - 20)
    end = min(len(lines), (node.end_line or node.start_line or len(lines)) + 20)
    snippet = "\n".join(lines[start - 1 : end])

    resolution = _fixer_resolution(repo)
    if resolution is None:
        progress("No hay agente Fixeador ni proveedor de grafo disponible.")
        return FixFindingResult(
            repo_id=repo_id,
            finding_id=finding.id,
            file_path=rel_path,
            severity=finding.severity,
            detector=finding.detector,
            error="no hay agente Fixeador ni proveedor de grafo disponible",
        )
    progress(f"Agente resuelto: {resolution.provider_name} · modelo {resolution.model_id}.")

    instruction = (
        "Eres el rol Fixeador de Karajan. Tu responsabilidad es aplicar un parche "
        "mínimo y verificable para un hallazgo de auditoría.\n"
        "Devuelve SOLO el fichero completo corregido dentro de un bloque ```file. "
        "No incluyas explicación fuera del bloque.\n\n"
        f"Ruta: {rel_path}\n"
        f"Criticidad: {finding.severity}\n"
        f"Detector: {finding.detector}\n"
        f"Qué hay que solucionar: {finding.message}\n"
        f"Nodo: {node.qualified_name or node.name}\n"
        f"Líneas relevantes: {start}-{end}\n\n"
        "Fragmento afectado:\n```text\n" + snippet + "\n```\n\n"
        "Fichero completo actual:\n```file\n" + original + "\n```"
    )
    progress(f"Enviando {rel_path} al agente Fixeador (puede tardar 1-2 minutos)...")
    try:
        run = resolution.provider.run(instruction, resolution.model_id, timeout_s=180)
    except Exception as exc:  # noqa: BLE001
        progress(f"Fallo del agente Fixeador: {exc}")
        return FixFindingResult(
            repo_id=repo_id,
            finding_id=finding.id,
            provider=resolution.provider_name,
            model=resolution.model_id,
            file_path=rel_path,
            severity=finding.severity,
            detector=finding.detector,
            error=f"fallo del agente Fixeador: {exc}",
        )
    if run.error or not (run.output or "").strip():
        progress(f"El agente devolvió un error o respuesta vacía: {run.error or '(vacío)'}")
        return FixFindingResult(
            repo_id=repo_id,
            finding_id=finding.id,
            provider=resolution.provider_name,
            model=resolution.model_id,
            file_path=rel_path,
            severity=finding.severity,
            detector=finding.detector,
            error=run.error or "respuesta vacía del agente Fixeador",
        )
    progress(f"Respuesta recibida ({len(run.output or '')} caracteres). Extrayendo parche...")

    new_content = _extract_file_block(run.output)
    if not new_content:
        progress("El agente no devolvió un bloque ```file aplicable.")
        return FixFindingResult(
            repo_id=repo_id,
            finding_id=finding.id,
            provider=resolution.provider_name,
            model=resolution.model_id,
            file_path=rel_path,
            severity=finding.severity,
            detector=finding.detector,
            error="el agente no devolvió un bloque ```file aplicable",
        )
    if not payload.apply:
        progress("Parche generado pero no aplicado (apply=false).")
        return FixFindingResult(
            repo_id=repo_id,
            finding_id=finding.id,
            provider=resolution.provider_name,
            model=resolution.model_id,
            file_path=rel_path,
            severity=finding.severity,
            detector=finding.detector,
            message="parche generado pero no aplicado",
        )

    progress(f"Aplicando parche a {rel_path}...")
    abs_path.write_text(new_content, encoding="utf-8")
    progress("Re-escaneando el repositorio...")
    graph_scanner.scan_repo(repo, graph_store)
    progress("Ejecutando auditoría de verificación...")
    result = graph_audit.run_audit(repo_id, graph_store, include_llm=False, config=active_config)
    still_present = any(
        f.detector == finding.detector
        and f.node_id == finding.node_id
        and f.message == finding.message
        for f in result.findings
    )
    events.publish("repo_scanned", repo_id=repo_id)
    events.publish("repo_audited", repo_id=repo_id)
    progress("Verificado: el hallazgo ya no aparece." if not still_present else "Aplicado, pero el detector aún reporta el hallazgo.")
    return FixFindingResult(
        repo_id=repo_id,
        finding_id=finding.id,
        applied=True,
        verified=not still_present,
        provider=resolution.provider_name,
        model=resolution.model_id,
        file_path=rel_path,
        severity=finding.severity,
        detector=finding.detector,
        message="parche aplicado y verificado" if not still_present else "parche aplicado, pero el detector aún reporta el hallazgo",
    )


@app.post("/repos/{repo_id}/findings/fix", response_model=FixFindingResult)
def fix_finding(
    repo_id: str, payload: FixFindingRequest, _: None = Depends(require_token)
) -> FixFindingResult:
    """Delegate one finding to the Fixer role and verify with scan+audit."""
    repo = graph_store.get_repo(repo_id)
    if repo is None:
        raise HTTPException(status_code=404, detail="repo not found")
    if payload.mode == "full_report" or payload.finding_ids:
        return _fix_findings_report(repo_id, repo, payload)
    return _fix_single_finding(repo_id, repo, payload)


_fix_jobs: dict[str, "_FixJob"] = {}
_fix_jobs_lock = threading.Lock()


class _FixJob:
    """In-memory progress log + result for one background Fixer run.

    Findings fixes route through a real CLI subprocess that can take minutes;
    this lets the frontend poll a job for incremental log lines instead of
    blocking a single request (and getting zero feedback) for that long.
    """

    def __init__(self) -> None:
        self.status = "running"  # running | done | error
        self.log: list[str] = []
        self.result: FixFindingResult | None = None
        self.lock = threading.Lock()

    def append(self, msg: str) -> None:
        with self.lock:
            self.log.append(msg)

    def snapshot(self) -> FixJobStatus:
        with self.lock:
            return FixJobStatus(status=self.status, log=list(self.log), result=self.result)


def _prune_fix_jobs() -> None:
    with _fix_jobs_lock:
        if len(_fix_jobs) <= 100:
            return
        finished = [jid for jid, job in _fix_jobs.items() if job.status != "running"]
        for jid in finished[: len(_fix_jobs) - 100]:
            _fix_jobs.pop(jid, None)


def _run_fix_job(job: "_FixJob", repo_id: str, repo: RepoConfig, payload: FixFindingRequest) -> None:
    try:
        if payload.mode == "full_report" or payload.finding_ids:
            result = _fix_findings_report(repo_id, repo, payload, job.append)
        else:
            result = _fix_single_finding(repo_id, repo, payload, job.append)
        with job.lock:
            job.result = result
            job.status = "done"
    except HTTPException as exc:
        job.append(f"Error: {exc.detail}")
        with job.lock:
            job.status = "error"
    except Exception as exc:  # noqa: BLE001 — the job must always end in a terminal state
        job.append(f"Error inesperado: {exc}")
        with job.lock:
            job.status = "error"


@app.post("/repos/{repo_id}/findings/fix/jobs", response_model=FixJobStarted)
def start_fix_job(
    repo_id: str, payload: FixFindingRequest, _: None = Depends(require_token)
) -> FixJobStarted:
    """Kick off a Fixer run in the background and return a job id to poll.

    The frontend polls GET .../jobs/{job_id} for the accumulating log so the
    Hallazgos panel can show live progress instead of blocking silently.
    """
    repo = graph_store.get_repo(repo_id)
    if repo is None:
        raise HTTPException(status_code=404, detail="repo not found")
    _prune_fix_jobs()
    job = _FixJob()
    job_id = uuid.uuid4().hex
    with _fix_jobs_lock:
        _fix_jobs[job_id] = job
    threading.Thread(target=_run_fix_job, args=(job, repo_id, repo, payload), daemon=True).start()
    return FixJobStarted(job_id=job_id)


@app.get("/repos/{repo_id}/findings/fix/jobs/{job_id}", response_model=FixJobStatus)
def get_fix_job(repo_id: str, job_id: str) -> FixJobStatus:
    job = _fix_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job.snapshot()


@app.post("/repos/{repo_id}/explain", response_model=ExplainResult)
def explain_node(repo_id: str, payload: ExplainRequest, _: None = Depends(require_token)) -> ExplainResult:
    """Ask the configured LLM to explain one graph node's source (Fase D).

    Reads the relevant source slice via `safe_resolve` (path-traversal guarded),
    then delegates to the resolved provider. If no provider is ready, returns a
    clear JSON error rather than crashing.
    """
    repo = graph_store.get_repo(repo_id)
    if repo is None:
        raise HTTPException(status_code=404, detail="repo not found")
    snapshot = graph_store.get_snapshot(repo_id)
    node = next((n for n in snapshot.nodes if n.id == payload.node_id), None)
    if node is None:
        raise HTTPException(status_code=404, detail="node not found")

    file_node = node
    if node.kind != "file" and node.file_id:
        file_node = next((n for n in snapshot.nodes if n.id == node.file_id), node)
    rel_path = file_node.qualified_name
    if not rel_path:
        raise HTTPException(status_code=404, detail="node has no source file")

    try:
        abs_path = safe_resolve(Path(repo.root_path), rel_path)
        lines = abs_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"cannot read source: {exc}")

    if node.kind == "file":
        snippet = "\n".join(lines[:400])
    else:
        start = max(1, (node.start_line or 1) - 3)
        end = min(len(lines), (node.end_line or node.start_line or 1) + 3)
        snippet = "\n".join(lines[start - 1 : end])

    resolution = graph_audit.resolve_graph_provider(repo, active_config)
    if resolution is None:
        return ExplainResult(
            explanation=None,
            error="no hay proveedor IA disponible; configura graph_agent_provider",
        )

    instruction = (
        "Explica en español qué hace este código, cuál es su responsabilidad "
        "principal, y posibles problemas de diseño, rendimiento o seguridad. "
        f"Sé conciso.\n\nArchivo: {rel_path}\nSímbolo: {node.qualified_name or node.name}\n\n"
        "```\n" + snippet + "\n```"
    )
    try:
        run = resolution.provider.run(instruction, resolution.model_id, timeout_s=120)
    except Exception as exc:  # noqa: BLE001 — never 500 on a provider failure
        return ExplainResult(
            explanation=None, provider=resolution.provider_name,
            model=resolution.model_id, error=f"fallo del proveedor: {exc}",
        )
    if run.error or not (run.output or "").strip():
        return ExplainResult(
            explanation=None, provider=resolution.provider_name,
            model=resolution.model_id, error=run.error or "respuesta vacía del proveedor",
        )
    return ExplainResult(
        explanation=run.output.strip(),
        provider=resolution.provider_name,
        model=resolution.model_id,
    )


# --- First-run setup (web overlay + terminal installer share this state) ----


@app.get("/setup/status", response_model=SetupStatus)
def setup_status_endpoint() -> SetupStatus:
    return SetupStatus(completed=setup_status.is_complete())


@app.post("/setup/complete", response_model=SetupStatus)
def setup_complete(_: None = Depends(require_token)) -> SetupStatus:
    """Mark first-run setup done (web overlay finished/skipped) and write the
    navigation tutorial doc — idempotent, safe to call again."""
    setup_status.mark_complete()
    return SetupStatus(completed=True)


@app.get("/setup/tutorial", response_model=SetupTutorial)
def setup_tutorial() -> SetupTutorial:
    """Not gated on completion — help must work regardless of onboarding state."""
    return SetupTutorial(markdown=navigation_tutorial_markdown())
