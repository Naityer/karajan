from __future__ import annotations

import ast
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.application_dto import ClassifyCommand
from app.application_errors import ConflictError
from app.container import KarajanContainer, StorageAlreadyOwnedError
from app.local_client import LocalKarajanClient
from app.models import Profile
from app.modules.v1.api import router as v1_router
from app.runtime import set_current


def _container(tmp_path: Path, *, in_memory: bool = True) -> KarajanContainer:
    container = KarajanContainer.build(data_dir=tmp_path, in_memory=in_memory)
    config = container.runtime.config.model_copy(update={"profile": Profile.OFFLINE})
    container.runtime.set_config(config)
    return container


def test_idempotency_is_scoped_and_rejects_payload_drift(tmp_path: Path) -> None:
    with _container(tmp_path) as container:
        app = container.application
        first = app.classify(
            ClassifyCommand("same request", workspace_id="alpha", idempotency_key="key")
        )
        repeated = app.classify(
            ClassifyCommand("same request", workspace_id="alpha", idempotency_key="key")
        )
        other_workspace = app.classify(
            ClassifyCommand("same request", workspace_id="beta", idempotency_key="key")
        )

        assert repeated.task_id == first.task_id
        assert other_workspace.task_id != first.task_id
        with pytest.raises(ConflictError):
            app.classify(
                ClassifyCommand("different request", workspace_id="alpha", idempotency_key="key")
            )


def test_classification_and_outbox_commit_together(tmp_path: Path) -> None:
    with _container(tmp_path) as container:
        view = container.application.classify(
            ClassifyCommand("atomic classification", correlation_id="cor_test")
        )
        events = container.runtime.tasks.list_pending_outbox()

        assert container.application.get_task(view.task_id).task_id == view.task_id
        assert [(item["event_type"], item["correlation_id"]) for item in events] == [
            ("TaskClassified", "cor_test")
        ]


def test_local_and_http_classification_make_same_semantic_decision(tmp_path: Path) -> None:
    with _container(tmp_path) as container:
        set_current(container.runtime)
        local = LocalKarajanClient(container.application).classify(
            ClassifyCommand("Classify this deterministic task")
        )
        http_app = FastAPI()
        http_app.include_router(v1_router)
        response = TestClient(http_app).post(
            "/v1/tasks/classify", json={"prompt": "Classify this deterministic task"}
        )
        assert response.status_code == 200, response.text
        remote = response.json()

        keys = (
            "complexity_level",
            "recommended_model",
            "recommended_strategy",
            "requires_human_review",
        )
        assert {key: local.classification[key] for key in keys} == {
            key: remote["classification"][key] for key in keys
        }


def test_second_process_owner_is_rejected(tmp_path: Path) -> None:
    first = _container(tmp_path, in_memory=False)
    try:
        with pytest.raises(StorageAlreadyOwnedError):
            _container(tmp_path, in_memory=False)
    finally:
        first.close()


def test_application_layer_has_no_transport_imports() -> None:
    root = Path(__file__).parents[1] / "app"
    banned = {"fastapi", "httpx", "uvicorn", "typer", "mcp", "karajan_cli"}
    files = [
        root / "application.py",
        root / "application_contracts.py",
        root / "application_dto.py",
        root / "application_errors.py",
        root / "application_services.py",
        root / "management.py",
    ]
    for path in files:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        imports = {
            alias.name.split(".")[0]
            for node in ast.walk(tree)
            if isinstance(node, ast.Import)
            for alias in node.names
        }
        imports.update(
            node.module.split(".")[0]
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module
        )
        assert not imports.intersection(banned), (path, imports.intersection(banned))
