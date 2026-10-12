"""Domain rules of a routing profile: which entity runs a subtask by domain, intent and level.

The classifier already reports coarse domains (`programming`, `data`, `documents`…). Routing
by *kind of work* needs a finer split that the classifier doesn't make, so this module adds
three routing areas detected from the prompt itself — `frontend` (interfaces and design),
`backend` (APIs, servers, data stores) and `oficina` (reports, mail, spreadsheets) — and
matches profile rules against domains ∪ areas. It never changes the classification, so the
complexity scores and their parity with the TypeScript port stay untouched.

Mirrored in `atlas/src/reglas.ts` (same keywords, same evaluation order).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.models import RoutingEntity, RoutingLayout, RoutingRule

AREA_KEYWORDS: dict[str, tuple[str, ...]] = {
    "frontend": (
        "interfaz", "interfaces", "ui", "ux", "diseño", "diseña", "diseñar", "design", "frontend", "front-end",
        "componente", "componentes", "component", "css", "tailwind", "react", "vue", "svelte", "html",
        "dashboard", "maquetación", "maqueta", "layout", "pantalla", "vista", "estilo", "estilos", "animación",
        "landing", "responsive", "widget", "widgets", "figma",
    ),
    "backend": (
        "backend", "back-end", "api", "apis", "endpoint", "endpoints", "servidor", "server", "base de datos",
        "database", "sql", "postgres", "sqlite", "migración", "migration", "worker", "cola", "queue", "auth",
        "autenticación", "microservicio", "fastapi", "fastify", "express", "rest", "graphql", "cron",
    ),
    "oficina": (
        "informe", "informes", "reporte", "reportes", "report", "correo", "correos", "email", "excel", "hoja de cálculo",
        "spreadsheet", "presentación", "powerpoint", "pptx", "docx", "word", "acta", "minuta", "resumen ejecutivo",
        "memo", "carta", "factura", "presupuesto", "calendario", "agenda",
    ),
}

LEVEL_NUMBER = {"level_1_simple": 1, "level_2_moderate": 2, "level_3_intermediate": 3, "level_4_complex": 4, "level_5_critical": 5}


def _contains(text: str, term: str) -> bool:
    return re.search(rf"(?<!\w){re.escape(term)}(?!\w)", text, flags=re.UNICODE) is not None


def detect_areas(prompt: str) -> list[str]:
    """Routing areas named in the prompt, in a stable order."""
    text = prompt.lower()
    return [area for area, words in AREA_KEYWORDS.items() if any(_contains(text, word) for word in words)]


@dataclass(frozen=True)
class RuleMatch:
    rule: RoutingRule
    entity: RoutingEntity


def rule_matches(rule: RoutingRule, domains: set[str], intent: str, level: int) -> bool:
    if not rule.enabled:
        return False
    if rule.domains and not domains.intersection(rule.domains):
        return False
    if rule.intents and intent not in rule.intents:
        return False
    if rule.level_min is not None and level < rule.level_min:
        return False
    if rule.level_max is not None and level > rule.level_max:
        return False
    return True


def match_rule(
    rules: list[RoutingRule],
    entities: list[RoutingEntity],
    *,
    domains: list[str],
    intent: str,
    level: int,
    prompt: str = "",
) -> RuleMatch | None:
    """First enabled rule that matches and whose entity exists, or None."""
    if not rules:
        return None
    by_id = {entity.id: entity for entity in entities}
    pool = set(domains) | set(detect_areas(prompt))
    for rule in rules:
        entity = by_id.get(rule.entity_id)
        if entity is not None and rule_matches(rule, pool, intent, level):
            return RuleMatch(rule, entity)
    return None


def rule_level(task_level: str, subtask_complexity: int) -> int:
    """Level a rule sees: the task's level, or the subtask's if higher.

    All subtasks of a task then tend to land on the same agent, and a task the
    classifier rates as moderate isn't split into "simple" pieces for the local model.
    """
    return max(LEVEL_NUMBER.get(task_level, 1), subtask_complexity)


def match_for_layout(layout: RoutingLayout | None, *, domains: list[str], intent: str, level: int, prompt: str) -> RuleMatch | None:
    """Rules of the profile already projected onto `layout` (the default profile at dispatch)."""
    if layout is None:
        return None
    return match_rule(layout.rules, layout.entities, domains=domains, intent=intent, level=level, prompt=prompt)


# --- Preset: three agents split by kind of work -------------------------------------------

DOMAIN_PRESET_ID = "por-dominio"
DOMAIN_PRESET_NAME = "Claude · Codex · Qwen (por dominio)"


def domain_preset_profile(profile_id: str = DOMAIN_PRESET_ID) -> dict:
    """Claude for complex interface work, Codex for backend/office/everything else, Qwen local for simple tasks."""
    claude, codex, qwen = "dominio-claude", "dominio-codex", "dominio-qwen"
    return {
        "id": profile_id,
        "name": DOMAIN_PRESET_NAME,
        "entities": [
            {"id": qwen, "name": "Qwen (local)", "role": "worker", "role_tags": ["worker"], "provider": "ollama-qwen", "tier": 1,
             "levels": ["level_1_simple", "level_2_moderate"], "max_concurrent": 1, "x": 120, "y": 430},
            {"id": codex, "name": "Codex", "role": "worker", "role_tags": ["worker"], "provider": "codex", "tier": 1,
             "levels": ["level_1_simple", "level_2_moderate", "level_3_intermediate", "level_4_complex"], "max_concurrent": 2, "x": 480, "y": 430},
            {"id": claude, "name": "Claude Code", "role": "worker", "role_tags": ["worker"], "provider": "claude-cli", "tier": 1,
             "levels": ["level_3_intermediate", "level_4_complex", "level_5_critical"], "max_concurrent": 1, "x": 840, "y": 430},
        ],
        "groups": [],
        "rules": [
            {"id": "interfaces-complejas", "name": "Interfaces y diseño complejos → Claude", "entity_id": claude, "domains": ["frontend"], "level_min": 2},
            {"id": "backend-oficina", "name": "Backend, oficina e informes → Codex", "entity_id": codex,
             "domains": ["backend", "oficina", "data", "devops", "documents"]},
            {"id": "sencillas-local", "name": "Tareas sencillas → Qwen local", "entity_id": qwen, "level_max": 2},
            {"id": "resto", "name": "Todo lo demás → Codex", "entity_id": codex},
        ],
    }
