"""Genera las fixtures de paridad del puerto TypeScript a partir del Karajan en Python.

Uso, con el venv de Karajan y desde la raíz del repo:
    .venv/Scripts/python.exe atlas/tests/generar_fixtures.py atlas/tests/fixtures
(luego borra los tareas.db-wal / -shm que queden). Escribe clasificacion.json, tareas.db y analitica.json.
"""
import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, ".")
from app import skills_catalog  # noqa: E402
from app import skill_analytics  # noqa: E402
from app.database import TaskStore  # noqa: E402
from app.models import (  # noqa: E402
    DelegationResult, KarajanConfig, SubtaskExecution, TaskStatus, Backend,
)
from app.router import classify_prompt  # noqa: E402

SALIDA = Path(sys.argv[1])
SALIDA.mkdir(parents=True, exist_ok=True)

PROMPTS = [
    "Corrige el bug en el login: la API devuelve 500 cuando el token expira",
    "fix the failing unit test in the backend",
    "Crea un dashboard con métricas de ventas y un informe en PDF",
    "Implementa una cache LRU con TTL y pruebas unitarias",
    "Resume este documento",
    "Revisa la arquitectura del sistema distribuido y decide si migrar a microservicios, con riesgo en producción",
    "Despliega a producción el pipeline de Jenkins con docker y kubernetes; borrar los secretos antiguos",
    "Analiza la vulnerabilidad en las credenciales y el permiso de auth del servicio",
    "Hola",
    "hacer algo mejor, rápido y simple, varios cambios etc?",
    "¿Qué es mejor? ¿Algo así o algo asá? ¿Cómo lo hacemos?",
    "Traduce el texto al inglés",
    "Diseña un workflow multi-agente con orquestador, cola async y optimiza el rendimiento y la escalabilidad del algoritmo",
    "Add a new feature to the frontend: a ux roadmap view with requirements, ui components, and tests",
    "Extrae las tablas del contrato docx con ocr",
    "build an ETL that loads csv into sql and reports analytics metrics on a dashboard",
    "audita el repo con varios archivos, base de datos, logs, existing pipeline, sistema, modulo, componente, servicio, clase, interfaz",
    "Escribe una función",
    "Automatiza end to end el despliegue: construye, ejecuta tests, genera el release y deploy en producción con dinero y legal en juego",
    "Refactor the code to improve performance; fix the error in the database layer and add coverage with assert, mock and fixture",
    "Seguridad: revisa el token, el secret y el malware; amenaza y threat model con permisos",
    "ci cd release",
    " ".join(["analiza el sistema"] * 25) + " con arquitectura distribuida y multi workflow",
    " ".join(["revisa el componente"] * 45),
    "implementa, desarrolla, construye, diseña, crea, escribe y genera con build create develop ejecuta automatiza",
    "optimiza la complejidad del árbol y del graph con algoritmo y patron decorator memoiz",
    "sqlite test unitario integracion cobertura api database dashboard visual",
    "Translate and summarize and extract",
    "Que haces con ñandú y camión? añade acentuación",
    "Auth bug in prod?",
]

cfg = KarajanConfig()
clasificaciones = []
for p in PROMPTS:
    fila = {"prompt": p}
    for nombre, c in (("con_config", cfg), ("sin_config", None)):
        r = classify_prompt(p, c).model_dump(mode="json")
        r.pop("task_id"); r.pop("created_at")
        fila[nombre] = r
    clasificaciones.append(fila)
(SALIDA / "clasificacion.json").write_text(json.dumps(clasificaciones, ensure_ascii=False, indent=1), encoding="utf-8")

# ── base sintética con tareas, delegaciones y runs ─────────────────────────
db_ruta = SALIDA / "tareas.db"
for suf in ("", "-wal", "-shm"):
    Path(str(db_ruta) + suf).unlink(missing_ok=True)
store = TaskStore(db_ruta)
AHORA = datetime(2026, 10, 1, 12, 0, 0, tzinfo=timezone.utc)
PROVEEDORES = ["claude-cli", "codex-cli", "ollama"]
for i, prompt in enumerate(PROMPTS[:16]):
    clasif = classify_prompt(prompt, cfg)
    clasif.task_id = f"tsk_fix{i:03d}"
    clasif.created_at = AHORA - timedelta(days=i * 9, hours=i)
    store.save_classification(clasif)
    if i % 3 == 2:
        continue  # sin delegar
    ejecs = []
    for j, sub in enumerate(clasif.subtasks):
        ok = (i + j) % 4 != 0
        ejecs.append(SubtaskExecution(
            subtask_id=sub.id, status=TaskStatus.COMPLETED if ok else TaskStatus.FAILED, backend=Backend.CLI,
            model_used=["strong", "cheap", "medium"][(i + j) % 3], latency_ms=300 + 170 * j + i, estimated_cost_usd=round(0.001 * (j + 1) + i * 0.0003, 6),
            output="ok", error=None if ok else "fallo", input_tokens=100 + 10 * j, output_tokens=40 + j,
        ))
    deleg = DelegationResult(
        task_id=clasif.task_id, status=TaskStatus.COMPLETED, executions=ejecs, total_latency_ms=sum(e.latency_ms for e in ejecs),
        total_estimated_cost_usd=round(sum(e.estimated_cost_usd for e in ejecs), 6), total_input_tokens=300, total_output_tokens=120,
        completed_at=clasif.created_at + timedelta(minutes=5, microseconds=123456 if i % 2 else 0),
    )
    store.save_delegation(deleg)
    for j, e in enumerate(ejecs):
        prov = PROVEEDORES[(i + j) % 3]
        store.record_run(
            clasif.task_id, prov, None, prov.upper() if j % 2 else None, f"modelo-{prov}", "cli", e.status.value,
            deleg.completed_at.isoformat(), deleg.completed_at.isoformat(), e.latency_ms, e.input_tokens, e.output_tokens, e.estimated_cost_usd, e.error,
        )

with sqlite3.connect(db_ruta) as c:
    c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
for suf in ("-wal", "-shm"):
    try:
        Path(str(db_ruta) + suf).unlink(missing_ok=True)
    except PermissionError:
        pass

store = TaskStore(db_ruta)
registros = store.list_tasks()
runs = {r.task_id: store.list_runs(r.task_id) for r in registros if r.delegation is not None}
conocidas = [s.name for s in skills_catalog.list_skills()]
salida = {
    "ahora": AHORA.isoformat(),
    "metricas": store.metrics().model_dump(mode="json"),
    "agentes": store.agent_performance(),
    "skills_conocidas": conocidas,
    "analitica": {str(d): skill_analytics.build_skill_analytics(registros, runs_by_task=runs, known_skills=conocidas, days=d, now=AHORA) for d in (0, 30, 3650)},
}
(SALIDA / "analitica.json").write_text(json.dumps(salida, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
try:
    with sqlite3.connect(db_ruta) as c:
        c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
except sqlite3.OperationalError:
    pass
print("fixtures:", len(clasificaciones), "clasificaciones;", len(registros), "tareas;", sum(len(v) for v in runs.values()), "runs")
