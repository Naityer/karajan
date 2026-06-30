from fastapi.testclient import TestClient

from app import main
from app.models import KarajanConfig


def test_openclaw_status_endpoint(monkeypatch) -> None:
    main.active_config = KarajanConfig()
    monkeypatch.setattr("app.openclaw_client.shutil.which", lambda _: None)
    client = TestClient(main.app)

    response = client.get("/integrations/openclaw/status")

    assert response.status_code == 200
    body = response.json()
    assert body["enabled"] is True
    assert body["cli_available"] is False


def test_openclaw_skills_endpoint_handles_missing_cli(monkeypatch) -> None:
    main.active_config = KarajanConfig()
    monkeypatch.setattr("app.openclaw_client.shutil.which", lambda _: None)
    client = TestClient(main.app)

    response = client.get("/integrations/openclaw/skills")

    assert response.status_code == 200
    assert response.json() == []


def test_openclaw_install_endpoint_returns_safe_error(monkeypatch) -> None:
    main.active_config = KarajanConfig()
    monkeypatch.setattr("app.openclaw_client.shutil.which", lambda _: None)
    client = TestClient(main.app)

    response = client.post("/integrations/openclaw/skills/install", json={"spec": "@owner/test"})

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert "not found" in body["detail"]
