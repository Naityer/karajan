from fastapi.testclient import TestClient

from app import main
from app.models import KarajanConfig


def test_provider_run_executes_catalog_probe_command() -> None:
    main.active_config = KarajanConfig()
    client = TestClient(main.app)

    response = client.post("/providers/ollama/run", json={"slot": "probe_command"})

    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "ollama"
    assert body["command"] == "ollama list"
    # `ollama` likely isn't installed in CI/dev — either outcome is a valid run, not a crash.
    assert isinstance(body["ok"], bool)


def test_provider_run_rejects_unknown_provider() -> None:
    main.active_config = KarajanConfig()
    client = TestClient(main.app)

    response = client.post("/providers/not-a-real-provider/run", json={"slot": "login_command"})

    assert response.status_code == 404


def test_provider_run_reports_missing_command_slot() -> None:
    main.active_config = KarajanConfig()
    client = TestClient(main.app)

    response = client.post("/providers/openai/run", json={"slot": "probe_command"})

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert "no probe_command" in body["detail"]


def test_provider_run_rejects_invalid_slot() -> None:
    main.active_config = KarajanConfig()
    client = TestClient(main.app)

    response = client.post("/providers/ollama/run", json={"slot": "cli_command"})

    assert response.status_code == 422
