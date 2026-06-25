"""Provider resolution and execution, using mocks instead of real backends."""

from app.providers import resolve
from app.providers import registry
from app.models import AuthMethod, Backend, KarajanConfig, ProviderInfo, RecommendedModel
from app.providers.api import ApiModelProvider
from app.providers.cli import CliModelProvider
from app.providers.simulated import SimulatedModelProvider


def _provider(name: str, backend: Backend, **kwargs) -> ProviderInfo:
    return ProviderInfo(
        name=name,
        label=name.title(),
        is_free=kwargs.pop("is_free", True),
        auth_method=kwargs.pop("auth_method", AuthMethod.NONE),
        backend=backend,
        **kwargs,
    )


def test_resolve_uses_simulated_for_simulated_backend() -> None:
    resolution = resolve(RecommendedModel.STRONG_MODEL, KarajanConfig(backend=Backend.SIMULATED))
    assert resolution.backend == Backend.SIMULATED
    assert isinstance(resolution.provider, SimulatedModelProvider)


def test_resolve_api_backend_returns_api_provider() -> None:
    # The catalog has API providers covering every tier, so a real API backend
    # resolves to a wired ApiModelProvider (not the simulated fallback).
    resolution = resolve(RecommendedModel.STRONG_MODEL, KarajanConfig(backend=Backend.API))
    assert resolution.backend == Backend.API
    assert isinstance(resolution.provider, ApiModelProvider)


def test_resolve_falls_back_to_simulated_when_no_provider_supports_tier(monkeypatch) -> None:
    # Force the "no catalog provider on this backend supports the tier" path.
    monkeypatch.setattr(registry.catalog, "providers_for_backend", lambda backend: [])
    config = KarajanConfig(backend=Backend.API, provider_preferences={})
    resolution = resolve(RecommendedModel.STRONG_MODEL, config)
    assert resolution.backend == Backend.SIMULATED
    assert isinstance(resolution.provider, SimulatedModelProvider)


def test_simulated_provider_is_deterministic_and_free() -> None:
    run = SimulatedModelProvider().run("hola", "m-cheap", timeout_s=5)
    assert run.error is None
    assert run.model_used == "simulated:m-cheap"
    assert "hola" in run.output


def test_cli_provider_without_command_errors() -> None:
    provider = CliModelProvider(_provider("ollama", Backend.CLI))  # no cli_command set
    run = provider.run("hi", "llama3", timeout_s=5)
    assert run.error == "no cli_command configured"
    assert run.output == ""


def test_cli_provider_missing_binary_errors() -> None:
    provider = CliModelProvider(
        _provider("ghost", Backend.CLI, cli_command="definitely-not-a-real-binary-xyz run {model}")
    )
    run = provider.run("hi", "m", timeout_s=5)
    assert run.error is not None
    assert "not found in PATH" in run.error


def test_api_provider_without_key_errors(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    provider = ApiModelProvider(
        _provider("openai", Backend.API, auth_method=AuthMethod.API_KEY, env_var="OPENAI_API_KEY")
    )
    run = provider.run("hi", "gpt-x", timeout_s=5)
    assert run.error is not None
    assert "missing API key" in run.error


def test_api_provider_dispatches_to_mocked_client(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    provider = ApiModelProvider(
        _provider("openai", Backend.API, auth_method=AuthMethod.API_KEY, env_var="OPENAI_API_KEY")
    )
    monkeypatch.setattr(
        provider, "_openai_compatible", lambda instruction, model_id, key, timeout_s: "mocked answer"
    )
    run = provider.run("hi", "gpt-x", timeout_s=5)
    assert run.error is None
    assert run.output == "mocked answer"
