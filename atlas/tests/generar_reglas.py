"""Genera tests/fixtures/reglas.json: áreas y regla elegida por el preset por dominio, según el Karajan Python.

Uso (desde la raíz del repo): python atlas/tests/generar_reglas.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app import routing_rules  # noqa: E402
from app.models import RoutingLayout  # noqa: E402
from app.router import classify_prompt  # noqa: E402

PROMPTS = [
    "Diseña la interfaz del dashboard con componentes React y animaciones",
    "Rediseña por completo la arquitectura de la interfaz de usuario del panel de control con un sistema de diseño nuevo y accesible",
    "Crea un endpoint REST en la API para listar usuarios y valida con tests.",
    "Prepara el informe mensual de gastos en Excel y envíalo por correo",
    "Renombra una variable",
    "Cambia el color de un botón de la interfaz",
    "Migra la base de datos de SQLite a Postgres sin perder datos y con un plan de rollback",
    "Analiza los logs del pipeline de despliegue en Docker",
    "Resume este documento PDF",
]

profile = routing_rules.domain_preset_profile()
layout = RoutingLayout.model_validate(
    {"profiles": [profile], "active_profile_id": profile["id"], "default_profile_id": profile["id"]}
).project_default_profile()
casos = []
for prompt in PROMPTS:
    c = classify_prompt(prompt)
    subtareas = []
    for st in c.subtasks:
        m = routing_rules.match_for_layout(layout, domains=c.domain, intent=c.intent, level=routing_rules.rule_level(c.complexity_level.value, st.complexity), prompt=prompt)
        subtareas.append({"nivel": st.complexity, "regla": m.rule.id if m else None, "entidad": m.entity.id if m else None})
    casos.append({"prompt": prompt, "areas": routing_rules.detect_areas(prompt), "dominios": c.domain, "intencion": c.intent, "subtareas": subtareas})

salida = Path(__file__).parent / "fixtures" / "reglas.json"
salida.write_text(json.dumps(casos, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"{len(casos)} casos -> {salida}")
