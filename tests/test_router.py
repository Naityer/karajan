from app.models import ComplexityLevel, CriteriaScores, KarajanConfig, PolicyConfig, RecommendedModel
from app.router import calculate_complexity_score, classify_prompt, level_for_score, model_for_level


def test_calculates_weighted_complexity_score() -> None:
    criteria = CriteriaScores(
        ambiguity=5,
        context_required=4,
        reasoning_depth=3,
        autonomy_required=2,
        operational_risk=1,
        validation_difficulty=0,
    )

    assert calculate_complexity_score(criteria) == 2.85


def test_maps_score_to_complexity_level() -> None:
    assert level_for_score(1.5) == ComplexityLevel.LEVEL_1_SIMPLE
    assert level_for_score(2.5) == ComplexityLevel.LEVEL_2_MODERATE
    assert level_for_score(3.5) == ComplexityLevel.LEVEL_3_INTERMEDIATE
    assert level_for_score(4.3) == ComplexityLevel.LEVEL_4_COMPLEX
    assert level_for_score(4.4) == ComplexityLevel.LEVEL_5_CRITICAL


def test_selects_model_from_level() -> None:
    assert model_for_level(ComplexityLevel.LEVEL_1_SIMPLE) == RecommendedModel.CHEAP_MODEL
    assert model_for_level(ComplexityLevel.LEVEL_5_CRITICAL) == RecommendedModel.STRONG_MODEL_WITH_HUMAN_REVIEW


def test_classification_returns_valid_contract() -> None:
    result = classify_prompt("Implementa una API con SQLite, dashboard, tests y auditoría de decisiones.")

    assert result.original_prompt
    assert result.domain
    assert result.subtasks
    assert 0 <= result.complexity_score <= 5


def test_policy_sensitive_domain_requires_human_review() -> None:
    config = KarajanConfig(policy=PolicyConfig(sensitive_domains=["product"], human_review_min_level=5, operational_risk_review_threshold=5))

    result = classify_prompt("Revisa el flujo UX de onboarding y propone mejoras menores.", config)

    assert "product" in result.domain
    assert result.requires_human_review is True
