from __future__ import annotations

from app.models import ClassificationResult, DecisionLogEntry, Metrics, TaskRecord


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
    review_count = 0
    total_score = 0.0
    total_cost = 0.0

    for record in records:
        classification = record.classification
        by_level[classification.complexity_level.value] = by_level.get(classification.complexity_level.value, 0) + 1
        by_model[classification.recommended_model.value] = by_model.get(classification.recommended_model.value, 0) + 1
        review_count += int(classification.requires_human_review)
        total_score += classification.complexity_score
        if record.delegation:
            total_cost += record.delegation.total_estimated_cost_usd
            for execution in record.delegation.executions:
                key = execution.backend.value
                by_backend[key] = by_backend.get(key, 0) + 1

    return Metrics(
        total_tasks=len(records),
        by_level=by_level,
        by_model=by_model,
        by_backend=by_backend,
        human_review_required=review_count,
        total_estimated_cost_usd=round(total_cost, 5),
        average_complexity_score=round(total_score / len(records), 2) if records else 0.0,
    )
