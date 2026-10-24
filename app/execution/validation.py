from __future__ import annotations

from app import execution
from app.classifier import _extract_json
from app.models import KarajanConfig, RecommendedModel, RoutingEntity, Subtask, ValidationVerdict
from app.providers.registry import resolve_entity

_VALIDATOR_PROMPT = (
    "Eres un validador de calidad, barato y estricto. No resuelves la tarea, "
    "solo revisas si la salida de otro agente cumple el criterio de validacion. "
    "Responde EXCLUSIVAMENTE con JSON: {\"approved\": true|false, \"feedback\": \"...\"}. "
    "Si approved es false, feedback debe explicar en 1-2 frases que falta o que corregir."
)

# Try the cheapest tier the validator's provider actually supports.
_VALIDATOR_TIERS = (RecommendedModel.CHEAP_MODEL, RecommendedModel.CHEAP_OR_MEDIUM_MODEL)


def run_validator(
    owner_output: str,
    subtask: Subtask,
    original_prompt: str,
    validator_entity: RoutingEntity,
    config: KarajanConfig,
    iteration: int,
) -> ValidationVerdict:
    """Ask a dedicated, cheap validator agent to critique `owner_output`.

    Fails open (`approved=True`) whenever the validator itself can't be
    resolved, errors, or returns unparseable output — a broken validator must
    never block completion or manufacture a false rejection.
    """
    resolution = None
    for tier in _VALIDATOR_TIERS:
        resolution = resolve_entity(validator_entity, tier)
        if resolution is not None:
            break
    if resolution is None:
        return ValidationVerdict(
            approved=True,
            feedback="validator provider unavailable; auto-approved",
            iteration=iteration,
        )

    instruction = (
        f"{_VALIDATOR_PROMPT}\n\n"
        f"Peticion original: {original_prompt}\n\n"
        f"Subtarea: {subtask.name}\n"
        f"Criterio de validacion: {subtask.validation}\n\n"
        f"Salida a revisar:\n{owner_output}"
    )
    run = execution.run_with_retries(resolution, instruction, config)
    if run.error or not run.output:
        return ValidationVerdict(
            approved=True,
            feedback=f"validator error, auto-approved: {run.error}",
            iteration=iteration,
            validator_provider=resolution.provider_name,
            validator_model=resolution.model_id,
        )
    try:
        data = _extract_json(run.output)
        return ValidationVerdict(
            approved=bool(data.get("approved", True)),
            feedback=str(data.get("feedback", "")),
            iteration=iteration,
            validator_provider=resolution.provider_name,
            validator_model=resolution.model_id,
        )
    except Exception as exc:  # noqa: BLE001 - never let a parse failure block completion
        return ValidationVerdict(
            approved=True,
            feedback=f"validator response unparseable, auto-approved: {exc}",
            iteration=iteration,
            validator_provider=resolution.provider_name,
            validator_model=resolution.model_id,
        )
