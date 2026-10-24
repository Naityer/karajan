from __future__ import annotations

import subprocess

from app.models import KarajanConfig, OpenClawInstallRequest
from app.openclaw_client import OpenClawClient


def test_status_reports_missing_cli(monkeypatch) -> None:
    monkeypatch.setattr("app.openclaw_client.shutil.which", lambda _: None)

    status = OpenClawClient(KarajanConfig()).status()

    assert status.enabled is True
    assert status.cli_available is False
    assert status.ready is False
    assert "not found" in status.detail


def test_status_accepts_gateway_json(monkeypatch) -> None:
    monkeypatch.setattr("app.openclaw_client.shutil.which", lambda _: "openclaw")
    monkeypatch.setattr(
        "app.openclaw_client.subprocess.run",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args=args[0],
            returncode=0,
            stdout='{"version":"2026.6.10","status":"running"}',
            stderr="",
        ),
    )

    status = OpenClawClient(KarajanConfig()).status()

    assert status.ready is True
    assert status.version == "2026.6.10"
    assert status.gateway_status == "running"


def test_status_handles_invalid_json(monkeypatch) -> None:
    monkeypatch.setattr("app.openclaw_client.shutil.which", lambda _: "openclaw")
    monkeypatch.setattr(
        "app.openclaw_client.subprocess.run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args=args[0], returncode=0, stdout="not-json", stderr=""),
    )

    status = OpenClawClient(KarajanConfig()).status()

    assert status.ready is False
    assert "invalid JSON" in status.detail


def test_skills_list_is_normalized(monkeypatch) -> None:
    monkeypatch.setattr("app.openclaw_client.shutil.which", lambda _: "openclaw")
    monkeypatch.setattr(
        "app.openclaw_client.subprocess.run",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args=args[0],
            returncode=0,
            stdout='{"skills":[{"name":"repo-analyzer","description":"repos","installed":true}]}',
            stderr="",
        ),
    )

    skills = OpenClawClient(KarajanConfig()).skills()

    assert len(skills) == 1
    assert skills[0].name == "repo-analyzer"
    assert skills[0].installed is True


def test_install_result_redacts_secret(monkeypatch) -> None:
    monkeypatch.setenv("OPENCLAW_GATEWAY_TOKEN", "super-secret-token")
    monkeypatch.setattr("app.openclaw_client.shutil.which", lambda _: "openclaw")
    monkeypatch.setattr(
        "app.openclaw_client.subprocess.run",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args=args[0],
            returncode=1,
            stdout="",
            stderr="failed with super-secret-token",
        ),
    )

    result = OpenClawClient(KarajanConfig()).install_skill(OpenClawInstallRequest(spec="@owner/test"))

    assert result.ok is False
    assert "super-secret-token" not in result.detail
    assert "[redacted]" in result.detail
