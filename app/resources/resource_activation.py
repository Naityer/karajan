from __future__ import annotations

from typing import Any

from app.models import ClassificationResult, ResourceRecommendationContext
from app.resources.skill_matching import AvailableSkill, discover_skills, select_skills


def attach_installed_skills(
    classification: ClassificationResult, catalog: list[AvailableSkill] | None = None,
) -> ClassificationResult:
    """Use the live inventory without putting skill bodies into the provider prompt."""
    catalog = discover_skills() if catalog is None else catalog
    selected = select_skills(classification.original_prompt, catalog)
    if not classification.subtasks:
        return classification.model_copy(update={"recommended_skills": selected})
    subtasks = list(classification.subtasks)
    first = subtasks[0]
    subtasks[0] = first.model_copy(update={
        "recommended_skill": selected[0] if selected else None,
        "recommended_skills": selected,
    })
    for index in range(1, len(subtasks)):
        subtasks[index] = subtasks[index].model_copy(update={"recommended_skill": None, "recommended_skills": []})
    return classification.model_copy(update={"recommended_skills": selected, "subtasks": subtasks})


def attach_resource_recommendations(
    classification: ClassificationResult,
    store: Any,
    engine: Any,
    runtime: str | None = None,
    agent_id: str | None = None,
    limit: int = 5,
) -> ClassificationResult:
    """Attach ranked library resources to a classification without side effects."""
    classification = attach_installed_skills(classification)
    bounded_limit = max(0, limit)
    if bounded_limit == 0:
        return classification.model_copy()

    query = engine.expanded_query(classification.original_prompt)
    candidates = store.recommendation_candidates(query, limit=100)
    result = engine.recommend(
        classification.original_prompt,
        candidates,
        runtime=runtime,
        agent_id=agent_id,
        limit=max(100, bounded_limit),
    )
    if result.decision not in {"matched", "partial"}:
        return classification.model_copy(update={"recommended_resources": []})

    contexts = [
        _serialize_recommendation(entry)
        for entry in result.recommendations[:bounded_limit]
    ]
    skill_slugs = [
        context.slug for context in contexts
        if context.kind == "skill"
    ]
    available = {skill.name.casefold() for skill in discover_skills()}
    skill_slugs = [slug for slug in skill_slugs if slug.casefold() in available]
    recommended_skills = list(dict.fromkeys([*classification.recommended_skills, *skill_slugs]))

    subtasks = classification.subtasks
    primary_skill = next(
        (
            context.slug for context in contexts
            if context.kind == "skill" and context.role == "primary"
        ),
        None,
    )
    if primary_skill and primary_skill.casefold() in available and subtasks:
        combined = list(dict.fromkeys([primary_skill, *subtasks[0].recommended_skills]))[:3]
        subtasks = [
            subtasks[0].model_copy(update={"recommended_skill": primary_skill, "recommended_skills": combined}),
            *subtasks[1:],
        ]

    return classification.model_copy(update={
        "recommended_resources": contexts,
        "recommended_skills": recommended_skills,
        "subtasks": subtasks,
    })


def build_resource_context(classification: ClassificationResult) -> str:
    if not classification.recommended_resources:
        return ""
    lines = ["Contexto de recursos recomendados para la delegacion:"]
    for resource in classification.recommended_resources:
        line = (
            f"- {resource.name} ({resource.kind}, {resource.role}): "
            f"{resource.summary.strip() or 'Sin resumen.'}"
        )
        if resource.source_url:
            line = f"{line} URL: {resource.source_url}"
        lines.append(line)
    return "\n".join(lines)


def _serialize_recommendation(entry: Any) -> ResourceRecommendationContext:
    resource = entry.resource
    kind = getattr(resource, "kind", "")
    kind_value = getattr(kind, "value", kind)
    source_url = getattr(resource, "source_url", None) or getattr(resource, "repo_url", None)
    return ResourceRecommendationContext(
        resource_id=str(getattr(resource, "id", "")),
        slug=str(getattr(resource, "slug", "")),
        name=str(getattr(resource, "name", "")),
        kind=kind_value,
        summary=str(getattr(resource, "summary", "")),
        source_url=source_url,
        parent_resource_id=getattr(resource, "parent_resource_id", None),
        role=entry.role,
        score=float(entry.score),
    )
