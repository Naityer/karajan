from __future__ import annotations

from datetime import datetime, timezone

from app import catalog
from app.models import (
    ClassificationResult,
    DecisionLogEntry,
    FlowEvent,
    Metrics,
    ModelUsage,
    NodeMetrics,
    ObservabilitySnapshot,
    RoutingEntity,
    RoutingLayout,
    SystemHealth,
    TaskRecord,
    TaskStatus,
)


def build_classify_decision(classification: ClassificationResult) -> DecisionLogEntry:
    """Compact record of the routing decision taken at classification time."""
    return DecisionLogEntry(
        task_id=classification.task_id,
        phase="classify",
        decision=f"model={classification.recommended_model.value};strategy={classification.recommended_strategy}",
        score=classification.complexity_score,
        reason=f"{classification.classified_by}: {classification.reason}",
    )


def compute_metrics(records: list[TaskRecord]) -> Metrics:
    by_level: dict[str, int] = {}
    by_model: dict[str, int] = {}
    by_backend: dict[str, int] = {}
    by_status: dict[str, int] = {}
    by_skill: dict[str, int] = {}
    review_count = 0
    total_score = 0.0
    total_cost = 0.0
    total_subtasks = 0
    delegated_tasks = 0

    for record in records:
        classification = record.classification
        by_status[record.status.value] = by_status.get(record.status.value, 0) + 1
        by_level[classification.complexity_level.value] = by_level.get(classification.complexity_level.value, 0) + 1
        by_model[classification.recommended_model.value] = by_model.get(classification.recommended_model.value, 0) + 1
        total_subtasks += len(classification.subtasks)
        for skill in classification.recommended_skills:
            by_skill[skill] = by_skill.get(skill, 0) + 1
        for subtask in classification.subtasks:
            if subtask.recommended_skill:
                by_skill[subtask.recommended_skill] = by_skill.get(subtask.recommended_skill, 0) + 1
        review_count += int(classification.requires_human_review)
        total_score += classification.complexity_score
        if record.delegation:
            delegated_tasks += 1
            total_cost += record.delegation.total_estimated_cost_usd
            for execution in record.delegation.executions:
                key = execution.backend.value
                by_backend[key] = by_backend.get(key, 0) + 1

    return Metrics(
        total_tasks=len(records),
        by_level=by_level,
        by_model=by_model,
        by_backend=by_backend,
        by_status=by_status,
        by_skill=by_skill,
        total_subtasks=total_subtasks,
        delegated_tasks=delegated_tasks,
        human_review_required=review_count,
        total_estimated_cost_usd=round(total_cost, 5),
        average_complexity_score=round(total_score / len(records), 2) if records else 0.0,
    )


def compute_observability(
    records: list[TaskRecord],
    decisions: list[DecisionLogEntry],
    layout: RoutingLayout,
) -> ObservabilitySnapshot:
    nodes = _seed_nodes(layout)
    agent_id = _agent_node_id(nodes)
    usage: dict[str, ModelUsage] = {}
    flow: list[FlowEvent] = []
    audit: list[FlowEvent] = []

    for record in records:
        classification = record.classification
        agent = nodes[agent_id]
        agent.task_count += 1
        agent.status = _node_status(record)
        agent.model_tier = classification.recommended_model.value
        agent.confidence = _confidence(classification.complexity_score)
        agent.last_activity = record.updated_at.isoformat()
        if record.status == TaskStatus.DELEGATED and classification.requires_human_review:
            agent.extra["blocked_by_policy"] = int(agent.extra.get("blocked_by_policy", 0)) + 1
        agent.extra["received_prompts"] = int(agent.extra.get("received_prompts", 0)) + 1
        agent.extra["classified_tasks"] = int(agent.extra.get("classified_tasks", 0)) + 1
        agent.extra["delegated_tasks"] = int(agent.extra.get("delegated_tasks", 0)) + int(record.delegation is not None)
        for domain in classification.domain:
            key = f"task_type:{domain}"
            agent.extra[key] = int(agent.extra.get(key, 0)) + 1

        flow.append(
            FlowEvent(
                timestamp=record.created_at,
                event_type="prompt_received",
                source_node=agent.name,
                task_id=record.task_id,
                summary=_short(record.prompt, 86),
                status=record.status.value,
            )
        )
        flow.append(
            FlowEvent(
                timestamp=classification.created_at,
                event_type="task_classified",
                source_node=agent.name,
                task_id=record.task_id,
                summary=f"{', '.join(classification.domain)} · {classification.intent} · {classification.complexity_level.value}",
                model=classification.recommended_model.value,
                status=record.status.value,
            )
        )

        if record.delegation:
            agent.latency_ms += record.delegation.total_latency_ms
            agent.estimated_cost += record.delegation.total_estimated_cost_usd
            for execution in record.delegation.executions:
                subtask = next((item for item in classification.subtasks if item.id == execution.subtask_id), None)
                owner = _execution_owner(nodes, execution.model_used, classification.complexity_level.value, agent_id)
                owner.task_count += 1
                owner.status = execution.status.value
                owner.provider = execution.backend.value
                owner.active_model = execution.model_used
                owner.model_tier = subtask.recommended_model.value if subtask else classification.recommended_model.value
                owner.estimated_cost += execution.estimated_cost_usd
                owner.latency_ms += execution.latency_ms
                owner.input_tokens += execution.input_tokens
                owner.output_tokens += execution.output_tokens
                owner.error_count += int(execution.status == TaskStatus.FAILED or bool(execution.error))
                owner.last_activity = record.updated_at.isoformat()
                if subtask and subtask.recommended_skill and subtask.recommended_skill not in owner.skills:
                    owner.skills.append(subtask.recommended_skill)
                if subtask and subtask.recommended_skill:
                    owner.skill_usage[subtask.recommended_skill] = owner.skill_usage.get(subtask.recommended_skill, 0) + 1

                key = execution.model_used
                item = usage.setdefault(
                    key,
                    ModelUsage(model=execution.model_used, provider=execution.backend.value),
                )
                item.calls += 1
                item.estimated_cost = round(item.estimated_cost + execution.estimated_cost_usd, 5)
                item.latency_ms += execution.latency_ms
                item.errors += int(execution.status == TaskStatus.FAILED or bool(execution.error))

                summary = subtask.name if subtask else execution.subtask_id
                flow.append(
                    FlowEvent(
                        timestamp=record.delegation.completed_at,
                        event_type="task_delegated",
                        source_node=agent.name,
                        target_node=owner.name,
                        task_id=record.task_id,
                        summary=f"{execution.subtask_id} · {_short(summary, 72)}",
                        model=execution.model_used,
                        cost=execution.estimated_cost_usd,
                        latency_ms=execution.latency_ms,
                        status=execution.status.value,
                    )
                )

    for decision in decisions:
        source = _decision_source(decision.phase, nodes[agent_id].name)
        event = FlowEvent(
            timestamp=decision.created_at,
            event_type=_decision_event_type(decision),
            source_node=source,
            task_id=decision.task_id,
            summary=decision.decision,
            model=decision.backend.value if decision.backend else None,
            cost=0.0,
            status=_decision_status(decision),
        )
        audit.append(event)

    for node in nodes.values():
        if node.task_count:
            node.latency_ms = round(node.latency_ms / node.task_count)
            node.estimated_cost = round(node.estimated_cost, 5)
        node.total_tokens = node.input_tokens + node.output_tokens

    for item in usage.values():
        if item.calls:
            item.latency_ms = round(item.latency_ms / item.calls)

    events = sorted(flow, key=lambda item: item.timestamp, reverse=True)
    timeline = sorted(audit + flow, key=lambda item: item.timestamp, reverse=True)
    # Node costs are intentionally useful for attribution, but the Agent may
    # also carry orchestration-level totals. Use task delegation totals for the
    # system KPI so `/observability` and `/metrics` do not double count.
    total_cost = round(
        sum(record.delegation.total_estimated_cost_usd for record in records if record.delegation),
        5,
    )
    latencies = [node.latency_ms for node in nodes.values() if node.latency_ms]
    failed_tasks = sum(1 for record in records if record.status == TaskStatus.FAILED)
    blocked_tasks = sum(1 for record in records if record.status == TaskStatus.DELEGATED)
    active_tasks = sum(1 for record in records if record.status in {TaskStatus.CLASSIFIED, TaskStatus.DELEGATED})
    error_nodes = sum(1 for node in nodes.values() if node.error_count)
    policy_waiting = sum(
        1
        for record in records
        if record.status == TaskStatus.DELEGATED and record.classification.requires_human_review
    )
    warning_nodes = sum(1 for node in nodes.values() if node.status in {"waiting", "policy_waiting"})
    operational_blocks = max(0, blocked_tasks - policy_waiting)
    health_status = (
        "error"
        if error_nodes or failed_tasks
        else "warning"
        if operational_blocks
        else "policy_waiting"
        if policy_waiting
        else "warning"
        if warning_nodes
        else "healthy"
    )
    last_activity = max((record.updated_at for record in records), default=datetime.now(timezone.utc)).isoformat()

    return ObservabilitySnapshot(
        health=SystemHealth(
            status=health_status,
            observed_nodes=len(nodes),
            healthy_nodes=max(0, len(nodes) - warning_nodes - error_nodes),
            warning_nodes=warning_nodes,
            error_nodes=error_nodes,
            active_tasks=active_tasks,
            failed_tasks=failed_tasks,
            blocked_tasks=blocked_tasks,
            total_cost=total_cost,
            avg_latency_ms=round(sum(latencies) / len(latencies)) if latencies else 0,
            last_activity=last_activity,
        ),
        nodes=list(nodes.values()),
        execution_flow=events[:40],
        audit_timeline=timeline[:80],
        model_usage=sorted(usage.values(), key=lambda item: item.estimated_cost, reverse=True),
    )


def _seed_nodes(layout: RoutingLayout) -> dict[str, NodeMetrics]:
    entities = layout.entities or [
        RoutingEntity(id="entity-parent", name="Agent", role="parent", capabilities=["Classifier", "Planner", "Router"])
    ]
    nodes: dict[str, NodeMetrics] = {}
    for entity in entities:
        role = _role_label(entity.role)
        capabilities = entity.capabilities or (["Classifier", "Planner", "Router"] if role == "Agent" else [])
        nodes[entity.id] = NodeMetrics(
            id=entity.id,
            name=entity.name or role,
            role=role,
            active_model=entity.provider or "auto / simulado",
            provider=_provider_family(entity.provider),
            token_budget=catalog.token_budget_for(entity.provider) if entity.provider else 0,
            levels=entity.levels,
            skills=entity.skills,
            active_capabilities=capabilities,
            extra={"parent_id": entity.parentId or ""},
        )
    if not any(node.role == "Agent" for node in nodes.values()):
        nodes["entity-agent"] = NodeMetrics(
            id="entity-agent",
            name="Agent",
            role="Agent",
            active_capabilities=["Classifier", "Planner", "Router"],
        )
    return nodes


def _agent_node_id(nodes: dict[str, NodeMetrics]) -> str:
    return next((node.id for node in nodes.values() if node.role == "Agent"), next(iter(nodes)))


def _execution_owner(
    nodes: dict[str, NodeMetrics],
    model_used: str,
    level: str,
    agent_id: str,
) -> NodeMetrics:
    model = model_used.lower()
    for node in nodes.values():
        if node.active_model and node.active_model.lower() in model:
            return node
    level_aliases = _level_aliases(level)
    for node in nodes.values():
        if level_aliases.intersection(node.levels):
            return node
    return nodes[agent_id]


def _level_aliases(level: str) -> set[str]:
    """Accept both API level ids and the UI's compact N1-N5 labels."""
    aliases = {
        "level_1_simple": "N1",
        "level_2_moderate": "N2",
        "level_3_intermediate": "N3",
        "level_4_complex": "N4",
        "level_5_critical": "N5",
    }
    return {level, aliases.get(level, level)}


def _role_label(role: str) -> str:
    return {
        "parent": "Agent",
        "agent": "Agent",
        "child": "Worker",
        "worker": "Worker",
        "backup": "Backup",
        "guardian": "Guardian",
        "validator": "Validator",
        "memory": "Memory",
        "monitor": "Monitor",
    }.get(role, role.title())


def _provider_family(provider: str | None) -> str:
    if not provider:
        return "simulated"
    value = provider.lower()
    if any(key in value for key in ("ollama", "codex", "claude-cli")):
        return "local"
    if "simulated" in value:
        return "simulated"
    return "api"


def _node_status(record: TaskRecord) -> str:
    if record.status == TaskStatus.COMPLETED:
        return "completed"
    if record.status == TaskStatus.FAILED:
        return "error"
    if record.status == TaskStatus.DELEGATED:
        if record.classification.requires_human_review:
            return "policy_waiting"
        return "waiting"
    return "running"


def _confidence(score: float) -> float:
    return round(max(0.0, min(1.0, 1 - abs(score - 2.5) / 5)), 2)


def _decision_event_type(decision: DecisionLogEntry) -> str:
    if decision.phase == "classify":
        return "task_classified"
    if decision.phase == "assign":
        return "task_assigned"
    if decision.phase == "delegate":
        return "task_delegated"
    if decision.phase == "fallback":
        return "provider_fallback"
    if decision.phase == "reassign":
        return "task_reassigned"
    if decision.phase == "queue":
        return "task_queued"
    if decision.phase == "wait":
        return "waiting_for_agent"
    if decision.phase == "revise":
        return "task_revised"
    if decision.phase == "escalate":
        return "validator_escalated_to_root" if "validator_cap_reached" in decision.decision else "tier_escalated"
    if decision.phase == "validate":
        if "verdict=approved" in decision.decision:
            return "validator_approved"
        if "verdict=needs_revision" in decision.decision or "verdict=failed" in decision.decision:
            return "validator_rejected"
        return "validator_approved" if "approved" in decision.decision else "validation"
    if "reassign" in decision.decision:
        return "task_reassigned"
    if "error" in decision.decision or "failed" in decision.decision:
        return "error_detected"
    return decision.phase


def _decision_source(phase: str, agent_name: str) -> str:
    if phase in {"classify", "assign", "delegate", "validate", "reassign", "queue", "wait", "revise", "escalate"}:
        return agent_name
    return "Harness"


def _decision_status(decision: DecisionLogEntry) -> str:
    text = f"{decision.phase} {decision.decision}".lower()
    if "failed" in text or "error" in text:
        return "failed"
    if "blocked" in text:
        return "blocked"
    return "completed"


def _short(value: str, limit: int) -> str:
    text = " ".join(value.split())
    return text if len(text) <= limit else f"{text[: limit - 1]}…"
