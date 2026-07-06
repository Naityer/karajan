from __future__ import annotations

import hashlib
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, PlainTextResponse
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
    metrics_export,
    monitoring,
    openclaw_client,
    production_setup,
    routing_layout,
    setup_status,
    skills_catalog,
)
from app.auth import TOKEN_ENV_VAR, require_token
from app.logging_config import get_logger, log_event
from app.models import ClassificationResult
from app.database import TaskStore
from app.tutorial import navigation_tutorial_markdown
from app.models import (
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
    ObservabilitySnapshot,
    ProviderInfo,
    ProviderRunRequest,
    ProviderRunResult,
    ProviderSetup,
    RoutingLayout,
    SetupStatus,
    SetupTutorial,
    SkillInfo,
    SkillInstallResult,
    TaskRecord,
    TaskRequest,
)

app = FastAPI(
    title="KARAJAN AI Harness Router",
    version="0.2.0",
    description="Local harness for task classification, real/local/simulated delegation, and audit monitoring.",
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
layout_store = routing_layout.RoutingLayoutStore()
active_config: KarajanConfig = config_module.load_config()
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
