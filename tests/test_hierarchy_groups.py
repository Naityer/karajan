"""Backend behavior for hierarchy groups + per-membership Prio.

Prio drives dispatch order via `RoutingEntity.effective_tier()` (lower Prio =
higher priority = tried first). Ungrouped entities keep behaving exactly as
before, falling back to their raw `tier`. The layout also rejects duplicate
`(group_id, prio)` pairs across all members, and round-trips `groups` +
`memberships` through the store intact.
"""

import asyncio

import pytest
from pydantic import ValidationError

from app import scheduler as scheduler_module
from app.models import (
    Backend,
    ClassificationResult,
    CriteriaScores,
    GroupMembership,
    HierarchyGroup,
    KarajanConfig,
    RoutingEntity,
    RoutingLayout,
    Subtask,
    SubtaskExecution,
    TaskStatus,
)
from app.routing_layout import RoutingLayoutStore

CRITERIA = CriteriaScores(
    ambiguity=3, context_required=3, reasoning_depth=3, autonomy_required=3, operational_risk=3, validation_difficulty=3
)


def _classification(subtask: Subtask) -> ClassificationResult:
    return ClassificationResult.model_validate(
        dict(
            original_prompt="tarea N4 de prueba",
            domain=["backend"],
            intent="implement_feature",
            criteria=CRITERIA,
            complexity_score=4.0,
            complexity_level="level_4_complex",
            recommended_strategy="divide_and_delegate",
            recommended_model="strong_model",
            subtasks=[subtask],
            requires_human_review=False,
            reason="test",
            validation_plan="ok",
        )
    )


def _group_layout() -> RoutingLayout:
    """Two workers in one group: Prio 1 (glm) and Prio 2 (kimi)."""
    return RoutingLayout(
        groups=[HierarchyGroup(id="g1", name="Núcleo", color="#3b82f6")],
        entities=[
            RoutingEntity(
                id="entity-worker-glm", name="GLM", role="child", role_tags=["child"],
                provider="ollama-glm", tier=2, max_concurrent=1, levels=["level_4_complex"],
                memberships=[GroupMembership(group_id="g1", prio=1)],
            ),
            RoutingEntity(
                id="entity-worker-kimi", name="Kimi", role="child", role_tags=["child"],
                provider="ollama-kimi", tier=2, max_concurrent=1, levels=["level_4_complex"],
                memberships=[GroupMembership(group_id="g1", prio=2)],
            ),
        ],
    )


def _fake_run_subtask(used: list[str]):
    def _run(classification, index, subtask, config, layout, preresolved=None, *, store=None):
        used.append(preresolved.provider_name if preresolved else "static")
        execution = SubtaskExecution(
            subtask_id=subtask.id,
            status=TaskStatus.COMPLETED,
            backend=Backend.SIMULATED,
            model_used="fake:model",
            latency_ms=1,
            estimated_cost_usd=0.0,
            output="ok",
        )
        return execution, []

    return _run


# --- effective_tier() unit behavior -----------------------------------------


def test_effective_tier_falls_back_to_raw_tier_without_memberships() -> None:
    entity = RoutingEntity(id="e", role="child", tier=2)
    assert entity.memberships == []
    assert entity.effective_tier() == 2


def test_effective_tier_uses_lowest_prio_across_multiple_groups() -> None:
    entity = RoutingEntity(
        id="e", role="child", tier=2,
        memberships=[
            GroupMembership(group_id="g1", prio=3),
            GroupMembership(group_id="g2", prio=1),
        ],
    )
    # Lowest (highest-priority) Prio wins, and it overrides the raw tier=2.
    assert entity.effective_tier() == 1


# --- dispatch order by Prio --------------------------------------------------


def test_dispatches_to_prio_1_member_when_free(monkeypatch) -> None:
    used: list[str] = []
    monkeypatch.setattr(scheduler_module.delegation, "run_subtask", _fake_run_subtask(used))

    layout = _group_layout()
    subtask = Subtask(id="sub_001", name="Resolver tarea principal", complexity=4, recommended_model="strong_model", validation="ok")
    classification = _classification(subtask)
    config = KarajanConfig()

    async def scenario() -> None:
        sched = scheduler_module.TaskScheduler()
        sched.start()
        try:
            await sched.enqueue(classification, config, layout)
            for _ in range(50):
                if classification.task_id not in sched._pending:
                    break
                await asyncio.sleep(0.05)
        finally:
            await sched.stop()

    asyncio.run(scenario())

    # Prio 1 (glm) is tried before Prio 2 (kimi).
    assert used == ["ollama-glm"]


def test_escalates_to_prio_2_member_when_prio_1_is_busy(monkeypatch) -> None:
    used: list[str] = []
    monkeypatch.setattr(scheduler_module.delegation, "run_subtask", _fake_run_subtask(used))

    layout = _group_layout()
    subtask = Subtask(id="sub_001", name="Resolver tarea principal", complexity=4, recommended_model="strong_model", validation="ok")
    classification = _classification(subtask)
    config = KarajanConfig()

    async def scenario() -> None:
        sched = scheduler_module.TaskScheduler()
        sched.start()
        try:
            glm = next(e for e in layout.entities if e.id == "entity-worker-glm")
            assert await sched.availability.try_acquire(glm)  # Prio 1 fully busy

            await sched.enqueue(classification, config, layout)
            for _ in range(50):
                if classification.task_id not in sched._pending:
                    break
                await asyncio.sleep(0.05)
        finally:
            await sched.stop()

    asyncio.run(scenario())

    # Prio 1 busy -> escalate to Prio 2 (kimi).
    assert used == ["ollama-kimi"]


# --- duplicate (group_id, prio) rejection ------------------------------------


def test_rejects_duplicate_prio_within_same_group() -> None:
    with pytest.raises(ValidationError):
        RoutingLayout(
            groups=[HierarchyGroup(id="g1", name="Núcleo", color="#3b82f6")],
            entities=[
                RoutingEntity(
                    id="e1", role="child", provider="ollama-glm",
                    memberships=[GroupMembership(group_id="g1", prio=1)],
                ),
                RoutingEntity(
                    id="e2", role="child", provider="ollama-kimi",
                    memberships=[GroupMembership(group_id="g1", prio=1)],
                ),
            ],
        )


def test_same_prio_in_different_groups_is_allowed() -> None:
    # Prio 1 in g1 and Prio 1 in g2 are independent — no conflict.
    layout = RoutingLayout(
        groups=[
            HierarchyGroup(id="g1", name="A", color="#3b82f6"),
            HierarchyGroup(id="g2", name="B", color="#ef4444"),
        ],
        entities=[
            RoutingEntity(
                id="e1", role="child", provider="ollama-glm",
                memberships=[GroupMembership(group_id="g1", prio=1)],
            ),
            RoutingEntity(
                id="e2", role="child", provider="ollama-kimi",
                memberships=[GroupMembership(group_id="g2", prio=1)],
            ),
        ],
    )
    assert len(layout.entities) == 2


# --- persistence round-trip --------------------------------------------------


def test_groups_and_memberships_survive_store_roundtrip(tmp_path) -> None:
    store = RoutingLayoutStore(tmp_path / "routing_layout.json")
    layout = _group_layout()

    store.save(layout)
    loaded = store.load()

    assert [g.id for g in loaded.groups] == ["g1"]
    assert loaded.groups[0].name == "Núcleo"
    assert loaded.groups[0].color == "#3b82f6"

    by_id = {e.id: e for e in loaded.entities}
    assert by_id["entity-worker-glm"].memberships[0].group_id == "g1"
    assert by_id["entity-worker-glm"].memberships[0].prio == 1
    assert by_id["entity-worker-kimi"].memberships[0].prio == 2
    assert by_id["entity-worker-glm"].effective_tier() == 1


def test_legacy_layout_without_groups_defaults_to_empty() -> None:
    # Old files that predate `groups`/`memberships` still validate cleanly.
    layout = RoutingLayout.model_validate(
        {"entities": [{"id": "e", "role": "parent"}], "zoom": 1, "drawer_width": 320}
    )
    assert layout.groups == []
    assert layout.entities[0].memberships == []
    assert layout.entities[0].effective_tier() == layout.entities[0].tier
