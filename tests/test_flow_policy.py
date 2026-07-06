"""Owner/validator selection: role_tags-based lookup (guardian/validator), not `role`."""

from app import flow_policy
from app.models import ClassificationResult, CriteriaScores, RoutingEntity, RoutingLayout, Subtask

CRITERIA = CriteriaScores(
    ambiguity=2, context_required=2, reasoning_depth=2, autonomy_required=2, operational_risk=2, validation_difficulty=2
)


def _classification(**overrides) -> ClassificationResult:
    defaults = dict(
        original_prompt="tarea de prueba",
        domain=["general"],
        intent="classify_and_plan",
        criteria=CRITERIA,
        complexity_score=2.0,
        complexity_level="level_2_moderate",
        recommended_strategy="divide_and_delegate",
        recommended_model="cheap_or_medium_model",
        subtasks=[],
        requires_human_review=False,
        reason="test",
        validation_plan="ok",
    )
    defaults.update(overrides)
    return ClassificationResult.model_validate(defaults)


def _subtask(complexity: int = 2) -> Subtask:
    return Subtask(
        id="sub_001",
        name="Resolver tarea principal",
        complexity=complexity,
        recommended_model="cheap_or_medium_model",
        validation="ok",
    )


def _layout(*entities: RoutingEntity) -> RoutingLayout:
    return RoutingLayout(entities=list(entities))


OWNER = RoutingEntity(id="owner", name="Owner", role="child", role_tags=["child"], provider="ollama-qwen", levels=["level_2_moderate"])


def test_validator_tag_lives_in_role_tags_not_role() -> None:
    """Regression test: a validator/guardian is tagged via role_tags, and role
    stays "child" — assign_subtask must find it there, not by comparing `role`."""
    validator = RoutingEntity(id="validator", name="Validator", role="child", role_tags=["child", "validator"], provider="ollama-qwen")
    layout = _layout(OWNER, validator)

    assignment = flow_policy.assign_subtask(_classification(), _subtask(), layout)

    assert assignment.owner is not None and assignment.owner.id == "owner"
    assert assignment.validator is not None and assignment.validator.id == "validator"


def test_guardian_tag_is_used_when_no_dedicated_validator() -> None:
    guardian = RoutingEntity(id="guardian", name="Guardian", role="child", role_tags=["child", "guardian"], provider="ollama-deepseek")
    layout = _layout(OWNER, guardian)

    assignment = flow_policy.assign_subtask(_classification(), _subtask(), layout)

    assert assignment.validator is not None and assignment.validator.id == "guardian"


def test_dedicated_validator_wins_over_guardian() -> None:
    guardian = RoutingEntity(id="guardian", name="Guardian", role="child", role_tags=["child", "guardian"], provider="ollama-deepseek")
    validator = RoutingEntity(id="validator", name="Validator", role="child", role_tags=["child", "validator"], provider="ollama-qwen")
    layout = _layout(OWNER, guardian, validator)

    assignment = flow_policy.assign_subtask(_classification(), _subtask(), layout)

    assert assignment.validator is not None and assignment.validator.id == "validator"


def test_falls_back_to_owner_when_no_validator_or_guardian_present() -> None:
    layout = _layout(OWNER)

    assignment = flow_policy.assign_subtask(_classification(), _subtask(), layout)

    assert assignment.validator is not None and assignment.validator.id == "owner"


def test_high_complexity_falls_back_to_parent_without_dedicated_validator() -> None:
    owner_l4 = RoutingEntity(id="owner-l4", name="Worker N4", role="child", role_tags=["child"], provider="ollama-mistral-nemo", levels=["level_4_complex"])
    parent = RoutingEntity(id="parent", name="Claude", role="parent", role_tags=["parent"], provider="claude-cli", levels=["level_5_critical"])
    layout = _layout(owner_l4, parent)

    assignment = flow_policy.assign_subtask(_classification(), _subtask(complexity=4), layout)

    assert assignment.owner is not None and assignment.owner.id == "owner-l4"
    assert assignment.validator is not None and assignment.validator.id == "parent"
