from __future__ import annotations

from typing import Any

from app.models import ClassificationResult, ResourceRecommendationContext


def attach_resource_recommendations(
    classification: ClassificationResult,
    store: Any,
    engine: Any,
    runtime: str | None = None,
    agent_id: str | None = None,
    limit: int = 5,
) -> ClassificationResult:
    """Attach ranked library resources to a classification without side effects."""
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
    recommended_skills = list(dict.fromkeys([*classification.recommended_skills, *skill_slugs]))

    subtasks = classification.subtasks
    primary_skill = next(
        (
            context.slug for context in contexts
            if context.kind == "skill" and context.role == "primary"
        ),
        None,
    )
    if primary_skill and subtasks:
        subtasks = [
            subtasks[0].model_copy(update={"recommended_skill": primary_skill}),
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
