"""Authenticated HTTP server adapter for the stable application protocol."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field

from app import runtime as runtime_module
from app.application_dto import ClassifyCommand, ExecuteCommand
from app.application_errors import (
    AuthorizationDeniedError,
    BudgetExceededError,
    ConflictError,
    DeadlineExceededError,
    HostedModeRequiredError,
    InvalidOverrideError,
    OutcomeUnknownError,
    ProviderUnavailableError,
    TaskNotFoundError,
)
from app.atlas_auth import require_atlas_token
from app.auth import require_token
from app.models import ComplexityLevel

router = APIRouter(prefix="/v1", tags=["v1"])
secured = [Depends(require_token), Depends(require_atlas_token)]


class ClassifyBody(BaseModel):
    prompt: str = Field(min_length=1, max_length=20_000)
    workspace_id: str = "default"
    effort_level: ComplexityLevel | None = None


class ExecuteBody(BaseModel):
    task_id: str
    workspace_id: str = "default"
    workspace_root: str = ""
    execution_context: str = Field(default="", max_length=100_000)
    agent_tools_profile: str | None = None
    deadline_at: datetime | None = None
    time_budget_seconds: float | None = Field(default=None, gt=0)


def _application():
    application = runtime_module.current().application
    if application is None:
        raise RuntimeError("runtime has no KarajanApplication")
    return application


def _raise_http(exc: Exception) -> None:
    if isinstance(exc, AuthorizationDeniedError):
        status = 403
    elif isinstance(exc, TaskNotFoundError):
        status = 404
    elif isinstance(exc, (ConflictError, BudgetExceededError)):
        status = 409
    elif isinstance(exc, ProviderUnavailableError):
        status = 503
    elif isinstance(exc, DeadlineExceededError):
        status = 504
    elif isinstance(exc, HostedModeRequiredError):
        status = 503
    elif isinstance(exc, OutcomeUnknownError):
        status = 502
    elif isinstance(exc, InvalidOverrideError):
        status = 422
    else:
        status = 500
    raise HTTPException(status_code=status, detail=str(exc)) from exc


@router.get("/health/live")
def liveness() -> dict:
    return _application().liveness()


@router.get("/health/ready")
def readiness() -> dict:
    return _application().readiness()


@router.post("/tasks/classify", dependencies=secured)
def classify(
    body: ClassifyBody,
    correlation_id: str | None = Header(default=None, alias="X-Correlation-ID"),
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
):
    try:
        generated = ClassifyCommand(body.prompt)
        return _application().classify(
            ClassifyCommand(
                prompt=body.prompt,
                workspace_id=body.workspace_id,
                correlation_id=correlation_id or generated.correlation_id,
                idempotency_key=idempotency_key,
                effort_level=body.effort_level,
            )
        )
    except Exception as exc:  # noqa: BLE001 - adapter maps domain errors centrally
        _raise_http(exc)


@router.post("/executions", dependencies=secured)
def execute(
    body: ExecuteBody,
    correlation_id: str | None = Header(default=None, alias="X-Correlation-ID"),
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
):
    try:
        values = {
            "task_id": body.task_id,
            "workspace_id": body.workspace_id,
            "idempotency_key": idempotency_key,
            "workspace_root": body.workspace_root,
            "execution_context": body.execution_context,
            "agent_tools_profile": body.agent_tools_profile,
            "deadline_at": body.deadline_at,
            "time_budget_seconds": body.time_budget_seconds,
        }
        if correlation_id:
            values["correlation_id"] = correlation_id
        return _application().execute(ExecuteCommand(**values))
    except Exception as exc:  # noqa: BLE001 - adapter maps domain errors centrally
        _raise_http(exc)


@router.get("/tasks", dependencies=secured)
def list_tasks(
    limit: int | None = Query(default=None, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    return _application().list_tasks(limit=limit, offset=offset)


@router.get("/tasks/{task_id}", dependencies=secured)
def get_task(task_id: str):
    try:
        return _application().get_task(task_id)
    except Exception as exc:  # noqa: BLE001 - adapter maps domain errors centrally
        _raise_http(exc)


@router.post("/executions/{execution_id}/cancel", dependencies=secured)
def cancel_execution(
    execution_id: str,
    correlation_id: str = Header(default="", alias="X-Correlation-ID"),
):
    try:
        return _application().cancel_execution(
            execution_id, correlation_id=correlation_id
        )
    except Exception as exc:  # noqa: BLE001 - adapter maps domain errors centrally
        _raise_http(exc)
