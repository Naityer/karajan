from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from app.models import (
    Backend,
    ClassificationResult,
    DecisionLogEntry,
    DelegationResult,
    KarajanConfig,
    Subtask,
    SubtaskExecution,
    TaskStatus,
)
from app.providers import resolve


def delegate(
    classification: ClassificationResult,
    config: KarajanConfig | None = None,
) -> tuple[DelegationResult, list[DecisionLogEntry]]:
    """Run every subtask on its resolved backend and record harness decisions.

    Returns the delegation result plus a compact, append-only decision trail.
    """
    config = config or KarajanConfig()
    subtasks = classification.subtasks
    decisions: list[DecisionLogEntry] = []

    if config.orchestration.parallel and len(subtasks) > 1:
        with ThreadPoolExecutor(max_workers=config.orchestration.max_parallel) as pool:
            paired = list(pool.map(lambda item: _run_subtask(classification, item[0], item[1], config), enumerate(subtasks, start=1)))
    else:
        paired = [_run_subtask(classification, index, subtask, config) for index, subtask in enumerate(subtasks, start=1)]

    executions = [execution for execution, _ in paired]
    decisions.extend(decision for _, decision in paired)

    overall = _overall_status(executions, classification, config, decisions)

    result = DelegationResult(
        task_id=classification.task_id,
        status=overall,
        executions=executions,
        total_latency_ms=sum(item.latency_ms for item in executions),
        total_estimated_cost_usd=round(sum(item.estimated_cost_usd for item in executions), 5),
    )
    return result, decisions


def _run_subtask(
    classification: ClassificationResult,
    index: int,
    subtask: Subtask,
    config: KarajanConfig,
) -> tuple[SubtaskExecution, DecisionLogEntry]:
    resolution = resolve(subtask.recommended_model, config)
    instruction = f"{classification.original_prompt}\n\nSubtarea: {subtask.name}\nValidación: {subtask.validation}"

    retries = config.orchestration.max_retries
    run = resolution.provider.run(instruction, resolution.model_id, config.orchestration.subtask_timeout_s)
    attempts = 0
    while run.error and attempts < retries:
        attempts += 1
        run = resolution.provider.run(instruction, resolution.model_id, config.orchestration.subtask_timeout_s)

    tier = subtask.recommended_model.value
    cost = round(config.cost_table.get(tier, 0.0) * subtask.complexity, 5)
    # Real backends report measured latency; simulated returns 0 → use the config table.
    latency = run.latency_ms or (config.latency_table.get(tier, 0) + index * 37)
    status = TaskStatus.FAILED if run.error else TaskStatus.COMPLETED

    execution = SubtaskExecution(
        subtask_id=subtask.id,
        status=status,
        backend=resolution.backend,
        model_used=run.model_used,
        latency_ms=latency,
        estimated_cost_usd=cost,
        output=run.output or (run.error or ""),
        error=run.error,
    )
    decision = DecisionLogEntry(
        task_id=classification.task_id,
        phase="delegate",
        decision=f"{subtask.id}:{tier}->{resolution.backend.value}:{resolution.provider_name}",
        score=float(subtask.complexity),
        backend=resolution.backend,
        reason=run.error or f"executed '{subtask.name}'",
    )
    return execution, decision


def _overall_status(
    executions: list[SubtaskExecution],
    classification: ClassificationResult,
    config: KarajanConfig,
    decisions: list[DecisionLogEntry],
) -> TaskStatus:
    if any(execution.status == TaskStatus.FAILED for execution in executions):
        return TaskStatus.FAILED
    if classification.requires_human_review and config.orchestration.require_human_review_gate:
        decisions.append(
            DecisionLogEntry(
                task_id=classification.task_id,
                phase="validate",
                decision="human_review_gate=blocked",
                backend=Backend.SIMULATED,
                reason="requires_human_review is set; awaiting human sign-off before completion.",
            )
        )
        return TaskStatus.DELEGATED
    return TaskStatus.COMPLETED
