"""Fachada pública del motor Karajan."""

from __future__ import annotations

from app.application_dto import (
    AdministrativeOverrideCommand,
    ClassifyCommand,
    ExecuteCommand,
    ExecutionView,
    ResolvedIdentity,
    TaskView,
    decision_fingerprint,
)
from app.application_services import (
    AdministrativeOverrideService,
    CapabilityAuthorization,
    ClassificationService,
    ExecutionService,
    ReviewService,
    TaskQueryService,
    WorkspaceLocks,
)
from app.management import ManagementService


class KarajanApplication:
    """Thin façade: all decisions are delegated to specialized services."""

    def __init__(self, runtime, *, authorization=None) -> None:
        locks = WorkspaceLocks()
        self.runtime = runtime
        self.classification = ClassificationService(runtime, locks)
        self.execution = ExecutionService(runtime, locks)
        self.tasks = TaskQueryService(runtime)
        self.administration = AdministrativeOverrideService(
            runtime, self.execution, authorization or CapabilityAuthorization()
        )
        self.management = ManagementService(runtime)
        self.reviews = ReviewService(self.execution, authorization or CapabilityAuthorization())

    def classify(self, command: ClassifyCommand) -> TaskView:
        return TaskView.from_record(self.classification.classify(command))

    def execute(self, command: ExecuteCommand) -> ExecutionView:
        record = self.execution.execute(command)
        return self._execution_view(record, command.correlation_id)

    def get_task(self, task_id: str) -> TaskView:
        return TaskView.from_record(self.tasks.get(task_id))

    def list_tasks(self, limit: int | None = None, offset: int = 0) -> list[TaskView]:
        return [TaskView.from_record(item) for item in self.tasks.list(limit, offset)]

    def cancel_execution(self, execution_id: str, *, correlation_id: str = "") -> TaskView:
        task_id = execution_id.removeprefix("exe_")
        return TaskView.from_record(self.execution.cancel(task_id, correlation_id))

    def override_route(
        self, command: AdministrativeOverrideCommand, identity: ResolvedIdentity
    ) -> ExecutionView:
        record = self.administration.override(command, identity)
        return self._execution_view(record, command.correlation_id)

    def approve_review(self, task_id: str, identity: ResolvedIdentity) -> TaskView:
        return TaskView.from_record(self.reviews.approve(task_id, identity))

    def liveness(self) -> dict:
        return {"status": "alive", "schema_version": 1}

    def readiness(self) -> dict:
        # Classification is always available (including the deterministic offline
        # profile). Execution readiness is conservative: a configured preference
        # is not itself proof that a provider is reachable.
        ready = bool(self.runtime.config.provider_preferences)
        return {
            "status": "ready" if ready else "degraded",
            "accepts_classification": True,
            "accepts_execution": ready,
            "schema_version": 1,
        }

    @staticmethod
    def _execution_view(record, correlation_id: str) -> ExecutionView:
        return ExecutionView(
            execution_id=f"exe_{record.task_id}",
            correlation_id=correlation_id,
            task=TaskView.from_record(record),
            decision_fingerprint=decision_fingerprint(record),
        )
