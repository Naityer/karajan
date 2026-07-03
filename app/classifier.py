from __future__ import annotations

import json
import logging
import re
from functools import lru_cache
from pathlib import Path

from app.logging_config import get_logger, log_event
from app.models import (
    Backend,
    ClassificationResult,
    CriteriaScores,
    KarajanConfig,
    Profile,
    RecommendedModel,
)
from app.providers import resolve
from app.router import (
    _requires_human_review,
    calculate_complexity_score,
    classify_prompt,
    level_for_score,
    model_for_level,
)

SKILL_PATH = Path(__file__).resolve().parent.parent / "skills" / "task-router" / "SKILL.md"
logger = get_logger("classifier")


def classify(prompt: str, config: KarajanConfig | None = None) -> ClassificationResult:
    """Hybrid classification.

    Uses the parent LLM to classify when a real backend is configured, then
    re-derives the weighted score/level/model deterministically so the numbers
    are never the LLM's opinion. Falls back to the pure heuristic when there is
    no LLM, the call fails, or the JSON is unusable.
    """
    config = config or KarajanConfig()
    if config.backend == Backend.SIMULATED or config.profile == Profile.OFFLINE:
        return classify_prompt(prompt, config)

    try:
        return _llm_classify(prompt, config)
    except Exception as exc:  # noqa: BLE001 - any LLM/parse failure degrades to heuristic
        # Make the silent degradation observable: routing keeps working, but an
        # operator can see the LLM path failed and the heuristic took over.
        log_event(
            logger,
            logging.WARNING,
            "llm_classify_fallback",
            backend=config.backend.value,
            error=f"{type(exc).__name__}: {exc}",
        )
        return classify_prompt(prompt, config)


def _llm_classify(prompt: str, config: KarajanConfig) -> ClassificationResult:
    resolution = resolve(RecommendedModel.STRONG_MODEL, config)
    if resolution.backend == Backend.SIMULATED:
        # No real parent model available; let the caller fall back.
        raise RuntimeError("no parent LLM available")

    instruction = f"{_skill_prompt()}\n\n## Prompt del usuario\n{prompt}\n\nDevuelve solo JSON."
    run = resolution.provider.run(instruction, resolution.model_id, config.orchestration.classify_timeout_s)
    if run.error or not run.output:
        raise RuntimeError(run.error or "empty LLM response")

    data = _extract_json(run.output)
    data["original_prompt"] = prompt
    return reconcile(data, config, source=f"llm:{resolution.provider_name}")


def reconcile(data: dict, config: KarajanConfig, source: str) -> ClassificationResult:
    """Trust the producer for qualitative fields, recompute all numeric routing.

    Shared by the in-app LLM classifier and the `/ingest` endpoint (where the
    model in the console is the parent). The weighted score, level and model are
    always recomputed deterministically — never taken from the producer.
    """
    criteria = CriteriaScores.model_validate(data["criteria"])
    score = calculate_complexity_score(criteria, config.criteria_weights)
    level = level_for_score(score, config.level_thresholds)
    data["criteria"] = criteria.model_dump()
    data["complexity_score"] = score
    data["complexity_level"] = level.value
    data["recommended_model"] = model_for_level(level, config.level_to_model).value
    if not data.get("subtasks"):  # forgiving for /ingest: synthesize a single bounded subtask
        data["subtasks"] = [
            {
                "id": "sub_001",
                "name": "Resolver tarea principal",
                "complexity": max(1, min(5, round(score))),
                "recommended_model": data["recommended_model"],
                "validation": "Confirmar que la salida cumple la petición original.",
            }
        ]
    data.setdefault("recommended_strategy", "divide_and_delegate")
    data.setdefault("recommended_skills", [])
    data.setdefault("validation_plan", "Confirm output matches the original request.")
    data["requires_human_review"] = bool(data.get("requires_human_review")) or _requires_human_review(
        level,
        criteria,
        data.get("domain") or ["general"],
        data.get("intent") or "classify_and_plan",
        config,
    )
    data.setdefault("reason", "Score reconciled deterministically by the KARAJAN harness.")
    data["classified_by"] = source
    return ClassificationResult.model_validate(data)


def _extract_json(text: str) -> dict:
    text = text.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    else:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end != -1 and end > start:
            text = text[start : end + 1]
    return json.loads(text)


@lru_cache(maxsize=1)
def _skill_prompt() -> str:
    try:
        return SKILL_PATH.read_text(encoding="utf-8")
    except OSError:
        return "Eres un router de tareas. Devuelve un JSON con domain, intent, criteria, subtasks."
