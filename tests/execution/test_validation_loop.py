"""Real validator feedback loop: bounded retries of the owner, then a single
escalation to the root once the retry cap is exhausted and still rejected."""

from app import delegation
from app import validation
from app.delegation import delegate
from app.models import Backend, KarajanConfig, RoutingEntity, RoutingLayout, ValidationVerdict
from app.providers.base import ModelProvider, ProviderRun
from app.providers.registry import Resolution
from app.router import classify_prompt

PROMPT = "Implementa una funcion de busqueda binaria con tests unitarios."


class _OkProvider(ModelProvider):
    backend = Backend.API

    def __init__(self) -> None:
        self.calls = 0

    def run(self, instruction: str, model_id: str, timeout_s: int) -> ProviderRun:
        self.calls += 1
        return ProviderRun(output=f"output v{self.calls}", model_used=f"owner:{model_id}", latency_ms=5, error=None)


class _RootProvider(ModelProvider):
    backend = Backend.API

    def __init__(self) -> None:
        self.calls = 0

    def run(self, instruction: str, model_id: str, timeout_s: int) -> ProviderRun:
        self.calls += 1
        return ProviderRun(output="root output", model_used=f"root:{model_id}", latency_ms=5, error=None)


def _layout_with_distinct_owner_and_validator() -> RoutingLayout:
    return RoutingLayout(
        entities=[
            RoutingEntity(id="owner", name="Owner", role="child", role_tags=["child"], provider="ollama-qwen", levels=["level_1_simple", "level_2_moderate"]),
            RoutingEntity(id="validator", name="Validator", role="child", role_tags=["child", "validator"], provider="ollama-qwen"),
            RoutingEntity(id="root", name="Claude", role="parent", role_tags=["parent"], provider="claude-cli", tier=0, levels=["level_5_critical"]),
        ]
    )


def _config(**overrides) -> KarajanConfig:
    config = KarajanConfig(backend=Backend.API)
    config.orchestration.enable_validator_loop = True
    config.orchestration.max_validation_iterations = 2
    for key, value in overrides.items():
        setattr(config.orchestration, key, value)
    return config


def test_validator_rejects_twice_then_approves_bounded_retry(monkeypatch) -> None:
    owner_provider = _OkProvider()
    monkeypatch.setattr(delegation, "resolve", lambda tier, config: Resolution(owner_provider, Backend.API, tier.value, "owner-provider"))

    def fake_run_validator(output, subtask, prompt, validator_entity, config, iteration):
        # Rejects the first two attempts, approves from the third onward — each
        # subtask's loop restarts iteration at 0, so this is deterministic
        # across however many subtasks classify_prompt() produces.
        return ValidationVerdict(approved=iteration >= 2, feedback="" if iteration >= 2 else "corrige un caso borde", iteration=iteration)

    monkeypatch.setattr(validation, "run_validator", fake_run_validator)

    classification = classify_prompt(PROMPT)
    layout = _layout_with_distinct_owner_and_validator()
    result, decisions = delegate(classification, _config(), layout=layout)

    assert result.status.value == "completed"
    # Per subtask: 1 initial run + 2 revisions (bounded by max_validation_iterations=2)
    assert owner_provider.calls == 3 * len(classification.subtasks)
    revise_phases = [d for d in decisions if d.phase == "revise"]
    assert len(revise_phases) == 2 * len(classification.subtasks)
    escalate_phases = [d for d in decisions if d.phase == "escalate"]
    assert not escalate_phases  # approved before the cap forced an escalation


def test_validator_rejects_past_cap_escalates_once_to_root(monkeypatch) -> None:
    owner_provider = _OkProvider()
    root_provider = _RootProvider()
    monkeypatch.setattr(delegation, "resolve", lambda tier, config: Resolution(owner_provider, Backend.API, tier.value, "owner-provider"))
    monkeypatch.setattr(
        delegation, "resolve_entity", lambda entity, tier: Resolution(root_provider, Backend.API, tier.value, "root-provider")
    )
    monkeypatch.setattr(
        validation, "run_validator", lambda output, subtask, prompt, validator_entity, config, iteration: ValidationVerdict(
            approved=False, feedback="nunca aprueba", iteration=iteration
        )
    )

    classification = classify_prompt(PROMPT)
    layout = _layout_with_distinct_owner_and_validator()
    result, decisions = delegate(classification, _config(), layout=layout)

    subtasks = len(classification.subtasks)
    # 1 initial + 2 bounded revisions per subtask, never a 3rd revision loop.
    assert owner_provider.calls == (1 + 2) * subtasks
    assert root_provider.calls == subtasks  # exactly one escalation call per subtask
    revise_phases = [d for d in decisions if d.phase == "revise"]
    assert len(revise_phases) == 2 * subtasks
    escalate_phases = [d for d in decisions if d.phase == "escalate"]
    assert len(escalate_phases) == subtasks
    assert result.status.value == "completed"  # root's run succeeded (no error)
