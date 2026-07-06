from __future__ import annotations

from dataclasses import dataclass

from app.models import ClassificationResult, RoutingEntity, RoutingLayout, Subtask, TaskStatus


@dataclass(frozen=True)
class FlowAssignment:
    owner: RoutingEntity | None
    validator: RoutingEntity | None
    backups: tuple[RoutingEntity, ...]
    priority: str
    level: str

    @property
    def owner_label(self) -> str:
        return _entity_label(self.owner, "Agent")

    @property
    def validator_label(self) -> str:
        return _entity_label(self.validator, "Agent")

    @property
    def backup_label(self) -> str:
        if not self.backups:
            return "simulated"
        return ",".join(_entity_label(entity, "Backup") for entity in self.backups)


def assign_subtask(
    classification: ClassificationResult,
    subtask: Subtask,
    layout: RoutingLayout | None,
) -> FlowAssignment:
    """Resolve the runtime owner/validator/backup implied by the hierarchy.

    Provider resolution still chooses the concrete model. This policy layer
    makes the role contract explicit so delegation can be audited as a flow, not
    just as a provider call.
    """
    entities = tuple((layout.entities if layout else []) or [])
    level = level_for_complexity(subtask.complexity)
    owner = _owner_for_level(entities, level) or _first_role(entities, {"parent", "agent"})
    validator = _validator_for(classification, subtask, entities, owner) or owner
    backups = tuple(entity for entity in entities if _role_key(entity.role) == "backup")
    return FlowAssignment(
        owner=owner,
        validator=validator,
        backups=backups,
        priority=priority_for(classification, subtask),
        level=level,
    )


def assignment_summary(subtask: Subtask, assignment: FlowAssignment) -> str:
    return (
        f"{subtask.id}:owner={assignment.owner_label};"
        f"validator={assignment.validator_label};"
        f"backup={assignment.backup_label};"
        f"priority={assignment.priority};level={assignment.level}"
    )


def validation_summary(subtask: Subtask, assignment: FlowAssignment, status: TaskStatus) -> str:
    verdict = "approved" if status == TaskStatus.COMPLETED else "failed"
    return f"{subtask.id}:validator={assignment.validator_label};verdict={verdict};priority={assignment.priority}"


def reassign_summary(subtask: Subtask, from_provider: str, to_provider: str, assignment: FlowAssignment) -> str:
    target = _matching_provider(assignment.backups, to_provider)
    target_label = _entity_label(target, "Backup") if target else to_provider
    return (
        f"{subtask.id}:reassign;from={from_provider};to={to_provider};"
        f"target={target_label};priority={assignment.priority}"
    )


def _owner_for_level(entities: tuple[RoutingEntity, ...], level: str) -> RoutingEntity | None:
    regular_roles = {"parent", "agent", "child", "worker"}
    for entity in entities:
        if _role_key(entity.role) in regular_roles and level_matches(entity.levels, level):
            return entity
    return None


def _validator_for(
    classification: ClassificationResult,
    subtask: Subtask,
    entities: tuple[RoutingEntity, ...],
    owner: RoutingEntity | None = None,
) -> RoutingEntity | None:
    """Pick who validates this subtask's output.

    `role_tags` (not `role`) is where "validator"/"guardian" actually live in the
    schema — a dedicated validator node wins, then a guardian tag, and only for
    high-complexity/human-review subtasks does it fall back to the parent.
    """
    dedicated = _first_tagged(entities, {"validator"}, exclude=owner)
    if dedicated is not None:
        return dedicated
    guardian = _first_tagged(entities, {"guardian"}, exclude=owner)
    if guardian is not None:
        return guardian
    if classification.requires_human_review or subtask.complexity >= 4:
        return _first_role(entities, {"parent", "agent"})
    return None


def _first_role(entities: tuple[RoutingEntity, ...], roles: set[str]) -> RoutingEntity | None:
    return next((entity for entity in entities if _role_key(entity.role) in roles), None)


def _has_tag(entity: RoutingEntity, tag: str) -> bool:
    return tag in (entity.role_tags or [])


def _first_tagged(
    entities: tuple[RoutingEntity, ...],
    tags: set[str],
    exclude: RoutingEntity | None = None,
) -> RoutingEntity | None:
    for entity in entities:
        if exclude is not None and entity.id == exclude.id:
            continue
        if any(_has_tag(entity, tag) for tag in tags):
            return entity
    return None


def _matching_provider(entities: tuple[RoutingEntity, ...], provider: str) -> RoutingEntity | None:
    target = provider.lower()
    for entity in entities:
        if (entity.provider or "").lower() == target or target in (entity.name or "").lower():
            return entity
    return None


def priority_for(classification: ClassificationResult, subtask: Subtask) -> str:
    if classification.requires_human_review or subtask.complexity >= 5:
        return "P0"
    if subtask.complexity >= 4:
        return "P1"
    if subtask.complexity >= 3:
        return "P2"
    return "P3"


def level_for_complexity(complexity: int) -> str:
    return {
        1: "level_1_simple",
        2: "level_2_moderate",
        3: "level_3_intermediate",
        4: "level_4_complex",
        5: "level_5_critical",
    }[complexity]


def level_matches(entity_levels: list[str], level: str) -> bool:
    aliases = {
        "level_1_simple": "N1",
        "level_2_moderate": "N2",
        "level_3_intermediate": "N3",
        "level_4_complex": "N4",
        "level_5_critical": "N5",
    }
    return level in entity_levels or aliases[level] in entity_levels


def _role_key(role: str) -> str:
    return role.strip().lower()


def _entity_label(entity: RoutingEntity | None, fallback: str) -> str:
    if entity is None:
        return fallback
    role = {
        "parent": "Agent",
        "agent": "Agent",
        "child": "Worker",
        "worker": "Worker",
        "backup": "Backup",
        "guardian": "Guardian",
        "validator": "Validator",
    }.get(_role_key(entity.role), entity.role.title())
    name = entity.name or entity.provider or entity.id
    return f"{role}:{name}"
