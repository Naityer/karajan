"""Compatibility entry point exercises real embedded data without a server."""
import json
import socket
import subprocess

from app.application.container import KarajanContainer
from app.domain.models import Profile
from karajan_cli.main import main


def test_embedded_classification_uses_existing_store(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("KARAJAN_TOKEN", raising=False)
    monkeypatch.delenv("KARAJAN_URL", raising=False)
    monkeypatch.delenv("KARAJAN_TRANSPORT", raising=False)
    data = tmp_path / "data"
    container = KarajanContainer.build(data_dir=data)
    container.runtime.set_config(container.runtime.config.model_copy(update={"profile": Profile.OFFLINE}))
    container.close()
    def forbidden(*args, **kwargs):
        raise AssertionError("La prueba no debe abrir red ni ejecutar proveedores")

    monkeypatch.setattr(subprocess, "Popen", forbidden)
    monkeypatch.setattr(socket, "socket", forbidden)
    assert main(["--json", "--data-dir", str(data), "classify", "--entry", "codex", "Revisar pruebas"]) == 0
    value = json.loads(capsys.readouterr().out)
    assert value["task_id"]
    assert value["classification"]["complexity_level"]


def test_missing_data_is_rejected_without_creating_it(tmp_path, capsys):
    missing = tmp_path / "missing"
    assert main(["--data-dir", str(missing), "activate", "--start"]) == 1
    assert "task_logs.db" in capsys.readouterr().err
    assert not missing.exists()


def test_assign_passes_through_legacy_provider_and_prompt(monkeypatch, capsys):
    calls = []

    class Client:
        def classify(self, prompt, entry):
            calls.append(("classify", prompt, entry))
            return {"task_id": "task-1"}

        def delegate(self, task_id, **kwargs):
            calls.append(("delegate", task_id, kwargs))
            return {"task_id": task_id, "status": "delegated"}

    monkeypatch.setattr("karajan_cli.main.build_client", lambda **kwargs: Client())
    assert main(["--transport", "http", "--json", "assign", "--prompt", "hello", "--to", "codex"]) == 0
    assert json.loads(capsys.readouterr().out)["task_id"] == "task-1"
    assert calls[-1] == ("delegate", "task-1", {"force_entity_id": None, "force_provider": "codex"})
