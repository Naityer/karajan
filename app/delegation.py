from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor

from app.logging_config import get_logger, log_event
from app import flow_policy
from app.models import (
    Backend,
    ClassificationResult,
    DecisionLogEntry,
    DelegationResult,
    KarajanConfig,
    RoutingLayout,
    Subtask,
    SubtaskExecution,
    TaskStatus,
)
from app.providers import resolve
from app.providers.base import ProviderRun
from app.providers.registry import Resolution, fallback_resolutions

logger = get_logger("delegation")


def estimate_task_cost(classification: ClassificationResult, config: KarajanConfig) -> float:
    """Estimate the task cost up front, using the same formula as `_run_subtask`.

    Lets the harness gate on cost *before* spending anything on real backends.
    """
    total = 0.0
    for subtask in classification.subtasks:
        tier = subtask.recommended_model.value
        total += config.cost_table.get(tier, 0.0) * subtask.complexity
    return round(total, 5)


def delegate(
    classification: ClassificationResult,
    config: KarajanConfig | None = None,
    *,
    human_approved: bool = False,
    layout: RoutingLayout | None = None,
) -> tuple[DelegationResult, list[DecisionLogEntry]]:
    """Run every subtask on its resolved backend and record harness decisions.

    Pre-execution gates (cost cap, human review) are evaluated first and can
    withhold execution entirely — nothing is spent on real backends until they
    pass. Returns the delegation result plus a compact, append-only decision trail.
    """
    config = config or KarajanConfig()

    blocked = _pre_execution_gate(classification, config, human_approved)
    if blocked is not None:
        return blocked

    subtasks = classification.subtasks
    decisions: list[DecisionLogEntry] = []

    if config.orchestration.parallel and len(subtasks) > 1:
        with ThreadPoolExecutor(max_workers=config.orchestration.max_parallel) as pool:
            paired = list(pool.map(lambda item: _run_subtask(classification, item[0], item[1], config, layout), enumerate(subtasks, start=1)))
    else:
        paired = [_run_subtask(classification, index, subtask, config, layout) for index, subtask in enumerate(subtasks, start=1)]

    executions = [execution for execution, _ in paired]
    for _, subtask_decisions in paired:
        decisions.extend(subtask_decisions)

    overall = _overall_status(executions)

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
    layout: RoutingLayout | None,
) -> tuple[SubtaskExecution, list[DecisionLogEntry]]:
    assignment = flow_policy.assign_subtask(classification, subtask, layout)
    resolution = resolve(subtask.recommended_model, config)
    instruction = f"{classification.original_prompt}\n\nSubtarea: {subtask.name}\nValidación: {subtask.validation}"

    run = _run_with_retries(resolution, instruction, config)
    attempted = {resolution.provider_name}
    decisions: list[DecisionLogEntry] = [
        DecisionLogEntry(
            task_id=classification.task_id,
            phase="assign",
            decision=flow_policy.assignment_summary(subtask, assignment),
            score=float(subtask.complexity),
            backend=resolution.backend,
            reason=f"Role policy selected owner, validator and backup chain for '{subtask.name}'.",
        )
    ]

    if run.error and config.orchestration.enable_runtime_fallback:
        for fallback in fallback_resolutions(subtask.recommended_model, config, attempted):
            decisions.append(
                DecisionLogEntry(
                    task_id=classification.task_id,
                    phase="fallback",
                    decision=(
                        f"{subtask.id}:fallback;"
                        f"from={resolution.provider_name};to={fallback.provider_name};tier={subtask.recommended_model.value}"
                    ),
                    score=float(subtask.complexity),
                    backend=fallback.backend,
                    reason=f"primary error: {run.error}",
                )
            )
            decisions.append(
                DecisionLogEntry(
                    task_id=classification.task_id,
                    phase="reassign",
                    decision=flow_policy.reassign_summary(
                        subtask,
                        resolution.provider_name,
                        fallback.provider_name,
                        assignment,
                    ),
                    score=float(subtask.complexity),
                    backend=fallback.backend,
                    reason="Runtime fallback changed the execution target after provider failure.",
                )
            )
            attempted.add(fallback.provider_name)
            fallback_run = _run_with_retries(fallback, instruction, config)
            resolution = fallback
            run = fallback_run
            if not run.error:
                break

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
    decisions.append(
        DecisionLogEntry(
            task_id=classification.task_id,
            phase="delegate",
            decision=f"{subtask.id}:{tier}->{resolution.backend.value}:{resolution.provider_name}",
            score=float(subtask.complexity),
            backend=resolution.backend,
            reason=run.error or f"executed '{subtask.name}'",
        )
    )
    decisions.append(
        DecisionLogEntry(
            task_id=classification.task_id,
            phase="validate",
            decision=flow_policy.validation_summary(subtask, assignment, status),
            score=float(subtask.complexity),
            backend=resolution.backend,
            reason=run.error or subtask.validation,
        )
    )
    return execution, decisions


def _run_with_retries(
    resolution: Resolution,
    instruction: str,
    config: KarajanConfig,
) -> ProviderRun:
    retries = config.orchestration.max_retries
    run = resolution.provider.run(instruction, resolution.model_id, config.orchestration.subtask_timeout_s)
    attempts = 0
    while run.error and attempts < retries:
        attempts += 1
        run = resolution.provider.run(instruction, resolution.model_id, config.orchestration.subtask_timeout_s)
    return run


def _pre_execution_gate(
    classification: ClassificationResult,
    config: KarajanConfig,
    human_approved: bool,
) -> tuple[DelegationResult, list[DecisionLogEntry]] | None:
    """Decide, before running anything, whether execution must be withheld.

    Returns a blocked delegation (no executions, status `delegated`) when a gate
    trips, or `None` when the task is clear to run. The cost cap is a hard limit
    and applies even after human approval; the review gate is lifted by approval.
    """
    estimated = estimate_task_cost(classification, config)
    cap = config.orchestration.max_cost_per_task_usd
    if cap and estimated > cap:
        log_event(
            logger,
            logging.WARNING,
            "cost_gate_blocked",
            task_id=classification.task_id,
            estimated=estimated,
            cap=cap,
        )
        decision = DecisionLogEntry(
            task_id=classification.task_id,
            phase="validate",
            decision=f"cost_gate=blocked;estimated={estimated};cap={cap}",
            backend=Backend.SIMULATED,
            reason=f"Estimated task cost {estimated} exceeds per-task cap {cap}; execution withheld.",
        )
        return _blocked(classification, [decision])

    if (
        classification.requires_human_review
        and config.orchestration.require_human_review_gate
        and not human_approved
    ):
        log_event(
            logger,
            logging.INFO,
            "human_review_gate_blocked",
            task_id=classification.task_id,
        )
        decision = DecisionLogEntry(
            task_id=classification.task_id,
            phase="validate",
            decision="human_review_gate=blocked",
            backend=Backend.SIMULATED,
            reason="requires_human_review is set; execution withheld until human sign-off.",
        )
        return _blocked(classification, [decision])

    return None


def _blocked(
    classification: ClassificationResult,
    decisions: list[DecisionLogEntry],
) -> tuple[DelegationResult, list[DecisionLogEntry]]:
    result = DelegationResult(
        task_id=classification.task_id,
        status=TaskStatus.DELEGATED,
        executions=[],
        total_latency_ms=0,
        total_estimated_cost_usd=0.0,
    )
    return result, decisions


def _overall_status(executions: list[SubtaskExecution]) -> TaskStatus:
    if any(execution.status == TaskStatus.FAILED for execution in executions):
        return TaskStatus.FAILED
    return TaskStatus.COMPLETED
