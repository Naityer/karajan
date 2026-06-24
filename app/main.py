from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import (
    catalog,
    classifier,
    config as config_module,
    credentials,
    delegation,
    monitoring,
    skills_catalog,
)
from app.database import TaskStore
from app.models import (
    CredentialStatus,
    DecisionLogEntry,
    DelegationRequest,
    IngestRequest,
    KarajanConfig,
    Metrics,
    ProviderInfo,
    ProviderSetup,
    SkillInfo,
    TaskRecord,
    TaskRequest,
)

app = FastAPI(
    title="KARAJAN AI Harness Router",
    version="0.2.0",
    description="Local harness for task classification, real/local/simulated delegation, and audit monitoring.",
)

store = TaskStore()
active_config: KarajanConfig = config_module.load_config()
STATIC_DIR = Path(__file__).resolve().parent.parent / "dashboard" / "static"

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/classify-task", response_model=TaskRecord)
def classify_task(request: TaskRequest) -> TaskRecord:
    classification = classifier.classify(request.prompt, active_config)
    decision = monitoring.build_classify_decision(classification)
    return store.save_classification(classification, decision)


@app.post("/ingest", response_model=TaskRecord)
def ingest(request: IngestRequest) -> TaskRecord:
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
def append_decision(task_id: str, entry: DecisionLogEntry) -> DecisionLogEntry:
    """Append a real execution decision reported by the model (live audit trail)."""
    try:
        store.get_task(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="task not found") from exc
    entry.task_id = task_id
    store.add_decisions([entry])
    return entry


@app.post("/delegate-task", response_model=TaskRecord)
def delegate_task(request: DelegationRequest) -> TaskRecord:
    try:
        record = store.get_task(request.task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="task not found") from exc

    result, decisions = delegation.delegate(record.classification, active_config)
    return store.save_delegation(result, decisions)


@app.get("/tasks", response_model=list[TaskRecord])
def list_tasks() -> list[TaskRecord]:
    return store.list_tasks()


@app.get("/tasks/{task_id}", response_model=TaskRecord)
def get_task(task_id: str) -> TaskRecord:
    try:
        return store.get_task(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="task not found") from exc


@app.get("/tasks/{task_id}/decisions", response_model=list[DecisionLogEntry])
def task_decisions(task_id: str) -> list[DecisionLogEntry]:
    return store.list_decisions(task_id)


@app.get("/metrics", response_model=Metrics)
def metrics() -> Metrics:
    return store.metrics()


# --- Configuration & providers ----------------------------------------------


@app.get("/config", response_model=KarajanConfig)
def get_config() -> KarajanConfig:
    return active_config


@app.put("/config", response_model=KarajanConfig)
def update_config(new_config: KarajanConfig) -> KarajanConfig:
    global active_config
    active_config = new_config
    return active_config


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
