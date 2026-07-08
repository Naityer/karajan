"""Availability-driven dispatch: escalates to the next eligible tier when the
best tier is fully busy, instead of blocking the whole queue."""

import asyncio

from app import scheduler as scheduler_module
from app.models import (
    Backend,
    ClassificationResult,
    CriteriaScores,
    KarajanConfig,
    RoutingEntity,
    RoutingLayout,
    Subtask,
    SubtaskExecution,
    TaskStatus,
)

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


def _layout() -> RoutingLayout:
    return RoutingLayout(
        entities=[
            RoutingEntity(
                id="entity-worker-glm", name="GLM", role="child", role_tags=["child"],
                provider="ollama-glm", tier=1, max_concurrent=1, levels=["level_4_complex"],
            ),
            RoutingEntity(
                id="entity-worker-kimi", name="Kimi", role="child", role_tags=["child"],
                provider="ollama-kimi", tier=1, max_concurrent=1, levels=["level_4_complex"],
            ),
            RoutingEntity(
                id="entity-worker-ornith", name="Ornith", role="child", role_tags=["child"],
                provider="ollama-ornith", tier=2, max_concurrent=1, levels=["level_4_complex"],
            ),
        ]
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


def test_escalates_to_tier_2_when_both_tier_1_agents_are_busy(monkeypatch) -> None:
    used: list[str] = []
    monkeypatch.setattr(scheduler_module.delegation, "run_subtask", _fake_run_subtask(used))

    layout = _layout()
    subtask = Subtask(id="sub_001", name="Resolver tarea principal", complexity=4, recommended_model="strong_model", validation="ok")
    classification = _classification(subtask)
    config = KarajanConfig()

    async def scenario() -> None:
        sched = scheduler_module.TaskScheduler()
        sched.start()
        try:
            glm = next(e for e in layout.entities if e.id == "entity-worker-glm")
            kimi = next(e for e in layout.entities if e.id == "entity-worker-kimi")
            assert await sched.availability.try_acquire(glm)
            assert await sched.availability.try_acquire(kimi)

            await sched.enqueue(classification, config, layout)

            for _ in range(50):
                if classification.task_id not in sched._pending:
                    break
                await asyncio.sleep(0.05)
        finally:
            await sched.stop()

    asyncio.run(scenario())

    assert used == ["ollama-ornith"]


def test_dispatches_to_a_free_tier_1_agent_when_available(monkeypatch) -> None:
    used: list[str] = []
    monkeypatch.setattr(scheduler_module.delegation, "run_subtask", _fake_run_subtask(used))

    layout = _layout()
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

    assert used == ["ollama-glm"]
