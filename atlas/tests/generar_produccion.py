"""Genera tests/fixtures/produccion.json: paridad de `app/analytics/produccion.py` con `atlas/src/produccion.ts`.

Uso, desde la raíz del repo de Karajan:
    python atlas/tests/generar_produccion.py atlas/tests/fixtures
Toma las tareas de fixtures/tareas.db (vía `produccion_datos.tareas_planas`) y un juego sintético con re-trabajo, validaciones,
revisión humana y revisiones del baúl, y guarda la salida de `produccion()` para varios perfiles y periodos.
"""
import json
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, ".")
from app.analytics import produccion, produccion_datos  # noqa: E402
from app.database import TaskStore  # noqa: E402

SALIDA = Path(sys.argv[1])
AHORA = datetime(2026, 10, 12, 9, 30, tzinfo=timezone.utc)
CATALOGO = [
    {"nombre": "frontend-builder", "descripcion": "UI, componentes, dashboards", "instalada": True},
    {"nombre": "impeccable", "descripcion": "Polish and audit interfaces", "instalada": True},
    {"nombre": "docx", "descripcion": "Word documents", "instalada": True},
    {"nombre": "Security-Review", "descripcion": "secretos y permisos", "instalada": False},
    {"nombre": "pdf", "descripcion": "", "instalada": True},
]


def t(tid, prompt, cuando, agente="codex", estado="completed", nivel="level_2_moderate", dominio="frontend", skills=(),
      recomendadas=(), entrada=None, decisiones=(), revision=None, latencia=1000, coste=0.001, por="heuristic"):
    runs = [] if agente is None else [
        {"provider_name": agente, "status": "completed" if estado == "completed" else "failed", "latency_ms": latencia, "estimated_cost_usd": coste, "error": None if estado == "completed" else "fallo"},
        {"provider_name": agente, "status": "completed", "latency_ms": latencia * 2 + 7, "estimated_cost_usd": coste / 3, "error": None},
    ]
    return {"task_id": tid, "prompt": prompt, "status": estado, "created_at": cuando, "entry_agent": entrada, "classified_by": por,
            "nivel": nivel, "dominios": [dominio], "intencion": "implement_feature", "recomendadas": sorted(set(recomendadas) | set(skills)),
            "ejecutadas": sorted(set(skills)), "runs": runs, "decisiones": list(decisiones), "revision": revision or {}}


V_OK = "sub_001:validator=Worker;verdict=approved;priority=P3"
V_MAL = "sub_001:verdict=needs_revision;iteration=1;"
SINTETICAS = [
    t("s01", "Haz que las tarjetas del mapa sean cápsulas compactas y añade un chevron", "2026-10-01T10:00:00.123456+00:00", skills=["frontend-builder"], decisiones=[V_OK], entrada="claude"),
    t("s02", "Las tarjetas del mapa siguen sin ser cápsulas compactas, corrige eso", "2026-10-01T11:30:00+00:00", skills=["impeccable"], entrada="claude", revision={"nivel_tarea": ["N3"], "skills_usadas": ["impeccable", "frontend-builder"]}),
    t("s03", "Ajusta mapa-espacio.tsx y layout.ts para el autoenfoque del MapaEspacio", "2026-10-02T09:00:00+00:00", agente="claude-cli", nivel="level_3_intermediate", entrada="codex"),
    t("s04", "En mapa-espacio.tsx el layout.ts no centra bien el MapaEspacio", "2026-10-02T12:00:00+00:00", agente="claude-cli", nivel="level_3_intermediate", entrada="codex", decisiones=["human_review_gate=blocked"]),
    t("s05", "Exporta el informe trimestral en PDF con las ventas por región", "2026-10-03T08:00:00+00:00", agente="ollama-qwen", nivel="level_1_simple", dominio="documents", skills=["pdf"], coste=0.0002, decisiones=[V_MAL]),
    t("s06", "exporta el informe trimestral en pdf con las ventas por region otra vez", "2026-10-03T09:00:00+00:00", agente="ollama-qwen", nivel="level_1_simple", dominio="documents", estado="failed"),
    t("s07", "exporta el informe trimestral en pdf con las ventas por region otra vez", "2026-10-03T10:00:00+00:00", agente="ollama-qwen", nivel="level_1_simple", dominio="documents", estado="failed"),
    t("s08", "Crea un endpoint de usuarios con paginación", "2026-10-05T10:00:00+00:00", agente=None, estado="classified", dominio="backend", recomendadas=["backend-builder"]),
    t("s09", "Diseña la pantalla de ajustes", "2026-10-06T10:00:00+00:00", agente="simulated", recomendadas=["backend-builder"]),
    t("s10", "Diseña la pantalla de ajustes con modo oscuro", "2026-10-08T10:00:00+00:00", agente="codex", recomendadas=["backend-builder"], por="model:/karajan", revision={"agente": ["claude-cli"], "agente_entrada": ["claude"], "dominio": ["interfaz"]}),
    t("s11", "Una tarea antigua del verano", "2026-07-01T10:00:00+00:00", agente="codex", latencia=500),
    # Salud: Claude cae por tiempo agotado, tareas que solo se clasificaron, una revisión pendiente, el límite semanal y el rotador.
    t("s12", "Refactoriza el router de tareas", "2026-10-09T10:00:00+00:00", agente="claude-cli", estado="failed", nivel="level_4_complex", dominio="backend"),
    t("s13", "Refactoriza el router de tareas otra vez", "2026-10-09T11:00:00+00:00", agente="claude-cli", estado="failed", nivel="level_4_complex", dominio="backend",
      decisiones=["human_review_gate=blocked"]),
    t("s14", "Resume el informe de ventas", "2026-10-10T10:00:00+00:00", agente="codex", dominio="documents", decisiones=["limite_semanal:claude->codex", "skill:repuesta:docx->codex"]),
    t("s15", "Prepara la presentación del trimestre", "2026-10-10T12:00:00+00:00", agente=None, estado="classified", dominio="documents"),
    t("s16", "Revisa el contrato de proveedores", "2026-10-11T08:00:00+00:00", agente=None, estado="classified", dominio="documents"),
]
for s in SINTETICAS:
    if s["task_id"] in ("s12", "s13"):
        s["runs"][0]["error"] = "Timed out after 600 s"
        s["runs"][1] = {**s["runs"][1], "status": "failed", "error": "binario no encontrado"}
SIN_NIVEL = ["Revisor (sin niveles)"]

with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
    copia = Path(tmp) / "tareas.db"
    shutil.copyfile(SALIDA / "tareas.db", copia)
    store = TaskStore(copia)
    store.save_reviews("tsk_fix000", {"nivel_tarea": ["N4"], "skills_usadas": ["docx"]}, "2026-10-02T00:00:00+00:00")
    DESDE_DB = produccion_datos.tareas_planas(store)
    del store

casos = []
for nombre, entrada in (("db", DESDE_DB), ("sinteticas", SINTETICAS)):
    for perfil in (None, ["claude-cli", "codex", "ollama-qwen"]):
        for dias in (0, 30):
            casos.append({
                "entrada": nombre, "perfil": perfil, "dias": dias, "no_disponibles": ["ollama-qwen"] if perfil else [], "sin_nivel": SIN_NIVEL if perfil else [],
                "salida": produccion.produccion(entrada, catalogo=CATALOGO, agentes_perfil=perfil, dias=dias, ahora=AHORA, no_disponibles=["ollama-qwen"] if perfil else [], sin_nivel=SIN_NIVEL if perfil else []),
            })

(SALIDA / "produccion.json").write_text(json.dumps({
    "ahora": AHORA.isoformat(), "catalogo": CATALOGO, "revision_db": {"task_id": "tsk_fix000", "campos": {"nivel_tarea": ["N4"], "skills_usadas": ["docx"]}},
    "desde_db": DESDE_DB, "sinteticas": SINTETICAS, "casos": casos,
}, ensure_ascii=False, indent=1), encoding="utf-8")
print("produccion.json:", len(DESDE_DB), "tareas de la db,", len(SINTETICAS), "sintéticas,", len(casos), "casos")
