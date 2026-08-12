"""Shared provider test doubles.

KARAJAN ships no fake provider any more: `registry.resolve` returns `None` when
nothing is ready and delegation is withheld with an explicit reason, so a real
run can never be confused with an invented one. Tests that need a working
backend therefore get one *here*, in the test tree.

Two autouse guards, both opt-out-able:

- `stub_providers` resolves every tier to `StubProvider`, giving tests the same
  convenience the old simulated backend did. A test that wants the "nothing is
  ready" path just patches `delegation.resolve` to `None` itself — its patch
  runs after this fixture and wins.
- `no_real_providers` makes `CliModelProvider.run` / `ApiModelProvider.run`
  raise. Without it, an unstubbed `Backend.CLI` config resolves to a real
  catalog provider and `subprocess.run("ollama run ...")` blocks the suite for
  the full `subtask_timeout_s`. Mark a test `@pytest.mark.real_provider_methods`
  to test those methods directly.

`tests/test_delegation.py::_patch_resolve` stays as the local convention for
tests that need a *specific* provider behavior (failing, flaky).
"""

from __future__ import annotations

import pytest

from app import classifier, delegation
from app.models import Backend, RecommendedModel
from app.providers.api import ApiModelProvider
from app.providers.base import ModelProvider, ProviderRun
from app.providers.cli import CliModelProvider
from app.providers.registry import Resolution


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "real_provider_methods: let this test call CliModelProvider.run / ApiModelProvider.run directly.",
    )


class StubProvider(ModelProvider):
    """Deterministic, offline stand-in. Echoes the instruction back, like the
    old simulated provider did — but it exists only under `tests/`."""

    backend = Backend.CLI

    def run(self, instruction: str, model_id: str, timeout_s: int) -> ProviderRun:
        return ProviderRun(
            output=f"[stub:{model_id}] {instruction}",
            model_used=f"stub:{model_id}",
            latency_ms=3,
        )


def stub_resolution(tier: RecommendedModel) -> Resolution:
    return Resolution(StubProvider(), Backend.CLI, tier.value, "stub")


@pytest.fixture(autouse=True)
def isolate_auth_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep dotenv production security from breaking zero-auth legacy TestClient tests.

    Individual auth tests can override this in their own body because test
    monkeypatch calls occur after autouse fixture setup.
    """
    monkeypatch.setenv("KARAJAN_REQUIRE_ATLAS_TOKEN", "0")
    monkeypatch.delenv("KARAJAN_TOKEN", raising=False)


@pytest.fixture(autouse=True)
def no_real_providers(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> None:
    """Hard stop: no test may shell out to, or call, a real backend."""
    if request.node.get_closest_marker("real_provider_methods"):
        return

    def _forbidden(self, instruction: str, model_id: str, timeout_s: int) -> ProviderRun:
        raise AssertionError(
            f"test tried to run the real provider {type(self).__name__} ({model_id}); "
            "patch `delegation.resolve` or mark the test `real_provider_methods`"
        )

    monkeypatch.setattr(CliModelProvider, "run", _forbidden)
    monkeypatch.setattr(ApiModelProvider, "run", _forbidden)


@pytest.fixture(autouse=True)
def stub_providers(monkeypatch: pytest.MonkeyPatch) -> type[StubProvider]:
    """Resolve every tier to `StubProvider`, and keep classification heuristic.

    `classifier.resolve` is pinned to `None` on purpose: every existing test
    asserts on deterministic heuristic scores, and letting the stub answer the
    classifier would make those depend on parsing echoed text.
    """
    monkeypatch.setattr(delegation, "resolve", lambda tier, config: stub_resolution(tier))
    monkeypatch.setattr(classifier, "resolve", lambda tier, config: None)
    return StubProvider
