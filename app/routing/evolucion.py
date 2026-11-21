"""Evolución de perfiles de enrutado, al modo de un algoritmo genético y siempre basada en métricas.

* Genoma: las fichas de aptitud (`RoutingEntity.aptitud`), los pesos `scoring` y las reglas de un perfil.
* Fitness: tasa de éxito (con intervalo de Wilson) de cada entidad en cada área y banda de
  `complexity_score` (pasos de 0.5), leída de `runs` ⨝ `tasks`. Con menos de `MIN_MUESTRAS`
  ejecuciones no hay evidencia y no se muta nada.
* Mutación: solo nace de una necesidad detectada (una entidad fracasa en un área o banda con
  evidencia suficiente, o rinde de forma sobresaliente) y toca un único gen, con paso acotado.
* Cruce: de dos perfiles, cada entidad hereda la ficha del padre con mejor evidencia propia.
* Nada se activa solo: los hijos son perfiles nuevos con linaje (`generation`, `parents`, `origin`,
  `mutation_note`) y `default_profile_id` no se toca.

Mirrored in `atlas/src/evolucion.ts`.
"""

from __future__ import annotations

import json
import math

from dataclasses import dataclass
from typing import Any

from app.domain.models import RoutingLayout, RoutingProfile
from app.routing.puntuacion import areas_de_tarea

MIN_MUESTRAS = 10
EXITO_OBJETIVO = 0.75  # IC95 por debajo de esto con evidencia = fracaso demostrado
EXITO_SOBRESALIENTE = 0.90  # IC95 inferior por encima de esto = refuerzo
MAX_HIJOS = 4
PASO_BASE = 0.10
PASO_ALEATORIO = 0.10


class Azar:
    """Generador congruencial lineal (Numerical Recipes) idéntico al del puerto TypeScript: misma semilla, mismos hijos."""

    def __init__(self, semilla: int = 0) -> None:
        self._estado = semilla & 0xFFFFFFFF

    def random(self) -> float:
        self._estado = (self._estado * 1664525 + 1013904223) & 0xFFFFFFFF
        return self._estado / 4294967296


@dataclass(frozen=True)
class Muestra:
    """Una ejecución real atribuida a un perfil y a un modelo concreto."""

    profile_id: str | None
    clave: tuple[str, str]  # (provider, model)
    complejidad: float
    areas: tuple[str, ...]
    ok: bool
    coste: float = 0.0
    latencia_ms: int = 0


@dataclass(frozen=True)
class Fitness:
    entidad_id: str
    n: int
    exitos: int
    tasa: float
    wilson_bajo: float
    wilson_alto: float
    coste_medio: float
    evidencia: bool


@dataclass(frozen=True)
class Necesidad:
    tipo: str  # fracaso_dominio | fracaso_banda | refuerzo_dominio
    entidad_id: str
    detalle: str  # área o banda
    n: int
    tasa: float
    wilson_bajo: float
    wilson_alto: float

    @property
    def gravedad(self) -> float:
        # los fracasos más claros (IC alto más bajo) primero; los refuerzos después
        return self.wilson_alto if self.tipo.startswith("fracaso") else 1.0 + (1.0 - self.wilson_bajo)

    def explicacion(self) -> str:
        what = f"área «{self.detalle}»" if self.tipo.endswith("dominio") else f"banda de complejidad {self.detalle}"
        return (f"{what}: {self.tasa * 100:.0f} % de éxito "
                f"(IC95 {self.wilson_bajo * 100:.0f}–{self.wilson_alto * 100:.0f} %) en {self.n} ejecuciones con {self.entidad_id}")


# --- Lectura de métricas --------------------------------------------------------------------


def cargar_muestras(store: Any) -> list[Muestra]:
    """Ejecuciones terminadas de `runs` ⨝ `tasks` (puntuación y prompt de la tarea)."""
    sql = (
        "SELECT r.profile_id, r.provider_name, r.model_id, r.status, r.estimated_cost_usd, r.latency_ms, "
        "t.score, t.prompt, t.classification_json "
        "FROM runs r JOIN tasks t ON t.task_id = r.task_id "
        "WHERE r.status IN ('completed', 'failed') AND r.provider_name IS NOT NULL AND t.score IS NOT NULL"
    )
    muestras: list[Muestra] = []
    if not hasattr(store, "_connect"):  # almacén sin SQL local (p. ej. Postgres SaaS): sin evidencia
        return muestras
    with store._connect() as conn:  # noqa: SLF001 - lectura de solo consulta sobre el propio almacén
        rows = conn.execute(sql).fetchall()
    for row in rows:
        try:
            domains = json.loads(row["classification_json"]).get("domain", [])
        except (TypeError, ValueError, AttributeError):
            domains = []
        muestras.append(Muestra(
            profile_id=row["profile_id"], clave=(row["provider_name"], row["model_id"] or ""),
            complejidad=float(row["score"]), areas=areas_de_tarea(row["prompt"] or "", domains),
            ok=row["status"] == "completed", coste=float(row["estimated_cost_usd"] or 0.0),
            latencia_ms=int(row["latency_ms"] or 0),
        ))
    return muestras


# --- Fitness ---------------------------------------------------------------------------------


def wilson(exitos: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n <= 0:
        return 0.0, 1.0
    p = exitos / n
    den = 1 + z * z / n
    centro = (p + z * z / (2 * n)) / den
    margen = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return max(0.0, centro - margen), min(1.0, centro + margen)


def banda(complejidad: float) -> float:
    return math.floor(complejidad * 2) / 2


def _muestras_de(perfil: RoutingProfile, muestras: list[Muestra]) -> list[Muestra]:
    return [m for m in muestras if m.profile_id == perfil.id]


def _clave(entity) -> tuple[str, str]:
    return (entity.provider or "", entity.model or "")


def _fitness(entidad_id: str, subset: list[Muestra]) -> Fitness:
    n = len(subset)
    exitos = sum(1 for m in subset if m.ok)
    bajo, alto = wilson(exitos, n)
    return Fitness(entidad_id, n, exitos, exitos / n if n else 0.0, bajo, alto,
                   sum(m.coste for m in subset) / n if n else 0.0, n >= MIN_MUESTRAS)


def fitness_perfil(perfil: RoutingProfile, muestras: list[Muestra]) -> list[Fitness]:
    """Fitness global de cada entidad del perfil con sus ejecuciones atribuidas."""
    propias = _muestras_de(perfil, muestras)
    return [_fitness(e.id, [m for m in propias if m.clave == _clave(e)]) for e in perfil.entities if e.provider]


def detectar_necesidades(perfil: RoutingProfile, muestras: list[Muestra]) -> list[Necesidad]:
    """Necesidades demostradas por métricas; sin evidencia suficiente no hay necesidad."""
    propias = _muestras_de(perfil, muestras)
    necesidades: list[Necesidad] = []
    for e in perfil.entities:
        if not e.provider or e.aptitud is None:
            continue
        suyas = [m for m in propias if m.clave == _clave(e)]
        for area in sorted({a for m in suyas for a in m.areas}):
            sub = [m for m in suyas if area in m.areas]
            f = _fitness(e.id, sub)
            if not f.evidencia:
                continue
            if f.wilson_alto < EXITO_OBJETIVO:
                necesidades.append(Necesidad("fracaso_dominio", e.id, area, f.n, f.tasa, f.wilson_bajo, f.wilson_alto))
            elif f.wilson_bajo >= EXITO_SOBRESALIENTE:
                necesidades.append(Necesidad("refuerzo_dominio", e.id, area, f.n, f.tasa, f.wilson_bajo, f.wilson_alto))
        for b in sorted({banda(m.complejidad) for m in suyas}):
            sub = [m for m in suyas if banda(m.complejidad) == b]
            f = _fitness(e.id, sub)
            if f.evidencia and f.wilson_alto < EXITO_OBJETIVO:
                necesidades.append(Necesidad("fracaso_banda", e.id, f"{b:.1f}–{b + 0.5:.1f}", f.n, f.tasa, f.wilson_bajo, f.wilson_alto))
    return sorted(necesidades, key=lambda n: (n.gravedad, n.entidad_id, n.detalle))


# --- Operadores -----------------------------------------------------------------------------


def _clamp(valor: float) -> float:
    return round(min(1.0, max(0.0, valor)), 3)


def _hijo(padre: RoutingProfile, hijo_id: str, origen: str, nota: str, padres: list[str], generacion: int) -> RoutingProfile:
    hijo = padre.model_copy(deep=True)
    hijo.id = hijo_id
    hijo.name = f"{padre.name.split(' · g')[0]} · g{generacion}"[:100]
    hijo.generation, hijo.parents, hijo.origin, hijo.mutation_note = generacion, padres, origen, nota[:600]
    return hijo


def mutar(perfil: RoutingProfile, necesidad: Necesidad, rng: "Azar", hijo_id: str) -> RoutingProfile | None:
    """Un hijo que cambia un único gen en respuesta a la necesidad, o None si no procede."""
    hijo = _hijo(perfil, hijo_id, "mutacion", "", [perfil.id], perfil.generation + 1)
    entidad = next((e for e in hijo.entities if e.id == necesidad.entidad_id and e.aptitud), None)
    if entidad is None:
        return None
    apt = entidad.aptitud
    paso = round(PASO_BASE + PASO_ALEATORIO * rng.random(), 3)
    if necesidad.tipo == "fracaso_dominio":
        antes = apt.afinidad_dominio.get(necesidad.detalle, 0.4)
        apt.afinidad_dominio[necesidad.detalle] = _clamp(antes - paso)
        cambio = f"afinidad «{necesidad.detalle}» de {entidad.id}: {antes:.2f}→{apt.afinidad_dominio[necesidad.detalle]:.2f}"
    elif necesidad.tipo == "refuerzo_dominio":
        antes = apt.afinidad_dominio.get(necesidad.detalle, 0.4)
        apt.afinidad_dominio[necesidad.detalle] = _clamp(antes + paso / 2)
        cambio = f"afinidad «{necesidad.detalle}» de {entidad.id}: {antes:.2f}→{apt.afinidad_dominio[necesidad.detalle]:.2f}"
    else:  # fracaso_banda: el rango deja de cubrir la banda que falla
        inicio = float(necesidad.detalle.split("–")[0])
        if inicio <= apt.optimo < inicio + 0.5:
            return None  # la banda del propio óptimo no se recorta: se corrige por afinidad, no borrando al agente
        low, high = apt.rango_complejidad
        if inicio >= apt.optimo:
            high = max(low, min(high, inicio))
        else:
            low = min(high, max(low, inicio + 0.5))
        if (low, high) == apt.rango_complejidad:
            return None
        antes = apt.rango_complejidad
        apt.rango_complejidad = (low, high)
        apt.optimo = min(high, max(low, apt.optimo))
        cambio = f"rango de {entidad.id}: {antes[0]:.1f}–{antes[1]:.1f}→{low:.1f}–{high:.1f}"
    hijo.mutation_note = f"{necesidad.explicacion()}. Cambio: {cambio}."[:600]
    return hijo


def cruzar(a: RoutingProfile, b: RoutingProfile, muestras: list[Muestra], hijo_id: str) -> RoutingProfile | None:
    """Cada entidad común hereda la ficha del padre con mejor evidencia propia (empate: a)."""
    fa = {f.entidad_id: f for f in fitness_perfil(a, muestras)}
    fb = {f.entidad_id: f for f in fitness_perfil(b, muestras)}
    por_id = {e.id: e for e in b.entities}
    hijo = _hijo(a, hijo_id, "cruce", "", sorted([a.id, b.id]), max(a.generation, b.generation) + 1)
    cambios: list[str] = []
    for entidad in hijo.entities:
        otra = por_id.get(entidad.id)
        if otra is None or otra.aptitud is None or entidad.aptitud == otra.aptitud:
            continue
        x, y = fa.get(entidad.id), fb.get(entidad.id)
        gana_b = y is not None and y.evidencia and (x is None or not x.evidencia or y.wilson_bajo > x.wilson_bajo)
        if gana_b:
            entidad.aptitud = otra.aptitud.model_copy(deep=True)
            cambios.append(f"{entidad.id} de {b.id} (IC95 inferior {y.wilson_bajo * 100:.0f} %)")
    if not cambios:
        return None
    hijo.mutation_note = ("Cruce de " + f"{a.id} × {b.id}: hereda " + "; ".join(cambios) + ".")[:600]
    return hijo


def proponer_generacion(layout: RoutingLayout, muestras: list[Muestra], *, semilla: int = 0) -> list[RoutingProfile]:
    """Perfiles hijo propuestos (inactivos) a partir del perfil por defecto y, si hay, de otros con evidencia.

    No modifica `layout`: el llamador decide si los guarda. Determinista para una semilla dada."""
    rng = Azar(semilla)
    base = layout.default_profile()
    hijos: list[RoutingProfile] = []
    nuevos_ids = {p.id for p in layout.profiles}

    def siguiente_id(origen: RoutingProfile) -> str:
        raiz = origen.id.split("-g")[0][:60]
        n = 1
        while f"{raiz}-g{n}" in nuevos_ids:
            n += 1
        return f"{raiz}-g{n}"

    def aceptar(hijo: RoutingProfile | None) -> None:
        if hijo is not None:  # el id solo se gasta si nace un hijo
            nuevos_ids.add(hijo.id)
            hijos.append(hijo)

    for necesidad in detectar_necesidades(base, muestras):
        if len(hijos) >= MAX_HIJOS:
            break
        aceptar(mutar(base, necesidad, rng, siguiente_id(base)))
    otros = [p for p in layout.profiles if p.id != base.id and p.entities]
    for otro in otros:
        if len(hijos) >= MAX_HIJOS:
            break
        aceptar(cruzar(base, otro, muestras, siguiente_id(base)))
    return hijos
