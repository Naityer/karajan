"""Perfil base `base-2026-11-12`: punto de partida de la evolución de perfiles.

Una entidad por modelo, cada una con su ficha de aptitud sobre la puntuación continua (0–5).
Las cifras salen del criterio del propietario (12/11/2026) y son HIPÓTESIS (`medido=False`):
el motor evolutivo (`evolucion.py`) las ajusta con las métricas de `runs`; Gemini y los agentes
locales siguen sin medir hasta que haya laboratorios. Mirrored in `atlas/src/perfil-base.ts`.

  Claude  Haiku: eficiente, tareas pequeñas y subagente · Sonnet: tarea única compleja con varias
          herramientas, interfaces y gráfico · Opus/Fable: solo instantes (<5 min) concretos.
  Codex   Terra: el más funcional (ofimática y backend; a veces deja el razonamiento a medias) ·
          Luna: solo redactar · Sol: excesivo y caro · Astra: planificador, explicaciones, académico.
  Gemini  lazy-agent: tareas sencillas, redacción y académico (plan de estudiantes).
  Local   mismo nivel que Gemini, algo por debajo.
"""

from __future__ import annotations

BASE_PROFILE_ID = "base-2026-11-12"
BASE_PROFILE_NAME = "Perfil base · 2026-11-12"
BASE_PROFILE_DESCRIPTION = (
    "Perfil base de partida (12/11/2026): una entidad por modelo y puntuación continua 0–5 por agente "
    "(Claude Haiku/Sonnet/Opus/Fable, Codex Terra/Luna/Sol/Astra, Gemini y local). Cifras iniciales = hipótesis "
    "sin medir; los perfiles nuevos nacen de aquí por mutación y cruce según métricas."
)

# id, nombre, provider, modelo, rango, óptimo, coste, duración máx (min), fiabilidad, dominios, criterios
_AGENTES: list[dict] = [
    {"id": "base-haiku", "name": "Claude Haiku 5.5", "provider": "claude-cli", "model": "haiku",
     "rango": (0.0, 2.4), "optimo": 1.0, "coste": 0.10, "dur": None, "fiab": 0.70,
     "dom": {"general": 0.6, "redaccion": 0.5, "academico": 0.5, "backend": 0.45, "oficina": 0.4, "data": 0.45, "frontend": 0.3, "planificacion": 0.3, "grafico": 0.2},
     "crit": {"autonomy_required": 0.35, "reasoning_depth": 0.3, "validation_difficulty": 0.5, "context_required": 0.35}},
    {"id": "base-sonnet", "name": "Claude Sonnet 5.5", "provider": "claude-cli", "model": "sonnet",
     "rango": (1.6, 4.2), "optimo": 3.0, "coste": 0.45, "dur": None, "fiab": 0.85,
     "dom": {"frontend": 0.85, "grafico": 0.85, "backend": 0.65, "data": 0.6, "planificacion": 0.6, "redaccion": 0.6, "academico": 0.55, "oficina": 0.5, "general": 0.65},
     "crit": {"autonomy_required": 0.9, "context_required": 0.8, "reasoning_depth": 0.7, "validation_difficulty": 0.7, "ambiguity": 0.6}},
    {"id": "base-opus", "name": "Claude Opus 5.5", "provider": "claude-cli", "model": "opus",
     "rango": (3.2, 5.0), "optimo": 4.4, "coste": 0.90, "dur": 5.0, "fiab": 0.90,
     "dom": {"grafico": 0.95, "frontend": 0.9, "planificacion": 0.9, "backend": 0.6, "general": 0.6},
     "crit": {"reasoning_depth": 0.95, "ambiguity": 0.9, "context_required": 0.85, "autonomy_required": 0.8}},
    {"id": "base-fable", "name": "Claude Fable 5.2", "provider": "claude-cli", "model": "claude-fable-5-2",
     "rango": (3.4, 5.0), "optimo": 4.7, "coste": 1.00, "dur": 5.0, "fiab": 0.90,
     "dom": {"grafico": 0.95, "frontend": 0.9, "planificacion": 0.9, "general": 0.55},
     "crit": {"reasoning_depth": 0.95, "ambiguity": 0.9, "context_required": 0.9, "autonomy_required": 0.8}},
    {"id": "base-terra", "name": "Codex Terra", "provider": "codex", "model": "terra",
     "rango": (1.5, 4.4), "optimo": 3.0, "coste": 0.40, "dur": None, "fiab": 0.80,
     "dom": {"backend": 0.95, "oficina": 0.95, "data": 0.8, "general": 0.6, "redaccion": 0.5, "academico": 0.5, "frontend": 0.35, "grafico": 0.2, "planificacion": 0.45},
     "crit": {"autonomy_required": 0.6, "reasoning_depth": 0.45, "validation_difficulty": 0.6, "context_required": 0.6}},
    {"id": "base-luna", "name": "Codex Luna", "provider": "codex", "model": "luna",
     "rango": (0.0, 2.8), "optimo": 1.2, "coste": 0.15, "dur": None, "fiab": 0.60,
     "dom": {"redaccion": 0.95, "academico": 0.6, "oficina": 0.5, "general": 0.4, "backend": 0.15, "frontend": 0.1, "grafico": 0.05, "data": 0.15},
     "crit": {"ambiguity": 0.5, "reasoning_depth": 0.3, "autonomy_required": 0.2, "context_required": 0.4}},
    {"id": "base-sol", "name": "Codex Sol", "provider": "codex", "model": "sol",
     "rango": (3.5, 5.0), "optimo": 4.5, "coste": 0.85, "dur": None, "fiab": 0.85,
     "dom": {"backend": 0.85, "oficina": 0.85, "planificacion": 0.8, "data": 0.8, "general": 0.55},
     "crit": {"reasoning_depth": 0.85, "context_required": 0.8, "autonomy_required": 0.7}},
    {"id": "base-astra", "name": "Codex Astra", "provider": "codex", "model": "astra",
     "rango": (1.2, 4.0), "optimo": 2.6, "coste": 0.35, "dur": None, "fiab": 0.75,
     "dom": {"planificacion": 0.95, "academico": 0.9, "redaccion": 0.8, "general": 0.6, "backend": 0.45, "oficina": 0.5, "frontend": 0.25},
     "crit": {"reasoning_depth": 0.8, "ambiguity": 0.7, "context_required": 0.7, "autonomy_required": 0.5}},
    {"id": "base-gemini", "name": "Gemini (lazy-agent)", "provider": "google", "model": "gemini-2.0-flash",
     "rango": (0.0, 2.2), "optimo": 1.0, "coste": 0.05, "dur": None, "fiab": 0.45,
     "dom": {"academico": 0.75, "redaccion": 0.75, "general": 0.5, "backend": 0.3, "frontend": 0.2, "grafico": 0.2, "oficina": 0.35},
     "crit": {"ambiguity": 0.4, "reasoning_depth": 0.35, "autonomy_required": 0.25}},
    {"id": "base-local", "name": "Agente local (Qwen)", "provider": "ollama-qwen", "model": "qwen2.5:7b",
     "rango": (0.0, 1.8), "optimo": 0.8, "coste": 0.0, "dur": None, "fiab": 0.38,
     "dom": {"academico": 0.65, "redaccion": 0.65, "general": 0.45, "backend": 0.3, "frontend": 0.15, "grafico": 0.1, "oficina": 0.3},
     "crit": {"ambiguity": 0.35, "reasoning_depth": 0.3, "autonomy_required": 0.2}},
]

_LEVELS = ["level_1_simple", "level_2_moderate", "level_3_intermediate", "level_4_complex", "level_5_critical"]


def _levels_for_range(low: float, high: float) -> list[str]:
    """Niveles (etiqueta humana) cuya franja [n-1, n] solapa el rango continuo del agente."""
    return [name for n, name in enumerate(_LEVELS, start=1) if low < n and high > n - 1]


def base_profile(profile_id: str = BASE_PROFILE_ID) -> dict:
    """El perfil base como dict listo para `RoutingProfile.model_validate`."""
    entities = []
    for index, agent in enumerate(_AGENTES):
        low, high = agent["rango"]
        entities.append({
            "id": agent["id"], "name": agent["name"], "role": "worker", "role_tags": ["worker"],
            "provider": agent["provider"], "model": agent["model"], "tier": 1,
            "levels": _levels_for_range(low, high), "max_concurrent": 1,
            "aptitud": {
                "rango_complejidad": [low, high], "optimo": agent["optimo"],
                "afinidad_dominio": agent["dom"], "afinidad_criterio": agent["crit"],
                "coste_relativo": agent["coste"], "duracion_max_min": agent["dur"],
                "fiabilidad_prior": agent["fiab"], "medido": False,
            },
            "x": 120 + (index % 5) * 240, "y": 200 + (index // 5) * 220,
        })
    return {
        "id": profile_id, "name": BASE_PROFILE_NAME, "description": BASE_PROFILE_DESCRIPTION,
        "entities": entities, "groups": [], "rules": [],
        "scoring": {},  # pesos por defecto de ScoringConfig
        "generation": 0, "parents": [], "origin": "base", "mutation_note": "",
    }
