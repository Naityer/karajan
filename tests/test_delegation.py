"""Delegation engine: execution, failure propagation, parallelism, retries."""

from app import delegation
from app.delegation import delegate
from app.models import Backend, KarajanConfig, OrchestrationConfig
from app.models import RoutingEntity, RoutingLayout
from app.providers.base import ModelProvider, ProviderRun
from app.providers.registry import Resolution
from app.router import classify_prompt
from tests.conftest import stub_resolution

PROMPT = "Corrige un bug en una API y valida con tests de integracion."


class _FailingProvider(ModelProvider):
    backend = Backend.API

    def run(self, instruction: str, model_id: str, timeout_s: int) -> ProviderRun:
        return ProviderRun(output="", model_used=f"fake:{model_id}", latency_ms=10, error="boom")


class _FlakyProvider(ModelProvider):
    """Fails on the first attempt, succeeds on retry."""

    backend = Backend.API

    def __init__(self) -> None:
        self.calls = 0

    def run(self, instruction: str, model_id: str, timeout_s: int) -> ProviderRun:
        self.calls += 1
        if self.calls == 1:
            return ProviderRun(output="", model_used=f"fake:{model_id}", latency_ms=5, error="transient")
        return ProviderRun(output="ok", model_used=f"fake:{model_id}", latency_ms=8, error=None)


def _patch_resolve(monkeypatch, provider_factory) -> None:
    monkeypatch.setattr(
        delegation,
        "resolve",
        lambda tier, config: Resolution(provider_factory(), Backend.API, tier.value, "fake"),
    )


def test_delegate_runs_every_subtask(stub_providers) -> None:
    classification = classify_prompt(PROMPT)
    result, decisions = delegate(classification, KarajanConfig(backend=Backend.CLI))

    assert result.status.value == "completed"
    assert len(result.executions) == len(classification.subtasks)
    assert sum(decision.phase == "assign" for decision in decisions) == len(classification.subtasks)
    assert sum(decision.phase == "delegate" for decision in decisions) == len(classification.subtasks)
    assert sum(decision.phase == "validate" for decision in decisions) == len(classification.subtasks)
    assert all(ex.backend == Backend.CLI for ex in result.executions)
    assert result.total_estimated_cost_usd > 0


def test_delegate_is_withheld_when_no_provider_serves_a_tier(monkeypatch) -> None:
    """The core of removing the simulated backend: nothing is invented.

    With no resolvable provider the task is blocked with an explicit decision
    and zero executions, instead of producing a fake completed run.
    """
    monkeypatch.setattr(delegation, "resolve", lambda tier, config: None)
    classification = classify_prompt(PROMPT)

    result, decisions = delegate(classification, KarajanConfig(backend=Backend.CLI))

    assert result.executions == []
    assert result.total_estimated_cost_usd == 0.0
    blocked = [d for d in decisions if d.decision.startswith("provider_gate=blocked")]
    assert len(blocked) == 1
    assert "Ningún proveedor listo" in blocked[0].reason


def test_run_subtask_fails_loudly_without_a_resolution(monkeypatch) -> None:
    """Callers that bypass `delegate` (the scheduler) still never get a fake run."""
    monkeypatch.setattr(delegation, "resolve", lambda tier, config: None)
    classification = classify_prompt(PROMPT)
    subtask = classification.subtasks[0]

    execution, decisions = delegation.run_subtask(
        classification, 1, subtask, KarajanConfig(backend=Backend.CLI), layout=None
    )

    assert execution.status.value == "failed"
    assert execution.estimated_cost_usd == 0.0
    assert execution.model_used == ""
    assert "sin proveedor listo" in (execution.error or "")
    assert any(d.decision.endswith("->unresolved") for d in decisions)


def test_delegate_marks_failed_when_provider_errors(monkeypatch) -> None:
    _patch_resolve(monkeypatch, _FailingProvider)
    classification = classify_prompt(PROMPT)
    config = KarajanConfig(
        backend=Backend.API,
        orchestration=OrchestrationConfig(max_retries=0, enable_runtime_fallback=False),
    )

    result, _ = delegate(classification, config)

    assert result.status.value == "failed"
    assert all(ex.status.value == "failed" for ex in result.executions)
    assert all(ex.error == "boom" for ex in result.executions)


def test_delegate_falls_back_to_a_backup_provider_when_primary_errors(monkeypatch) -> None:
    _patch_resolve(monkeypatch, _FailingProvider)
    monkeypatch.setattr(
        delegation,
        "fallback_resolutions",
        lambda tier, config, tried, layout=None: [stub_resolution(tier)],
    )
    classification = classify_prompt(PROMPT)
    config = KarajanConfig(backend=Backend.API, orchestration=OrchestrationConfig(max_retries=0))

    result, decisions = delegate(classification, config)

    assert result.status.value == "completed"
    assert all(ex.status.value == "completed" for ex in result.executions)
    assert all(ex.backend == Backend.CLI for ex in result.executions)
    assert any(decision.phase == "fallback" for decision in decisions)
    assert any(decision.phase == "reassign" for decision in decisions)


def test_forced_provider_surfaces_error_without_silent_fallback(monkeypatch) -> None:
    classification = classify_prompt(PROMPT)
    config = KarajanConfig(
        backend=Backend.API,
        orchestration=OrchestrationConfig(max_retries=0, enable_runtime_fallback=True),
    )
    forced = Resolution(_FailingProvider(), Backend.API, "forced-model", "forced")
    monkeypatch.setattr(
        delegation,
        "fallback_resolutions",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("fallback must not run")),
    )

    result, decisions = delegate(classification, config, preresolved=forced)

    assert result.status.value == "failed"
    assert all(ex.model_used.startswith("fake:") for ex in result.executions)
    assert all(ex.error == "boom" for ex in result.executions)
    assert not any(decision.phase == "fallback" for decision in decisions)


def test_delegate_fails_when_the_fallback_chain_is_exhausted(monkeypatch) -> None:
    """An empty chain surfaces the real provider error, not a fake success."""
    _patch_resolve(monkeypatch, _FailingProvider)
    monkeypatch.setattr(delegation, "fallback_resolutions", lambda tier, config, tried, layout=None: [])
    classification = classify_prompt(PROMPT)
    config = KarajanConfig(backend=Backend.API, orchestration=OrchestrationConfig(max_retries=0))

    result, _ = delegate(classification, config)

    assert result.status.value == "failed"
    assert all(ex.error == "boom" for ex in result.executions)


def test_delegate_parallel_executes_all_subtasks(stub_providers) -> None:
    classification = classify_prompt(PROMPT)
    assert len(classification.subtasks) > 1  # guard: parallelism only kicks in with >1
    config = KarajanConfig(
        backend=Backend.CLI,
        orchestration=OrchestrationConfig(parallel=True, max_parallel=4),
    )

    result, _ = delegate(classification, config)

    assert len(result.executions) == len(classification.subtasks)
    assert {ex.subtask_id for ex in result.executions} == {s.id for s in classification.subtasks}


def test_delegate_retries_transient_failure(monkeypatch) -> None:
    _patch_resolve(monkeypatch, _FlakyProvider)
    classification = classify_prompt(PROMPT)
    config = KarajanConfig(backend=Backend.API, orchestration=OrchestrationConfig(max_retries=1))

    result, _ = delegate(classification, config)

    # Each subtask's provider failed once then succeeded on retry.
    assert result.status.value == "completed"
    assert all(ex.status.value == "completed" for ex in result.executions)


def test_delegate_records_role_flow_from_layout(stub_providers) -> None:
    classification = classify_prompt(PROMPT)
    layout = RoutingLayout(
        entities=[
            RoutingEntity(
                id="agent",
                name="Parent",
                role="parent",
                provider="openai",
                levels=["level_4_complex", "level_5_critical"],
            ),
            RoutingEntity(
                id="worker",
                name="Worker",
                role="child",
                provider="google",
                parentId="agent",
                levels=["level_1_simple", "level_2_moderate", "level_3_intermediate"],
            ),
            RoutingEntity(
                id="backup",
                name="Backup",
                role="backup",
                provider="groq",
                parentId="agent",
                levels=["level_1_simple"],
            ),
        ]
    )

    _, decisions = delegate(classification, KarajanConfig(backend=Backend.CLI), layout=layout)

    assign_decisions = [decision.decision for decision in decisions if decision.phase == "assign"]
    validate_decisions = [decision.decision for decision in decisions if decision.phase == "validate"]
    assert assign_decisions
    assert any("owner=Worker:Worker" in decision for decision in assign_decisions)
    assert all("backup=Backup:Backup" in decision for decision in assign_decisions)
    assert all("validator=" in decision for decision in validate_decisions)
