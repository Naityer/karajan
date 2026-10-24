"""Provider resolution and execution, using mocks instead of real backends."""

import pytest

from app.providers import resolve
from app.providers import registry
from app.models import AuthMethod, Backend, KarajanConfig, ProviderInfo, RecommendedModel
from app.providers.api import ApiModelProvider
from app.providers.cli import CliModelProvider
from app.catalog import get_provider


def _provider(name: str, backend: Backend, **kwargs) -> ProviderInfo:
    return ProviderInfo(
        name=name,
        label=name.title(),
        is_free=kwargs.pop("is_free", True),
        auth_method=kwargs.pop("auth_method", AuthMethod.NONE),
        backend=backend,
        **kwargs,
    )


def test_resolve_api_backend_returns_api_provider() -> None:
    # The catalog has API providers covering every tier, so a real API backend
    # resolves to a wired ApiModelProvider.
    resolution = resolve(RecommendedModel.STRONG_MODEL, KarajanConfig(backend=Backend.API))
    assert resolution is not None
    assert resolution.backend == Backend.API
    assert isinstance(resolution.provider, ApiModelProvider)


def test_resolve_cli_backend_returns_cli_provider() -> None:
    resolution = resolve(RecommendedModel.CHEAP_MODEL, KarajanConfig(backend=Backend.CLI))
    assert resolution is not None
    assert resolution.backend == Backend.CLI
    assert isinstance(resolution.provider, CliModelProvider)


def test_resolve_returns_none_when_no_provider_supports_tier(monkeypatch) -> None:
    """No provider for the tier means *no* resolution — never an invented one.

    A fake fallback here is what used to make the audit trail lie about work
    that never happened; callers withhold execution instead.
    """
    monkeypatch.setattr(registry.catalog, "providers_for_backend", lambda backend: [])
    config = KarajanConfig(backend=Backend.API, provider_preferences={})
    assert resolve(RecommendedModel.STRONG_MODEL, config) is None


def test_resolve_honors_an_explicit_tier_preference() -> None:
    config = KarajanConfig(
        backend=Backend.CLI,
        provider_preferences={RecommendedModel.CHEAP_MODEL.value: "ollama-qwen"},
    )
    resolution = resolve(RecommendedModel.CHEAP_MODEL, config)
    assert resolution is not None
    assert resolution.provider_name == "ollama-qwen"
    assert resolution.model_id == "qwen2.5:7b"


def test_fallback_chain_never_contains_a_fake_provider(monkeypatch) -> None:
    monkeypatch.setattr(registry.catalog, "all_providers", lambda: [])
    candidates = registry.fallback_resolutions(RecommendedModel.STRONG_MODEL, KarajanConfig())
    assert candidates == []


@pytest.mark.real_provider_methods
def test_cli_provider_without_command_errors() -> None:
    provider = CliModelProvider(_provider("ollama", Backend.CLI))  # no cli_command set
    run = provider.run("hi", "llama3", timeout_s=5)
    assert run.error == "no cli_command configured"
    assert run.output == ""


@pytest.mark.real_provider_methods
def test_cli_provider_missing_binary_errors() -> None:
    provider = CliModelProvider(
        _provider("ghost", Backend.CLI, cli_command="definitely-not-a-real-binary-xyz run {model}")
    )
    run = provider.run("hi", "m", timeout_s=5)
    assert run.error is not None
    assert "not found in PATH" in run.error


@pytest.mark.real_provider_methods
def test_api_provider_without_key_errors(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    provider = ApiModelProvider(
        _provider("openai", Backend.API, auth_method=AuthMethod.API_KEY, env_var="OPENAI_API_KEY")
    )
    run = provider.run("hi", "gpt-x", timeout_s=5)
    assert run.error is not None
    assert "missing API key" in run.error


@pytest.mark.real_provider_methods
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


@pytest.mark.real_provider_methods
def test_cli_provider_strips_terminal_control_sequences(monkeypatch) -> None:
    """`ollama run` draws a spinner while streaming; without this, the escape
    codes end up inside the model's answer and inside the agent trace."""
    import subprocess

    from app.providers import cli as cli_module

    class _Completed:
        returncode = 0
        stdout = "Hola\x1b[7D\x1b[K mundo\r\n"
        stderr = ""

    monkeypatch.setattr(cli_module.shutil, "which", lambda binary: "/usr/bin/fake")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: _Completed())

    provider = CliModelProvider(_provider("ollama", Backend.CLI, cli_command="fake run {model}"))
    run = provider.run("hi", "m", timeout_s=5)

    assert run.error is None
    assert run.output == "Hola mundo"


def test_codex_cli_uses_model_flag_and_reads_instruction_from_stdin() -> None:
    provider = get_provider("codex")

    assert provider is not None
    assert provider.cli_command == "codex exec --ephemeral --color never -"
    assert set(provider.tiers.values()) == {"default"}
