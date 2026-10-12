"""API del módulo Monitoring.

Métricas agregadas, analítica, observabilidad y búsqueda sobre las tareas ya ejecutadas.

Movida tal cual desde `app/main.py` (nota "Plan de mejora", §17): mismas
rutas, mismos modelos de respuesta, mismas guardas de autenticación. Lo
único que cambia es que el almacén y los servicios ya no son globals del
módulo `main` — se resuelven contra el runtime activo en cada petición.
"""

from __future__ import annotations

import logging

from app import (
    metrics_export,
    monitoring,
    skill_analytics as skill_analytics_module,
    skills_catalog,
)
from app.analytics import duckdb_ops
from app.analytics import produccion as produccion_ops
from app.analytics import produccion_datos
from app.auth import require_token
from app import credentials
from datetime import datetime, timezone
from pydantic import BaseModel, Field
from app.analytics import ml as ml_ops
from app.analytics.duckdb_ops import AnalyticsUnavailable
from app.analytics.ml import MLUnavailable, ModelNotTrained
from app.logging_config import log_event
from app.models import (
    AgentPerformance,
    Metrics,
    MetricsHistory,
    ObservabilitySnapshot,
    PredictTaskRequest,
    PredictTaskResponse,
)
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
)
from fastapi.responses import PlainTextResponse

from app import runtime as runtime_module
from app.logging_config import get_logger, log_event


logger = get_logger("api")
router = APIRouter(tags=["monitoring"])


@router.get("/metrics", response_model=Metrics)
def metrics() -> Metrics:
    return runtime_module.current().tasks.metrics()


@router.get("/agents/performance", response_model=list[AgentPerformance])
def agents_performance() -> list[AgentPerformance]:
    """Provider-keyed cost/latency/error aggregation from `runs` (Fase 1).

    The stable, SQL-`GROUP BY provider_name` replacement for the old fuzzy
    model-name/level-alias attribution in `monitoring._execution_owner()`.
    """
    return runtime_module.current().tasks.agent_performance()


@router.get("/analytics/skills")
def skills_analytics(days: int = Query(default=30, ge=0, le=3650)) -> dict:
    """Skill recommendations and verified executions, kept as separate facts."""
    records = runtime_module.current().tasks.list_tasks()
    runs_by_task = {
        record.task_id: runtime_module.current().tasks.list_runs(record.task_id)
        for record in records
        if record.delegation is not None
    }
    known_skills = [skill.name for skill in skills_catalog.list_skills()]
    return skill_analytics_module.build_skill_analytics(
        records,
        runs_by_task=runs_by_task,
        known_skills=known_skills,
        days=days,
    )


# --- Search & analytics (Fase 3) — read-only, no auth ---------------------


@router.get("/search/tasks")
def search_tasks(q: str = Query(default="", description="full-text query"), limit: int = Query(default=20, ge=1, le=100)) -> dict:
    """FTS5 full-text search over tasks (title/summary/tags/task_type/full prompt).

    Ranked by bm25 when FTS5 is available, with a transparent LIKE fallback.
    """
    try:
        results = runtime_module.current().tasks.search_tasks(q, limit=limit)
    except Exception as exc:  # noqa: BLE001 - never 500 on a search query
        log_event(logger, logging.WARNING, "search_tasks_error", error=f"{type(exc).__name__}: {exc}")
        results = []
    return {"query": q, "count": len(results), "results": results}


@router.get("/analytics/dashboard")
def analytics_dashboard(days: int = Query(default=30, ge=1, le=365)) -> dict:
    """Richer DuckDB analytics (cost/latency trends, percentiles, leaderboards).

    Additive to `/agents/performance`. If DuckDB (an optional extra) is not
    installed, returns `{"available": false, "reason": ...}` with a 200 so the
    frontend can show a friendly "analytics unavailable" state, never a 500.
    """
    try:
        return duckdb_ops.dashboard(days=days)
    except AnalyticsUnavailable as exc:
        return {"available": False, "reason": str(exc)}
    except Exception as exc:  # noqa: BLE001 - degrade instead of 500 on any analytics error
        log_event(logger, logging.WARNING, "analytics_dashboard_error", error=f"{type(exc).__name__}: {exc}")
        return {"available": False, "reason": f"{type(exc).__name__}: {exc}"}


@router.get("/metrics/prometheus", response_class=PlainTextResponse, include_in_schema=False)
def metrics_prometheus() -> PlainTextResponse:
    """Same KPIs as `/metrics`, in Prometheus text format for external scrapers."""
    db_up = True
    try:
        snapshot = runtime_module.current().tasks.metrics()
    except Exception as exc:  # noqa: BLE001 - expose scrape-time DB failure as db_up=0
        db_up = False
        log_event(logger, logging.ERROR, "prometheus_db_error", error=f"{type(exc).__name__}: {exc}")
        snapshot = Metrics(
            total_tasks=0,
            by_level={},
            by_model={},
            by_backend={},
            human_review_required=0,
            total_estimated_cost_usd=0.0,
            average_complexity_score=0.0,
        )
    body = metrics_export.render_prometheus(snapshot, db_up=db_up)
    return PlainTextResponse(body, media_type=metrics_export.CONTENT_TYPE)


@router.get("/observability", response_model=ObservabilitySnapshot)
def observability() -> ObservabilitySnapshot:
    try:
        records = runtime_module.current().tasks.list_tasks()
    except Exception as exc:
        log_event(logger, logging.WARNING, "observability_db_degraded", error=f"{type(exc).__name__}: {exc}")
        records = []
    try:
        decisions = runtime_module.current().tasks.list_decisions()
    except Exception as exc:
        log_event(logger, logging.WARNING, "observability_decisions_degraded", error=f"{type(exc).__name__}: {exc}")
        decisions = []
    return monitoring.compute_observability(records, decisions, runtime_module.current().routing.load())


@router.get("/observability/history", response_model=MetricsHistory)
def observability_history(limit: int = Query(default=200, ge=1, le=1000)) -> MetricsHistory:
    """Rolling KPI trend (cost/tokens/latency over time), one point per completed delegation."""
    return runtime_module.current().tasks.metrics_history(limit=limit)


# --- Predicciones (Fase 4: XGBoost) ------------------------------------------


@router.get("/analytics/predictions/status")
def predictions_status() -> dict:
    """Si hay datos suficientes para entrenar y si ya existe un modelo entrenado.

    Nunca falla con 500: sin xgboost instalado o sin datos, sigue siendo un
    200 con `trained: false` — el mismo criterio "degradar, no romper" que
    `/analytics/dashboard`.
    """
    try:
        return ml_ops.training_readiness()
    except Exception as exc:  # noqa: BLE001 - degrade instead of 500
        log_event(logger, logging.WARNING, "predictions_status_error", error=f"{type(exc).__name__}: {exc}")
        return {"trained": False, "samples": 0, "min_required": 0, "meets_gate": False}


@router.post("/predict/task", response_model=PredictTaskResponse)
def predict_task(request: PredictTaskRequest) -> PredictTaskResponse:
    """Predice éxito/coste/latencia para un borrador de tarea (aún sin delegar).

    Pensado para llamarse justo después de `/classify-task`: los campos de
    `PredictTaskRequest` calcan los de `ClassificationResult` más las pistas de
    enrutado (`provider_name`/`model_id`/`backend`) que el caller está a punto
    de usar en `/delegate-task`.
    """
    features = {
        "ambiguity": request.criteria.ambiguity,
        "context_required": request.criteria.context_required,
        "reasoning_depth": request.criteria.reasoning_depth,
        "autonomy_required": request.criteria.autonomy_required,
        "operational_risk": request.criteria.operational_risk,
        "validation_difficulty": request.criteria.validation_difficulty,
        "complexity_score": request.complexity_score,
        "prompt_length": float(request.prompt_length or 0),
        "subtask_count": float(request.subtask_count or 0),
        "task_type": request.task_type or request.intent,
        "domain": request.domain[0] if request.domain else "general",
        "intent": request.intent,
        "provider_name": request.provider_name or "unknown",
        "model_id": request.model_id or "unknown",
        "backend": request.backend or "unknown",
    }
    try:
        result = ml_ops.predict(features)
    except MLUnavailable as exc:
        raise HTTPException(status_code=503, detail={"error": "unavailable", "message": str(exc)}) from exc
    except ModelNotTrained as exc:
        raise HTTPException(status_code=503, detail={"error": "not trained", "message": str(exc)}) from exc
    return PredictTaskResponse(**result)


# --- Producción: acierto, flujo, eficiencia, matriz de skills y «qué mejorar» -----------------------------------
# Un mismo cálculo (app/analytics/produccion.py, con port idéntico en atlas/src/produccion.ts) del que cada ruta sirve su
# parte. `perfil=activo` (por defecto) deja solo los agentes del perfil por defecto; `todos` enseña el histórico completo.


def _produccion(dias: int, perfil: str) -> dict:
    rt = runtime_module.current()
    layout = rt.routing.load()
    agentes = produccion_datos.agentes_del_perfil(layout) if perfil == "activo" else None
    no_disponibles: list[str] = []
    if agentes is not None:
        estado = {c.provider: c.ready for c in credentials.detect_all()}
        no_disponibles = [a for a in agentes if a in estado and not estado[a]]
    return produccion_ops.produccion(
        produccion_datos.tareas_planas(rt.tasks),
        catalogo=produccion_datos.catalogo_real(),
        agentes_perfil=agentes,
        dias=dias,
        ahora=datetime.now(timezone.utc),
        no_disponibles=no_disponibles,
    )


_DIAS = Query(default=0, ge=0, le=3650)
_PERFIL = Query(default="activo", pattern="^(activo|todos)$")


def _cabecera(p: dict) -> dict:
    return {k: p[k] for k in ("dias", "perfil", "agentes_perfil", "ultima", "kpis")}


@router.get("/analytics/produccion")
def analytics_produccion(dias: int = _DIAS, perfil: str = _PERFIL) -> dict:
    p = _produccion(dias, perfil)
    p.pop("acierto")
    return p


@router.get("/analytics/flujo")
def analytics_flujo(dias: int = _DIAS, perfil: str = _PERFIL) -> dict:
    p = _produccion(dias, perfil)
    return {**_cabecera(p), **p["flujo"]}


@router.get("/analytics/eficiencia")
def analytics_eficiencia(dias: int = _DIAS, perfil: str = _PERFIL) -> dict:
    p = _produccion(dias, perfil)
    return {**_cabecera(p), **p["eficiencia"]}


@router.get("/analytics/matriz-skills")
def analytics_matriz_skills(dias: int = _DIAS, perfil: str = _PERFIL) -> dict:
    p = _produccion(dias, perfil)
    return {**_cabecera(p), **p["matriz"]}


@router.get("/analytics/sugerencias")
def analytics_sugerencias(dias: int = _DIAS, perfil: str = _PERFIL) -> dict:
    p = _produccion(dias, perfil)
    return {**_cabecera(p), "sugerencias": p["sugerencias"]}


@router.get("/analytics/acierto")
def analytics_acierto(dias: int = _DIAS, perfil: str = _PERFIL) -> dict:
    p = _produccion(dias, perfil)
    return {**_cabecera(p), "tareas": p["acierto"]}


@router.get("/skills/catalogo")
def skills_catalogo(dias: int = Query(default=90, ge=0, le=3650)) -> dict:
    p = _produccion(dias, "todos")
    return {"dias": dias, **p["catalogo"]}


class Revision(BaseModel):
    task_id: str = Field(min_length=1, max_length=80)
    campos: dict[str, list[str]] = Field(default_factory=dict)
    revisado_en: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class Revisiones(BaseModel):
    revisiones: list[Revision] = Field(default_factory=list, max_length=5000)


_CAMPOS_REVISION = {"agente_entrada", "agente", "skills_usadas", "categoria_skill", "nivel_tarea", "dominio", "intencion", "palabras_clave"}


@router.post("/feedback/revisiones")
def feedback_revisiones(body: Revisiones, _: None = Depends(require_token)) -> dict:
    """Lo revisado por el usuario en la cabecera de agente de las notas del baúl (lo envía Atlas dev al reindexar)."""
    store = runtime_module.current().tasks
    guardadas = 0
    for r in body.revisiones:
        campos = {k: [str(v)[:120] for v in vs[:50]] for k, vs in r.campos.items() if k in _CAMPOS_REVISION}
        store.save_reviews(r.task_id, campos, r.revisado_en)
        guardadas += 1
    return {"guardadas": guardadas}
