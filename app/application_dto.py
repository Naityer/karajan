"""Comandos y vistas públicas versionadas; no son entidades persistentes."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from app.models import ComplexityLevel, TaskRecord

SCHEMA_VERSION = 1


@dataclass(frozen=True)
class ClassifyCommand:
    prompt: str
    workspace_id: str = "default"
    correlation_id: str = field(default_factory=lambda: f"cor_{uuid4().hex}")
    idempotency_key: str = ""
    effort_level: ComplexityLevel | None = None  # compatibilidad legacy instrumentada

    def payload_hash(self) -> str:
        payload = {"prompt": self.prompt.strip(), "effort_level": self.effort_level}
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()


@dataclass(frozen=True)
class ExecuteCommand:
    task_id: str
    workspace_id: str = "default"
    correlation_id: str = field(default_factory=lambda: f"cor_{uuid4().hex}")
    idempotency_key: str = ""
    workspace_root: str = ""
    execution_context: str = ""
    agent_tools_profile: str | None = None
    deadline_at: datetime | None = None
    time_budget_seconds: float | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def ensure_within_deadline(self) -> None:
        if self.remaining_seconds() == 0:
            from app.application_errors import DeadlineExceededError

            raise DeadlineExceededError("execution deadline has expired")

    def remaining_seconds(self) -> float | None:
        now = datetime.now(UTC)
        limits: list[float] = []
        if self.deadline_at is not None:
            limits.append(max(0.0, (self.deadline_at - now).total_seconds()))
        if self.time_budget_seconds is not None:
            elapsed = (now - self.created_at).total_seconds()
            limits.append(max(0.0, self.time_budget_seconds - elapsed))
        return min(limits) if limits else None

    def payload_hash(self) -> str:
        payload = {
            "task_id": self.task_id,
            "workspace_root": self.workspace_root,
            "execution_context": self.execution_context,
            "agent_tools_profile": self.agent_tools_profile,
            "deadline_at": self.deadline_at.isoformat() if self.deadline_at else None,
            "time_budget_seconds": self.time_budget_seconds,
        }
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True).encode("utf-8")
        ).hexdigest()


@dataclass(frozen=True)
class AdministrativeOverrideCommand:
    task_id: str
    reason: str
    force_provider: str = ""
    force_entity_id: str = ""
    workspace_root: str = ""
    execution_context: str = ""
    agent_tools_profile: str | None = None
    correlation_id: str = field(default_factory=lambda: f"cor_{uuid4().hex}")


@dataclass(frozen=True)
class ResolvedIdentity:
    subject: str
    capabilities: frozenset[str] = frozenset()


@dataclass(frozen=True)
class TaskView:
    task_id: str
    prompt: str
    status: str
    classification: dict[str, Any]
    delegation: dict[str, Any] | None
    created_at: datetime
    updated_at: datetime
    schema_version: int = SCHEMA_VERSION

    @classmethod
    def from_record(cls, record: TaskRecord) -> TaskView:
        return cls(
            task_id=record.task_id,
            prompt=record.prompt,
            status=record.status.value,
            classification=record.classification.model_dump(mode="json"),
            delegation=(record.delegation.model_dump(mode="json") if record.delegation else None),
            created_at=record.created_at,
            updated_at=record.updated_at,
        )

    def legacy_payload(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "prompt": self.prompt,
            "status": self.status,
            "classification": self.classification,
            "delegation": self.delegation,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass(frozen=True)
class ExecutionView:
    execution_id: str
    correlation_id: str
    task: TaskView
    decision_fingerprint: str
    schema_version: int = SCHEMA_VERSION


def decision_fingerprint(record: TaskRecord) -> str:
    classification = record.classification
    stable = {
        "level": classification.complexity_level.value,
        "model": classification.recommended_model.value,
        "strategy": classification.recommended_strategy,
        "review": classification.requires_human_review,
        "subtasks": [
            {"model": item.recommended_model.value, "skill": item.recommended_skill}
            for item in classification.subtasks
        ],
        "execution": (
            {
                "status": record.delegation.status.value,
                "models": [item.model_used for item in record.delegation.executions],
            }
            if record.delegation
            else None
        ),
    }
    return hashlib.sha256(json.dumps(stable, sort_keys=True).encode("utf-8")).hexdigest()
