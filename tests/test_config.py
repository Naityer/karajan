from app import config as config_module
from app import credentials
from app.models import AuthMethod, Backend, CredentialStatus, KarajanConfig, Profile


def _status(provider: str, *, available: bool, ready: bool, method: AuthMethod) -> CredentialStatus:
    return CredentialStatus(
        provider=provider, available=available, ready=ready, auth_method=method, detail=""
    )


def test_auto_detect_skips_local_provider_that_is_not_ready(monkeypatch) -> None:
    # ollama installed but no model pulled (available, not ready) and no API keys.
    monkeypatch.setattr(
        credentials,
        "detect_all",
        lambda: [_status("ollama", available=True, ready=False, method=AuthMethod.LOCAL)],
    )

    result = config_module.auto_detect(KarajanConfig(profile=Profile.SIMPLE))

    assert result.backend == Backend.SIMULATED
    assert result.provider_preferences == {}


def test_auto_detect_prefers_ready_api_when_local_not_ready(monkeypatch) -> None:
    monkeypatch.setattr(
        credentials,
        "detect_all",
        lambda: [
            _status("ollama", available=True, ready=False, method=AuthMethod.LOCAL),
            _status("anthropic", available=True, ready=True, method=AuthMethod.API_KEY),
        ],
    )

    result = config_module.auto_detect(KarajanConfig(profile=Profile.SIMPLE))

    assert result.backend == Backend.API
    assert result.provider_preferences  # tiers mapped to anthropic


def test_auto_detect_uses_ready_local_backend(monkeypatch) -> None:
    monkeypatch.setattr(
        credentials,
        "detect_all",
        lambda: [_status("ollama", available=True, ready=True, method=AuthMethod.LOCAL)],
    )

    result = config_module.auto_detect(KarajanConfig(profile=Profile.SIMPLE))

    assert result.backend == Backend.CLI
    assert result.provider_preferences
