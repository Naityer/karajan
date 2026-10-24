from pathlib import Path

from fastapi.testclient import TestClient

from app import main, setup_status
from app.tutorial import NAV_SECTIONS, navigation_tutorial_markdown


def test_navigation_tutorial_mentions_every_nav_view() -> None:
    markdown = navigation_tutorial_markdown()
    for title, _description in NAV_SECTIONS:
        assert title in markdown
    assert markdown.startswith("# KARAJAN")


def test_setup_status_marker_lifecycle(tmp_path: Path, monkeypatch) -> None:
    marker = tmp_path / ".setup_complete"
    tutorial = tmp_path / "TUTORIAL_NAVEGACION.md"
    monkeypatch.setattr(setup_status, "MARKER_PATH", marker)
    monkeypatch.setattr(setup_status, "TUTORIAL_PATH", tutorial)

    assert setup_status.is_complete() is False

    written = setup_status.mark_complete()
    assert written == tutorial
    assert setup_status.is_complete() is True
    assert tutorial.exists()
    assert "KARAJAN" in tutorial.read_text(encoding="utf-8")

    # Idempotent — calling again doesn't error and keeps the marker in place.
    setup_status.mark_complete()
    assert setup_status.is_complete() is True


def test_setup_status_endpoints(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(setup_status, "MARKER_PATH", tmp_path / ".setup_complete")
    monkeypatch.setattr(setup_status, "TUTORIAL_PATH", tmp_path / "TUTORIAL_NAVEGACION.md")
    client = TestClient(main.app)

    response = client.get("/setup/status")
    assert response.status_code == 200
    assert response.json()["completed"] is False

    # Tutorial content is available regardless of completion state.
    response = client.get("/setup/tutorial")
    assert response.status_code == 200
    assert "Control humano" in response.json()["markdown"]

    response = client.post("/setup/complete")
    assert response.status_code == 200
    assert response.json()["completed"] is True

    response = client.get("/setup/status")
    assert response.json()["completed"] is True
