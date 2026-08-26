"""In-process SDK adapter used to prove semantic parity with HTTP."""

from __future__ import annotations

from app.application_contracts import ApplicationProtocol
from app.application_dto import ClassifyCommand, ExecuteCommand


class LocalKarajanClient:
    def __init__(self, application: ApplicationProtocol) -> None:
        self.application = application

    def classify(self, command: ClassifyCommand):
        return self.application.classify(command)

    def execute(self, command: ExecuteCommand):
        return self.application.execute(command)

    def get_task(self, task_id: str):
        return self.application.get_task(task_id)

    def list_tasks(self, limit: int | None = None, offset: int = 0):
        return self.application.list_tasks(limit=limit, offset=offset)

    def cancel_execution(self, execution_id: str, *, correlation_id: str = ""):
        return self.application.cancel_execution(execution_id, correlation_id=correlation_id)
