"""De la base de datos de Karajan a la entrada de `produccion.py`: tareas planas, catálogo real de skills y agentes del perfil.

El port de TypeScript (`atlas/src/produccion.ts`) monta lo mismo desde su `Almacen`.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from app import skills_catalog
from app.database import TaskStore
from app.models import RoutingLayout, TaskRecord

_DESCRIPCION = re.compile(r"^description:\s*(.+)$", re.MULTILINE)


def tarea_plana(record: TaskRecord, runs: list[dict], decisiones: list[str], revision: dict[str, list[str]] | None) -> dict[str, Any]:
    c = record.classification
    ejecutadas: set[str] = set()
    if record.delegation:
        hechas = {e.subtask_id for e in record.delegation.executions if e.status.value == "completed"}
        ejecutadas = {s.recommended_skill for s in c.subtasks if s.recommended_skill and s.id in hechas}
    recomendadas = set(c.recommended_skills) | {s.recommended_skill for s in c.subtasks if s.recommended_skill}
    return {
        "task_id": record.task_id,
        "prompt": record.prompt,
        "status": record.status.value,
        "created_at": record.created_at.isoformat(),
        "entry_agent": c.entry_agent,
        "classified_by": c.classified_by,
        "nivel": c.complexity_level.value,
        "dominios": list(c.domain),
        "intencion": c.intent,
        "recomendadas": sorted(recomendadas),
        "ejecutadas": sorted(ejecutadas),
        "runs": [
            {k: r.get(k) for k in ("provider_name", "status", "latency_ms", "estimated_cost_usd", "error")}
            for r in runs
        ],
        "decisiones": decisiones,
        "revision": revision or {},
    }


def tareas_planas(store: TaskStore) -> list[dict[str, Any]]:
    revisiones = store.list_reviews()
    decisiones: dict[str, list[str]] = {}
    for d in store.list_decisions():
        decisiones.setdefault(d.task_id, []).append(d.decision)
    return [
        tarea_plana(r, store.list_runs(r.task_id) if r.delegation else [], decisiones.get(r.task_id, []), revisiones.get(r.task_id))
        for r in store.list_tasks()
    ]


def _descripcion(skill_md: Path) -> str:
    try:
        m = _DESCRIPCION.search(skill_md.read_text(encoding="utf-8", errors="replace")[:4000])
    except OSError:
        return ""
    return m.group(1).strip().strip("\"'") if m else ""


def catalogo_real(raices: tuple[Path, ...] | None = None) -> list[dict[str, Any]]:
    """Las skills instaladas de verdad (carpetas con SKILL.md) más el catálogo conocido de Karajan, sin duplicados."""
    raices = raices or skills_catalog._skill_dirs()  # noqa: SLF001 - mismo criterio que el catálogo
    vistas: dict[str, dict[str, Any]] = {}
    for raiz in raices:
        if not raiz.is_dir():
            continue
        for carpeta in sorted(raiz.iterdir()):
            md = carpeta / "SKILL.md"
            # Las desactivadas (`_nombre`, `nombre.disabled`) no cuentan como instaladas.
            if carpeta.name.startswith(("_", ".")) or carpeta.name.endswith(".disabled"):
                continue
            if carpeta.is_dir() and md.is_file() and carpeta.name.casefold() not in vistas:
                vistas[carpeta.name.casefold()] = {"nombre": carpeta.name, "descripcion": _descripcion(md), "instalada": True}
    for s in skills_catalog.list_skills():
        vistas.setdefault(s.name.casefold(), {"nombre": s.name, "descripcion": s.description, "instalada": s.installed})
    return sorted(vistas.values(), key=lambda s: s["nombre"].casefold())


def agentes_del_perfil(layout: RoutingLayout) -> list[str]:
    """Los proveedores de las entidades del perfil por defecto (el que se usa al delegar)."""
    return sorted({e.provider for e in layout.default_profile().entities if e.provider})
