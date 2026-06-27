from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from app.env import load_project_env

load_project_env()

from app import (
    catalog,
    classifier,
    config as config_module,
    credentials,
    delegation,
    metrics_export,
    monitoring,
    routing_layout,
    skills_catalog,
)
from app.auth import TOKEN_ENV_VAR, require_token
from app.logging_config import get_logger, log_event
from app.models import ClassificationResult
from app.database import TaskStore
from app.models import (
    CredentialStatus,
    DecisionLogEntry,
    DelegationRequest,
    HealthStatus,
    IngestRequest,
    KarajanConfig,
    Metrics,
    ObservabilitySnapshot,
    ProviderInfo,
    ProviderSetup,
    RoutingLayout,
    SkillInfo,
    TaskRecord,
    TaskRequest,
)

app = FastAPI(
    title="KARAJAN AI Harness Router",
    version="0.2.0",
    description="Local harness for task classification, real/local/simulated delegation, and audit monitoring.",
)

logger = get_logger("api")
store = TaskStore()
layout_store = routing_layout.RoutingLayoutStore()
active_config: KarajanConfig = config_module.load_config()
STATIC_DIR = Path(__file__).resolve().parent.parent / "dashboard" / "static"

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(
        STATIC_DIR / "index.html",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.post("/classify-task", response_model=TaskRecord)
def classify_task(request: TaskRequest, _: None = Depends(require_token)) -> TaskRecord:
    classification = classifier.classify(request.prompt, active_config)
    decision = monitoring.build_classify_decision(classification)
    return store.save_classification(classification, decision)


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
    return store.save_classification(classification, decision)


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
    try:
        record = store.get_task(request.task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="task not found") from exc

    _enforce_daily_budget(record.classification)
    result, decisions = delegation.delegate(record.classification, active_config, layout=layout_store.load())
    return store.save_delegation(result, decisions)


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
    )
    return store.save_delegation(result, [approval, *decisions])


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
    return monitoring.compute_observability(
        store.list_tasks(),
        store.list_decisions(),
        layout_store.load(),
    )


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
    return active_config


@app.get("/routing-layout", response_model=RoutingLayout)
def get_routing_layout() -> RoutingLayout:
    return layout_store.load()


@app.put("/routing-layout", response_model=RoutingLayout)
def update_routing_layout(layout: RoutingLayout, _: None = Depends(require_token)) -> RoutingLayout:
    return layout_store.save(layout)


@app.get("/catalog", response_model=list[ProviderInfo])
def get_catalog() -> list[ProviderInfo]:
    return catalog.all_providers()


@app.get("/skills", response_model=list[SkillInfo])
def list_skills() -> list[SkillInfo]:
    return skills_catalog.list_skills()


@app.get("/providers", response_model=list[CredentialStatus])
def list_providers() -> list[CredentialStatus]:
    return credentials.detect_all()


@app.get("/providers/{name}/setup", response_model=ProviderSetup)
def provider_setup(name: str) -> ProviderSetup:
    setup = credentials.guided_setup(name)
    if setup is None:
        raise HTTPException(status_code=404, detail="provider not found")
    return setup
