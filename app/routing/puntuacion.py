"""Puntuación continua de agentes: reparte por `complexity_score` (0–5) y fichas de aptitud, no por 5 niveles.

Para cada entidad con `aptitud` se calcula una puntuación 0–100 frente a la tarea:

    score = w_complejidad·ajuste + w_dominio·afinidad_dominio + w_criterios·afinidad_criterios
            + w_fiabilidad·fiabilidad − w_coste·coste·(1 − riesgo)

Gana la mayor. Las `RoutingRule` del perfil quedan como vetos/forzados y se evalúan antes
(`routing_rules.match_for_layout`). Una entidad con `duracion_max_min` se descarta si la duración
estimada de la tarea la supera. Mirrored in `atlas/src/puntuacion.ts`.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.domain.models import CriteriaScores, RoutingEntity, ScoringConfig
from app.routing.routing_rules import _contains, detect_areas

# Áreas finas que `routing_rules.detect_areas` no distingue (solo para puntuar, nunca para clasificar).
EXTRA_AREA_KEYWORDS: dict[str, tuple[str, ...]] = {
    "grafico": ("vídeo", "video", "imagen", "imágenes", "gráfico", "gráficos", "ilustración", "animación", "cartel", "logo"),
    "redaccion": ("redacta", "redactar", "redacción", "texto", "artículo", "resumen", "correo", "carta", "explica", "explicación"),
    "academico": ("académico", "académica", "asignatura", "estudio", "estudiar", "examen", "apuntes", "trabajo académico", "tfg", "tfm"),
    "planificacion": ("planifica", "planificar", "planificación", "plan de", "roadmap", "estrategia", "organiza", "descompón"),
}
CRITERIOS = ("ambiguity", "context_required", "reasoning_depth", "autonomy_required", "operational_risk", "validation_difficulty")
# Afinidad por defecto cuando la ficha no dice nada de un área/criterio (neutral).
NEUTRAL = 0.4
NEUTRAL_CRITERIO = 0.5


@dataclass(frozen=True)
class TareaPuntuable:
    complejidad: float  # 0–5, continua
    criterios: dict[str, float]
    areas: tuple[str, ...] = field(default_factory=tuple)

    @property
    def riesgo(self) -> float:
        return min(1.0, max(0.0, self.criterios.get("operational_risk", 0.0) / 5))


def areas_de_tarea(prompt: str, domains: list[str]) -> tuple[str, ...]:
    """Áreas de la tarea: las de enrutado + las finas del prompt + los dominios del clasificador."""
    text = prompt.lower()
    areas = list(detect_areas(prompt))
    areas += [a for a, words in EXTRA_AREA_KEYWORDS.items() if any(_contains(text, w) for w in words) and a not in areas]
    areas += [d for d in domains if d != "general" and d not in areas]
    return tuple(areas)


def tarea_desde_clasificacion(score: float, criteria: CriteriaScores | dict, prompt: str, domains: list[str],
                              *, desplazamiento: float = 0.0) -> TareaPuntuable:
    values = criteria.model_dump() if isinstance(criteria, CriteriaScores) else dict(criteria)
    return TareaPuntuable(
        complejidad=min(5.0, max(0.0, score + desplazamiento)),
        criterios={k: float(values.get(k, 0.0)) for k in CRITERIOS},
        areas=areas_de_tarea(prompt, domains),
    )


def duracion_estimada_min(tarea: TareaPuntuable, cfg: ScoringConfig) -> float:
    return cfg.min_base + cfg.min_por_complejidad * tarea.complejidad + cfg.min_por_contexto * tarea.criterios.get("context_required", 0.0)


def ajuste_complejidad(entity: RoutingEntity, complejidad: float) -> float:
    """1 en el óptimo, decae hacia los bordes del rango y se apaga a una unidad fuera de él."""
    apt = entity.aptitud
    low, high = apt.rango_complejidad
    if complejidad < low or complejidad > high:
        fuera = low - complejidad if complejidad < low else complejidad - high
        return max(0.0, 0.3 - 0.3 * fuera)  # un resto de 0.3 justo en el borde, 0 a una unidad
    lado = (apt.optimo - low) if complejidad <= apt.optimo else (high - apt.optimo)
    if lado <= 0:
        return 1.0
    return 1.0 - 0.6 * abs(complejidad - apt.optimo) / lado


def afinidad_dominio(entity: RoutingEntity, areas: tuple[str, ...]) -> float:
    afinidades = entity.aptitud.afinidad_dominio
    if not areas:
        return afinidades.get("general", NEUTRAL)
    return sum(afinidades.get(a, NEUTRAL) for a in areas) / len(areas)


def afinidad_criterios(entity: RoutingEntity, criterios: dict[str, float]) -> float:
    pesos = {k: v / 5 for k, v in criterios.items() if v > 0}
    total = sum(pesos.values())
    if total <= 0:
        return NEUTRAL_CRITERIO
    afin = entity.aptitud.afinidad_criterio
    return sum(w * afin.get(k, NEUTRAL_CRITERIO) for k, w in pesos.items()) / total


def puntuar(entity: RoutingEntity, tarea: TareaPuntuable, cfg: ScoringConfig) -> float:
    """Puntuación 0–100 de una entidad con ficha de aptitud frente a la tarea."""
    apt = entity.aptitud
    if apt is None:
        return 0.0
    raw = (
        cfg.w_complejidad * ajuste_complejidad(entity, tarea.complejidad)
        + cfg.w_dominio * afinidad_dominio(entity, tarea.areas)
        + cfg.w_criterios * afinidad_criterios(entity, tarea.criterios)
        + cfg.w_fiabilidad * apt.fiabilidad_prior
        - cfg.w_coste * apt.coste_relativo * (1.0 - tarea.riesgo)
    )
    return round(min(100.0, max(0.0, raw)), 2)


def ranking(entities: list[RoutingEntity], tarea: TareaPuntuable, cfg: ScoringConfig | None) -> list[tuple[RoutingEntity, float]]:
    """Entidades con ficha ordenadas de mayor a menor puntuación (desempate: id), sin las vetadas por duración."""
    cfg = cfg or ScoringConfig()
    minutos = duracion_estimada_min(tarea, cfg)
    candidatas = [
        e for e in entities
        if e.aptitud is not None and e.provider
        and (e.aptitud.duracion_max_min is None or minutos <= e.aptitud.duracion_max_min)
    ]
    return sorted(((e, puntuar(e, tarea, cfg)) for e in candidatas), key=lambda par: (-par[1], par[0].id))
