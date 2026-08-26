"""Protocolos semánticos de aplicación, administración e infraestructura."""

from __future__ import annotations

from typing import Any, Protocol

from app.application_dto import (
    AdministrativeOverrideCommand,
    ClassifyCommand,
    ExecuteCommand,
    ExecutionView,
    ResolvedIdentity,
    TaskView,
)


class ApplicationProtocol(Protocol):
    def classify(self, command: ClassifyCommand) -> TaskView: ...
    def execute(self, command: ExecuteCommand) -> ExecutionView: ...
    def get_task(self, task_id: str) -> TaskView: ...
    def list_tasks(self, limit: int | None = None, offset: int = 0) -> list[TaskView]: ...
    def cancel_execution(self, execution_id: str, *, correlation_id: str = "") -> TaskView: ...


class AdministrativeProtocol(Protocol):
    def override_route(
        self, command: AdministrativeOverrideCommand, identity: ResolvedIdentity
    ) -> ExecutionView: ...


class ObservabilityProtocol(Protocol):
    def liveness(self) -> dict[str, Any]: ...
    def readiness(self) -> dict[str, Any]: ...


class AuthorizationPort(Protocol):
    def require(self, identity: ResolvedIdentity, capability: str, resource: str) -> None: ...


class QueuePort(Protocol):
    def enqueue(self, command: ExecuteCommand) -> TaskView: ...


class DomainEventPublisher(Protocol):
    def publish(self, event: dict[str, Any]) -> None: ...

