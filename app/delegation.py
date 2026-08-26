from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

from app.logging_config import get_logger, log_event
from app import agent_tools
from app import events
from app import execution as execution_helpers
from app import flow_policy
from app import validation
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
from app.providers.registry import Resolution, fallback_resolutions, resolve_entity
from app.resource_activation import build_resource_context

logger = get_logger("delegation")


def estimate_task_cost(classification: ClassificationResult, config: KarajanConfig) -> float:
    """Estimate the task cost up front, using the same formula as `run_subtask`.

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
    store: Any | None = None,
    preresolved: Resolution | None = None,
    workspace_root: str | None = None,
    agent_tools_profile: str | None = None,
) -> tuple[DelegationResult, list[DecisionLogEntry]]:
    """Run every subtask on its resolved backend and record harness decisions.

    Pre-execution gates (cost cap, human review) are evaluated first and can
    withhold execution entirely — nothing is spent on real backends until they
    pass. Returns the delegation result plus a compact, append-only decision trail.

    `store` (an `app.database.TaskStore`, kept as `Any` here to avoid a circular
    import since `database.py` doesn't need to import this module) is optional
    and threaded straight through to `run_subtask` so it can persist a `runs`
    row with the real `resolution.provider_name` — the stable attribution this
    phase introduces. `None` (the default, used by every pre-existing caller/test)
    keeps delegation fully functional with no persistence side effect.

    `preresolved`, when given, forces every subtask onto this one `Resolution`
    instead of the tier-pinned `resolve()` — the CLI/MCP "assign to a specific
    agent" bypass (`/delegate-task`'s `force_provider`/`force_entity_id`). It
    applies to the whole task, not per-subtask.
    """
    config = config or KarajanConfig()

    blocked = _pre_execution_gate(classification, config, human_approved)
    if blocked is not None:
        return blocked

    subtasks = classification.subtasks
    decisions: list[DecisionLogEntry] = []

    # Resolved once per task, not per subtask: the workspace and profile are a
    # property of the job, and re-validating the root N times only multiplies
    # the ways it can disagree with itself.
    agent_plan = agent_tools.plan(
        config, requested_workspace=workspace_root, requested_profile=agent_tools_profile
    )
    # Recorded whenever the loop was *asked for*, not only when it ran: an
    # operator who enabled it and got a one-shot run needs to see why.
    if agent_plan.enabled or agent_tools_profile or config.agent_tools.enabled:
        decisions.append(
            DecisionLogEntry(
                task_id=classification.task_id,
                phase="assign",
                decision=agent_tools.describe(agent_plan),
                reason=(
                    f"Workspace: {agent_plan.workspace.root}"
                    if agent_plan.enabled and agent_plan.workspace
                    else agent_plan.reason
                ),
            )
        )

    if config.orchestration.parallel and len(subtasks) > 1:
        with ThreadPoolExecutor(max_workers=config.orchestration.max_parallel) as pool:
            paired = list(pool.map(
                lambda item: run_subtask(
                    classification, item[0], item[1], config, layout, preresolved,
                    store=store, agent_plan=agent_plan,
                ),
                enumerate(subtasks, start=1),
            ))
    else:
        paired = [
            run_subtask(
                classification, index, subtask, config, layout, preresolved,
                store=store, agent_plan=agent_plan,
            )
            for index, subtask in enumerate(subtasks, start=1)
        ]

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
        total_input_tokens=sum(item.input_tokens for item in executions),
        total_output_tokens=sum(item.output_tokens for item in executions),
    )
    return result, decisions


def _run_fallback_chain(
    classification: ClassificationResult,
    subtask: Subtask,
    assignment: flow_policy.FlowAssignment,
    resolution: Resolution,
    instruction: str,
    run,
    attempted: set[str],
    config: KarajanConfig,
    layout: RoutingLayout | None,
) -> tuple[Resolution, Any, list[DecisionLogEntry]]:
    """Walk the runtime fallback chain after a primary provider error, retrying
    each candidate until one succeeds or the chain is exhausted. Returns the
    final `(resolution, run)` plus the fallback/reassign decisions produced."""
    decisions: list[DecisionLogEntry] = []
    for fallback in fallback_resolutions(subtask.recommended_model, config, attempted, layout):
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
        fallback_run = execution_helpers.run_with_retries(fallback, instruction, config)
        resolution = fallback
        run = fallback_run
        if not run.error:
            break
    return resolution, run, decisions


def _persist_run(
    store: Any,
    classification: ClassificationResult,
    subtask: Subtask,
    assignment: flow_policy.FlowAssignment,
    resolution: Resolution,
    subtask_execution: SubtaskExecution,
    started_at: str,
) -> None:
    """Persist a `runs` row for this subtask's execution and emit its SSE
    lifecycle events. A store/SSE failure must never break delegation, so the
    whole body is guarded and only logs on error."""
    try:
        completed_at = datetime.now(timezone.utc).isoformat()
        run_id = store.record_run(
            task_id=classification.task_id,
            provider_name=resolution.provider_name,
            routing_entity_id=assignment.owner.id if assignment.owner else None,
            routing_entity_name_snapshot=assignment.owner.name if assignment.owner else None,
            model_id=resolution.model_id,
            backend=resolution.backend.value,
            status=subtask_execution.status.value,
            started_at=started_at,
            completed_at=completed_at,
            latency_ms=subtask_execution.latency_ms,
            input_tokens=subtask_execution.input_tokens,
            output_tokens=subtask_execution.output_tokens,
            estimated_cost_usd=subtask_execution.estimated_cost_usd,
            error=subtask_execution.error,
        )
        events.publish("run_started", task_id=classification.task_id, run_id=run_id)
        events.publish(
            "run_completed",
            task_id=classification.task_id,
            run_id=run_id,
            status=subtask_execution.status.value,
        )
    except Exception:  # noqa: BLE001 - a store/SSE failure must never break delegation
        log_event(
            logger, logging.WARNING, "record_run_failed",
            task_id=classification.task_id, subtask_id=subtask.id,
        )


def _open_agent_run(
    store: Any | None,
    classification: ClassificationResult,
    assignment: flow_policy.FlowAssignment,
    resolution: Resolution,
) -> str | None:
    """Reserve the `runs` row an agent session will write its trace against.

    Guarded like `_persist_run`: losing the trace must never lose the run.
    """
    if store is None:
        return None
    try:
        return store.open_run(
            task_id=classification.task_id,
            provider_name=resolution.provider_name,
            routing_entity_id=assignment.owner.id if assignment.owner else None,
            routing_entity_name_snapshot=assignment.owner.name if assignment.owner else None,
            model_id=resolution.model_id,
            backend=resolution.backend.value,
        )
    except Exception:  # noqa: BLE001
        log_event(logger, logging.WARNING, "open_run_failed", task_id=classification.task_id)
        return None


def _close_agent_run(store: Any | None, run_id: str, execution: SubtaskExecution) -> None:
    if store is None:
        return
    try:
        store.close_run(
            run_id,
            status=execution.status.value,
            latency_ms=execution.latency_ms,
            input_tokens=execution.input_tokens,
            output_tokens=execution.output_tokens,
            estimated_cost_usd=execution.estimated_cost_usd,
            error=execution.error,
        )
        events.publish("run_completed", task_id=execution.subtask_id, run_id=run_id, status=execution.status.value)
    except Exception:  # noqa: BLE001
        log_event(logger, logging.WARNING, "close_run_failed", run_id=run_id)


def run_subtask(
    classification: ClassificationResult,
    index: int,
    subtask: Subtask,
    config: KarajanConfig,
    layout: RoutingLayout | None,
    preresolved: Resolution | None = None,
    *,
    store: Any | None = None,
    agent_plan: Any | None = None,
) -> tuple[SubtaskExecution, list[DecisionLogEntry]]:
    """Execute one subtask end-to-end: assign, run (with fallback chain), and
    optionally validate. `preresolved` lets a caller that already picked a
    specific, available entity (the async scheduler) skip the static
    tier-pinned `resolve()` and use that entity's resolution instead — the
    rest of the pipeline (fallback, validation) is identical either way.

    `store` (optional `app.database.TaskStore`) receives a `runs` row for this
    subtask's execution once it's fully resolved (including any runtime
    fallback/validator escalation), keyed on `resolution.provider_name` — the
    stable catalog identity that fixes the old fuzzy `_execution_owner()`
    attribution. `None` (used by every pre-existing caller) is a no-op."""
    started_at = datetime.now(timezone.utc).isoformat()
    assignment = flow_policy.assign_subtask(classification, subtask, layout)
    resolution = preresolved or resolve(subtask.recommended_model, config)
    if resolution is None:
        # `delegate()` gates on this up front, so reaching here means a caller
        # went straight to `run_subtask` (the scheduler, or a test). Fail loudly
        # with the real reason instead of inventing an execution.
        return _unresolved_execution(classification, subtask, config)
    resource_context = build_resource_context(classification)
    prompt_for_execution = (
        f"{classification.original_prompt}\n\n{resource_context}"
        if resource_context
        else classification.original_prompt
    )
    instruction = f"{prompt_for_execution}\n\nSubtarea: {subtask.name}\nValidación: {subtask.validation}"

    # The tool loop replaces exactly this one call. Whatever it returns is an
    # ordinary `ProviderRun`, so the fallback chain, validator, cost math and
    # persistence below are identical either way — including the degradation
    # path, where a session error retries the *one-shot* form on another
    # provider.
    agent_run_id = None
    if agent_plan is not None and agent_plan.enabled:
        # The run row is opened *before* the session, because tool events happen
        # during it and need a `run_id` to point at. `_persist_run` is skipped
        # for this path and `close_run` finalizes the same row.
        agent_run_id = _open_agent_run(store, classification, assignment, resolution)
        agent_classification = (
            classification.model_copy(update={"original_prompt": prompt_for_execution})
            if resource_context
            else classification
        )
        outcome = agent_tools.run_agent_subtask(
            agent_classification, subtask, resolution, agent_plan, config.agent_tools,
            store=store, run_id=agent_run_id,
            max_cost_usd=config.orchestration.max_cost_per_task_usd,
        )
        run = outcome.as_provider_run()
    else:
        outcome = None
        run = execution_helpers.run_with_retries(resolution, instruction, config)
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

    # An explicit provider/entity selection is a hard routing decision. Falling
    # back silently would violate sender routing and make the audit trail claim
    # that another agent performed the requested work. Automatic routing may
    # still use its configured fallback chain.
    if run.error and config.orchestration.enable_runtime_fallback and preresolved is None:
        resolution, run, fallback_decisions = _run_fallback_chain(
            classification, subtask, assignment, resolution, instruction, run, attempted, config, layout
        )
        decisions.extend(fallback_decisions)

    tier = subtask.recommended_model.value
    cost = execution_helpers.cost_for(tier, subtask.complexity, config)
    latency = execution_helpers.latency_for(tier, run, config, index)
    status = TaskStatus.FAILED if run.error else TaskStatus.COMPLETED

    subtask_execution = SubtaskExecution(
        subtask_id=subtask.id,
        status=status,
        backend=resolution.backend,
        model_used=run.model_used,
        latency_ms=latency,
        estimated_cost_usd=cost,
        output=run.output or (run.error or ""),
        error=run.error,
        input_tokens=execution_helpers.estimate_tokens(instruction),
        output_tokens=execution_helpers.estimate_tokens(run.output or ""),
        context_paths=list(outcome.context_paths) if outcome is not None else [],
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

    if (
        config.orchestration.enable_validator_loop
        and not run.error
        and assignment.validator is not None
        and assignment.owner is not None
        and assignment.validator.id != assignment.owner.id
    ):
        subtask_execution, loop_decisions, resolution = _run_validator_loop(
            classification, subtask, assignment, resolution, instruction, run, config, index, layout
        )
        decisions.extend(loop_decisions)
    else:
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

    if agent_run_id is not None:
        decisions.append(
            DecisionLogEntry(
                task_id=classification.task_id,
                phase="delegate",
                decision=f"{subtask.id}:{agent_tools.describe(agent_plan)}",
                score=float(subtask.complexity),
                backend=resolution.backend,
                reason=(
                    f"Sesion de agente: {outcome.status}, {outcome.turns} turno(s), "
                    f"{outcome.tool_calls} llamada(s) a herramientas."
                    if outcome is not None
                    else "sesion de agente"
                ),
            )
        )
        _close_agent_run(store, agent_run_id, subtask_execution)
    elif store is not None:
        _persist_run(
            store, classification, subtask, assignment, resolution, subtask_execution, started_at
        )

    return subtask_execution, decisions


def _run_validator_loop(
    classification: ClassificationResult,
    subtask: Subtask,
    assignment: flow_policy.FlowAssignment,
    resolution,
    instruction: str,
    run,
    config: KarajanConfig,
    index: int,
    layout: RoutingLayout | None,
) -> tuple[SubtaskExecution, list[DecisionLogEntry], Resolution]:
    """Real validator feedback loop: a dedicated cheap agent critiques the
    owner's output; rejections re-run the *owner* with the feedback appended,
    bounded by `max_validation_iterations`. Only after the cap is exhausted and
    still rejected does it escalate once to the root agent.

    Returns the final `resolution` too (in addition to the execution/decisions)
    so the caller's `record_run` reflects a validator-cap root escalation
    instead of the pre-loop provider."""
    decisions: list[DecisionLogEntry] = []
    tier = subtask.recommended_model.value
    max_iterations = config.orchestration.max_validation_iterations
    iteration = 0

    while True:
        verdict = validation.run_validator(
            run.output or "", subtask, classification.original_prompt, assignment.validator, config, iteration
        )
        verdict_label = "approved" if verdict.approved else "needs_revision"
        decisions.append(
            DecisionLogEntry(
                task_id=classification.task_id,
                phase="validate",
                decision=(
                    f"{subtask.id}:verdict={verdict_label};iteration={iteration};"
                    f"validator={assignment.validator_label}"
                ),
                score=float(subtask.complexity),
                backend=resolution.backend,
                reason=verdict.feedback or "validator reviewed the output",
            )
        )
        if verdict.approved or iteration >= max_iterations:
            if not verdict.approved and config.orchestration.escalate_to_root_after_max_iterations:
                root = _root_entity(layout)
                root_resolution = resolve_entity(root, subtask.recommended_model) if root else None
                if root_resolution is not None:
                    escalated_instruction = (
                        f"{instruction}\n\n[Validador, sin aprobar tras {iteration} revision(es)]: {verdict.feedback}"
                    )
                    escalated_run = execution_helpers.run_with_retries(root_resolution, escalated_instruction, config)
                    decisions.append(
                        DecisionLogEntry(
                            task_id=classification.task_id,
                            phase="escalate",
                            decision=f"{subtask.id}:validator_cap_reached;escalated_to={root_resolution.provider_name}",
                            score=float(subtask.complexity),
                            backend=root_resolution.backend,
                            reason=f"Validator rejected after {iteration} revision(es); escalated to root.",
                        )
                    )
                    if not escalated_run.error:
                        run = escalated_run
                        resolution = root_resolution
                        instruction = escalated_instruction
            break
        iteration += 1
        decisions.append(
            DecisionLogEntry(
                task_id=classification.task_id,
                phase="revise",
                decision=f"{subtask.id}:iteration={iteration};feedback={verdict.feedback[:200]}",
                score=float(subtask.complexity),
                backend=resolution.backend,
                reason="validator requested changes",
            )
        )
        instruction = f"{instruction}\n\n[Revision #{iteration} del validador]: {verdict.feedback}\nCorrige la salida anterior."
        run = execution_helpers.run_with_retries(resolution, instruction, config)

    cost = execution_helpers.cost_for(tier, subtask.complexity, config)
    latency = execution_helpers.latency_for(tier, run, config, index)
    status = TaskStatus.FAILED if run.error else TaskStatus.COMPLETED
    updated = SubtaskExecution(
        subtask_id=subtask.id,
        status=status,
        backend=resolution.backend,
        model_used=run.model_used,
        latency_ms=latency,
        estimated_cost_usd=cost,
        output=run.output or (run.error or ""),
        error=run.error,
        input_tokens=execution_helpers.estimate_tokens(instruction),
        output_tokens=execution_helpers.estimate_tokens(run.output or ""),
        validation_iterations=iteration,
    )
    return updated, decisions, resolution


def _root_entity(layout: RoutingLayout | None):
    entities = layout.entities if layout else []
    parent = next((e for e in entities if e.effective_tier() == 0 and e.role.strip().lower() == "parent"), None)
    if parent is not None:
        return parent
    return next((e for e in entities if e.effective_tier() == 0), None)


def _unresolved_execution(
    classification: ClassificationResult,
    subtask: Subtask,
    config: KarajanConfig,
) -> tuple[SubtaskExecution, list[DecisionLogEntry]]:
    """A failed, zero-cost execution for a subtask whose tier has no provider.

    `backend` records the backend that *would* have been used, which is what
    the operator needs in order to fix it — there is no "none" backend to
    report, because a fake backend value is exactly what this phase removes.
    """
    tier = subtask.recommended_model.value
    error = f"sin proveedor listo para el tier '{tier}' en el backend '{config.backend.value}'"
    execution = SubtaskExecution(
        subtask_id=subtask.id,
        status=TaskStatus.FAILED,
        backend=config.backend,
        model_used="",
        latency_ms=0,
        estimated_cost_usd=0.0,
        output=error,
        error=error,
    )
    decision = DecisionLogEntry(
        task_id=classification.task_id,
        phase="delegate",
        decision=f"{subtask.id}:{tier}->unresolved",
        score=float(subtask.complexity),
        backend=config.backend,
        reason=error,
    )
    return execution, [decision]


def _unresolved_tiers(classification: ClassificationResult, config: KarajanConfig) -> list[str]:
    """Distinct subtask tiers that no configured provider can serve, in order.

    Checked before spending anything: with no fake backend to fall back on, a
    tier that cannot resolve would otherwise surface as an opaque failure once
    execution is already under way.
    """
    unresolved: list[str] = []
    for subtask in classification.subtasks:
        tier = subtask.recommended_model.value
        if tier in unresolved:
            continue
        if resolve(subtask.recommended_model, config) is None:
            unresolved.append(tier)
    return unresolved


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
    unresolved = _unresolved_tiers(classification, config)
    if unresolved:
        log_event(
            logger,
            logging.WARNING,
            "provider_gate_blocked",
            task_id=classification.task_id,
            tiers=",".join(unresolved),
            backend=config.backend.value,
        )
        decision = DecisionLogEntry(
            task_id=classification.task_id,
            phase="delegate",
            decision=f"provider_gate=blocked;tiers={','.join(unresolved)}",
            reason=(
                f"Ningún proveedor listo sirve el/los tier(s) {', '.join(unresolved)} "
                f"en el backend '{config.backend.value}'; ejecución retenida. "
                "Configura un proveedor en Agentes o Configuración."
            ),
        )
        return _blocked(classification, [decision])

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
