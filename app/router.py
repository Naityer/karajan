from __future__ import annotations

import re
from collections import OrderedDict

from app.models import (
    ClassificationResult,
    ComplexityLevel,
    CriteriaScores,
    KarajanConfig,
    RecommendedModel,
    Subtask,
)

# Defaults kept identical to the original hardcoded values so existing tests and
# behavior stay stable. A KarajanConfig can override any of them at runtime.
CRITERIA_WEIGHTS: dict[str, float] = {
    "ambiguity": 0.20,
    "context_required": 0.20,
    "reasoning_depth": 0.20,
    "autonomy_required": 0.15,
    "operational_risk": 0.15,
    "validation_difficulty": 0.10,
}

DEFAULT_THRESHOLDS: list[float] = [1.5, 2.5, 3.5, 4.3]

_LEVELS_ASC: list[ComplexityLevel] = [
    ComplexityLevel.LEVEL_1_SIMPLE,
    ComplexityLevel.LEVEL_2_MODERATE,
    ComplexityLevel.LEVEL_3_INTERMEDIATE,
    ComplexityLevel.LEVEL_4_COMPLEX,
    ComplexityLevel.LEVEL_5_CRITICAL,
]

DOMAIN_KEYWORDS: OrderedDict[str, tuple[str, ...]] = OrderedDict(
    [
        ("security", ("secret", "token", "credential", "vulnerability", "threat", "malware", "permission", "auth")),
        ("devops", ("jenkins", "ci", "cd", "pipeline", "docker", "kubernetes", "deploy", "release")),
        ("programming", ("code", "bug", "fix", "refactor", "api", "backend", "frontend", "test", "database")),
        ("data", ("sql", "csv", "etl", "analytics", "metric", "dashboard", "report")),
        ("documents", ("pdf", "docx", "ocr", "contract", "document", "extract")),
        ("product", ("ux", "ui", "workflow", "requirements", "roadmap", "feature")),
    ]
)

# Skill/strategy recommendations surfaced to the operator (mirrors the agent router).
DOMAIN_SKILLS: dict[str, tuple[str, ...]] = {
    "security": ("security-review", "cti-analyst"),
    "devops": ("repo-analyzer",),
    "programming": ("repo-analyzer", "backend-builder", "frontend-builder"),
    "data": ("repo-analyzer", "promptfoo"),
    "documents": ("repo-analyzer",),
    "product": ("frontend-builder",),
    "general": ("ponytail",),
}


def calculate_complexity_score(criteria: CriteriaScores, weights: dict[str, float] | None = None) -> float:
    weights = weights or CRITERIA_WEIGHTS
    values = criteria.model_dump()
    return round(sum(values[name] * weight for name, weight in weights.items()), 2)


def level_for_score(score: float, thresholds: list[float] | None = None) -> ComplexityLevel:
    thresholds = thresholds or DEFAULT_THRESHOLDS
    for index, ceiling in enumerate(thresholds):
        if score <= ceiling:
            return _LEVELS_ASC[index]
    return _LEVELS_ASC[-1]


def model_for_level(level: ComplexityLevel, mapping: dict[str, str] | None = None) -> RecommendedModel:
    if mapping is not None:
        return RecommendedModel(mapping[level.value])
    return {
        ComplexityLevel.LEVEL_1_SIMPLE: RecommendedModel.CHEAP_MODEL,
        ComplexityLevel.LEVEL_2_MODERATE: RecommendedModel.CHEAP_OR_MEDIUM_MODEL,
        ComplexityLevel.LEVEL_3_INTERMEDIATE: RecommendedModel.MEDIUM_MODEL,
        ComplexityLevel.LEVEL_4_COMPLEX: RecommendedModel.STRONG_MODEL,
        ComplexityLevel.LEVEL_5_CRITICAL: RecommendedModel.STRONG_MODEL_WITH_HUMAN_REVIEW,
    }[level]


def classify_prompt(prompt: str, config: KarajanConfig | None = None) -> ClassificationResult:
    weights = config.criteria_weights if config else None
    thresholds = config.level_thresholds if config else None
    mapping = config.level_to_model if config else None

    lowered = prompt.lower()
    tokens = re.findall(r"[a-zA-Z0-9_áéíóúñüÁÉÍÓÚÑÜ-]+", lowered)
    token_count = len(tokens)
    domains = _detect_domains(lowered)
    intent = _detect_intent(lowered)

    criteria = CriteriaScores(
        ambiguity=_score_ambiguity(lowered, token_count),
        context_required=_score_context(lowered, token_count),
        reasoning_depth=_score_reasoning(lowered, token_count),
        autonomy_required=_score_autonomy(lowered),
        operational_risk=_score_risk(lowered, domains),
        validation_difficulty=_score_validation(lowered, domains),
    )
    score = calculate_complexity_score(criteria, weights)
    level = level_for_score(score, thresholds)
    model = model_for_level(level, mapping)
    strategy = _strategy_for_level(level)
    skills = _recommend_skills(domains, intent, level)
    subtasks = _build_subtasks(intent, domains, level, mapping, strategy)
    requires_review = _requires_human_review(level, criteria, domains, intent, config)

    return ClassificationResult(
        original_prompt=prompt,
        domain=domains,
        intent=intent,
        criteria=criteria,
        complexity_score=score,
        complexity_level=level,
        recommended_strategy=strategy,
        recommended_model=model,
        recommended_skills=skills,
        subtasks=subtasks,
        requires_human_review=requires_review,
        reason=_build_reason(domains, intent, criteria, level),
        validation_plan=_validation_plan(level, domains),
        classified_by="heuristic",
    )


def _requires_human_review(
    level: ComplexityLevel,
    criteria: CriteriaScores,
    domains: list[str],
    intent: str,
    config: KarajanConfig | None = None,
) -> bool:
    if config is None:
        return level == ComplexityLevel.LEVEL_5_CRITICAL or criteria.operational_risk >= 4
    level_index = _LEVELS_ASC.index(level) + 1
    policy = config.policy
    return (
        level_index >= policy.human_review_min_level
        or criteria.operational_risk >= policy.operational_risk_review_threshold
        or any(domain in policy.sensitive_domains for domain in domains)
        or intent in policy.critical_intents
    )


def _detect_domains(text: str) -> list[str]:
    domains = [domain for domain, words in DOMAIN_KEYWORDS.items() if any(word in text for word in words)]
    return domains or ["general"]


def _detect_intent(text: str) -> str:
    if any(word in text for word in ("corrige", "fix", "arregla", "debug", "bug", "error")):
        return "diagnose_and_fix"
    if any(word in text for word in ("crea", "build", "implement", "desarrolla", "añade", "add")):
        return "implement_feature"
    if any(word in text for word in ("revisa", "review", "audita", "analiza")):
        return "analyze_or_review"
    if any(word in text for word in ("resume", "summarize", "traduce", "extract")):
        return "transform_or_extract"
    return "classify_and_plan"


def _score_ambiguity(text: str, token_count: int) -> float:
    vague_terms = sum(term in text for term in ("algo", "mejor", "rápido", "simple", "varios", "etc", "thing", "stuff"))
    question_marks = text.count("?")
    base = 1.0 if token_count >= 12 else 2.0
    return min(5.0, base + vague_terms * 0.7 + min(question_marks, 3) * 0.3)


def _score_context(text: str, token_count: int) -> float:
    context_terms = sum(term in text for term in (
        "repo", "varios archivos", "base de datos", "producción", "logs", "existing", "pipeline",
        "sistema", "modulo", "componente", "servicio", "microservicio", "clase", "interfaz",
    ))
    requirements_count = text.count(",") + text.count(";")
    length_bonus = 1.5 if token_count > 80 else (0.8 if token_count > 45 else 0.0)
    multi_req_bonus = min(1.0, requirements_count * 0.2)
    return min(5.0, 1.0 + context_terms * 0.8 + length_bonus + multi_req_bonus)


def _score_reasoning(text: str, token_count: int) -> float:
    reasoning_terms = sum(term in text for term in (
        "arquitectura", "orquestador", "debug", "optimiza", "decide", "riesgo", "multi", "workflow",
        "cache", "lru", "fifo", "queue", "árbol", "tree", "graph", "concurrent", "async", "ttl",
        "patron", "pattern", "decorator", "memoiz", "algoritmo", "algorithm", "complejidad",
        "rendimiento", "performance", "escalab", "distribuido",
    ))
    return min(5.0, 1.0 + reasoning_terms * 0.65 + (1.0 if token_count > 80 else 0.0))


def _score_autonomy(text: str) -> float:
    autonomy_terms = sum(term in text for term in (
        "implementa", "desarrolla", "end to end", "automatiza", "ejecuta", "deploy",
        "construye", "diseña", "crea", "build", "create", "generate", "escribe", "develop",
    ))
    return min(5.0, 1.0 + autonomy_terms * 0.75)


def _score_risk(text: str, domains: list[str]) -> float:
    risk_terms = sum(term in text for term in ("producción", "deploy", "delete", "borrar", "secret", "token", "dinero", "legal", "seguridad"))
    domain_bonus = 1.0 if "security" in domains or "devops" in domains else 0.0
    return min(5.0, 0.8 + risk_terms * 0.8 + domain_bonus)


def _score_validation(text: str, domains: list[str]) -> float:
    validation_terms = sum(term in text for term in (
        "test", "ci", "pipeline", "visual", "dashboard", "api", "database", "sqlite",
        "unitario", "integracion", "cobertura", "coverage", "assert", "mock", "fixture",
    ))
    domain_bonus = 0.8 if any(domain in domains for domain in ("programming", "devops", "data")) else 0.0
    return min(5.0, 1.0 + validation_terms * 0.45 + domain_bonus)


def _strategy_for_level(level: ComplexityLevel) -> str:
    if level in (ComplexityLevel.LEVEL_1_SIMPLE, ComplexityLevel.LEVEL_2_MODERATE):
        return "single_model_execution"
    if level == ComplexityLevel.LEVEL_3_INTERMEDIATE:
        return "bounded_analysis_then_execute"
    if level == ComplexityLevel.LEVEL_4_COMPLEX:
        return "divide_and_delegate"
    return "divide_delegate_and_require_human_review"


def _recommend_skills(domains: list[str], intent: str, level: ComplexityLevel) -> list[str]:
    skills: list[str] = []
    for domain in domains:
        for skill in DOMAIN_SKILLS.get(domain, ()):  # preserve order, dedupe below
            if skill not in skills:
                skills.append(skill)
    if intent in ("diagnose_and_fix", "analyze_or_review") and "repo-analyzer" not in skills:
        skills.insert(0, "repo-analyzer")
    if level == ComplexityLevel.LEVEL_5_CRITICAL and "security-review" not in skills:
        skills.append("security-review")
    if "ponytail" not in skills:
        skills.append("ponytail")  # always nudge toward minimal, safe code
    return skills


def _build_subtasks(
    intent: str,
    domains: list[str],
    level: ComplexityLevel,
    mapping: dict[str, str] | None,
    strategy: str,
) -> list[Subtask]:
    if level in (ComplexityLevel.LEVEL_1_SIMPLE, ComplexityLevel.LEVEL_2_MODERATE):
        names = ["Resolver tarea principal", "Validar salida"]
    elif intent == "diagnose_and_fix":
        names = ["Localizar causa probable", "Proponer corrección acotada", "Validar regresiones"]
    elif intent == "implement_feature":
        names = ["Diseñar contrato mínimo", "Implementar flujo principal", "Persistir auditoría", "Validar comportamiento"]
    else:
        names = ["Analizar intención y contexto", "Dividir trabajo", "Ejecutar subtareas delimitadas", "Validar coherencia final"]

    level_no = _level_number(level)
    skill_hint = DOMAIN_SKILLS.get(domains[0], ("ponytail",))[0]
    subtasks: list[Subtask] = []
    for index, name in enumerate(names, start=1):
        # Final subtask carries the heaviest validation weight; others one tier lighter.
        sub_level_no = min(5, max(1, level_no - (0 if index == len(names) else 1)))
        sub_level = _LEVELS_ASC[sub_level_no - 1]
        subtasks.append(
            Subtask(
                id=f"sub_{index:03d}",
                name=name,
                complexity=sub_level_no,
                recommended_model=model_for_level(sub_level, mapping),
                recommended_skill="security-review" if name.lower().startswith("validar") else skill_hint,
                recommended_strategy=strategy,
                validation=f"Comprobar evidencia para: {name.lower()}",
            )
        )
    return subtasks


def _level_number(level: ComplexityLevel) -> int:
    return _LEVELS_ASC.index(level) + 1


def _build_reason(domains: list[str], intent: str, criteria: CriteriaScores, level: ComplexityLevel) -> str:
    strongest = max(criteria.model_dump().items(), key=lambda item: item[1])
    return (
        f"Detected {intent} across {', '.join(domains)}. "
        f"Highest driver is {strongest[0]}={strongest[1]:.1f}, producing {level.value}."
    )


def _validation_plan(level: ComplexityLevel, domains: list[str]) -> str:
    if level in (ComplexityLevel.LEVEL_4_COMPLEX, ComplexityLevel.LEVEL_5_CRITICAL):
        return "Run automated checks, inspect audit trail, and require final parent-model consistency review."
    if "programming" in domains:
        return "Run focused unit/API checks and confirm no contract regressions."
    return "Confirm output matches the original request and record validation evidence."
