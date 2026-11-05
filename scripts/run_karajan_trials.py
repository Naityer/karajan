from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


DEFAULT_API = "http://127.0.0.1:8001"
REPORT_DIR = Path("data/trial_reports")


@dataclass(frozen=True)
class Trial:
    name: str
    payload: dict[str, Any]


TRIALS: list[Trial] = [
    Trial(
        name="N1 simple / Groq",
        payload={
            "original_prompt": "Revisa el README de KARAJAN y propón tres mejoras menores de claridad sin tocar código.",
            "domain": ["documentation", "product"],
            "intent": "documentation_review",
            "criteria": {
                "ambiguity": 0.8,
                "context_required": 1.0,
                "reasoning_depth": 1.0,
                "autonomy_required": 0.7,
                "operational_risk": 0.2,
                "validation_difficulty": 0.7,
            },
            "recommended_strategy": "single_pass",
            "recommended_skills": ["ponytail"],
            "subtasks": [
                {
                    "id": "sub_001",
                    "name": "Revisar claridad del README",
                    "complexity": 1,
                    "recommended_model": "cheap_model",
                    "recommended_skill": "ponytail",
                    "validation": "Las mejoras son puntuales y no cambian comportamiento.",
                }
            ],
            "reason": "Tarea simple, bajo riesgo y validación textual directa.",
            "validation_plan": "Comparar cambios propuestos contra el README actual.",
        },
    ),
    Trial(
        name="N2/N3 intermedia / Gemini",
        payload={
            "original_prompt": "Analiza la pantalla Decisión y define mejoras UX para que la asignación de niveles y skills sea más auditable.",
            "domain": ["frontend", "product", "ux"],
            "intent": "ux_audit_and_plan",
            "criteria": {
                "ambiguity": 2.0,
                "context_required": 2.4,
                "reasoning_depth": 2.8,
                "autonomy_required": 2.2,
                "operational_risk": 1.2,
                "validation_difficulty": 2.4,
            },
            "recommended_strategy": "divide_and_delegate",
            "recommended_skills": ["frontend-builder", "repo-analyzer", "ponytail"],
            "subtasks": [
                {
                    "id": "sub_001",
                    "name": "Auditar interacción de niveles globales",
                    "complexity": 2,
                    "recommended_model": "cheap_or_medium_model",
                    "recommended_skill": "frontend-builder",
                    "validation": "Los niveles no se repiten y el propietario queda claro visualmente.",
                },
                {
                    "id": "sub_002",
                    "name": "Proponer métricas de seguimiento de skills por entidad",
                    "complexity": 3,
                    "recommended_model": "medium_model",
                    "recommended_skill": "repo-analyzer",
                    "validation": "La propuesta se puede mapear a eventos persistidos.",
                },
            ],
            "reason": "Requiere contexto de UI y producto, con riesgo bajo pero varias subtareas.",
            "validation_plan": "Contrastar propuesta con la UI actual y eventos existentes.",
        },
    ),
    Trial(
        name="N4/N5 crítica / Padre",
        payload={
            "original_prompt": "Audita la implementación de proveedores CLI/API y diseña una puerta de seguridad antes de ejecutar modelos reales con coste o procesos largos.",
            "domain": ["backend", "security", "operations"],
            "intent": "security_architecture_review",
            "criteria": {
                "ambiguity": 3.4,
                "context_required": 4.2,
                "reasoning_depth": 4.4,
                "autonomy_required": 3.8,
                "operational_risk": 4.7,
                "validation_difficulty": 4.2,
            },
            "recommended_strategy": "human_gated_delegation",
            "recommended_skills": ["security-review", "backend-builder", "repo-analyzer", "ponytail"],
            "subtasks": [
                {
                    "id": "sub_001",
                    "name": "Inspeccionar rutas que pueden lanzar proveedores reales",
                    "complexity": 4,
                    "recommended_model": "strong_model",
                    "recommended_skill": "security-review",
                    "validation": "No hay ejecución real sin aprobación explícita.",
                },
                {
                    "id": "sub_002",
                    "name": "Diseñar registro auditable de aprobaciones y coste estimado",
                    "complexity": 5,
                    "recommended_model": "strong_model_with_human_review",
                    "recommended_skill": "backend-builder",
                    "validation": "La auditoría indica quién aprobó, proveedor, coste y motivo.",
                },
            ],
            "reason": "Afecta ejecución real, coste, credenciales y seguridad operativa.",
            "requires_human_review": True,
            "validation_plan": "Revisión humana antes de activar cualquier proveedor real.",
        },
    ),
]


def request_json(method: str, url: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} failed: HTTP {exc.code} {detail}") from exc


def run(api_base: str) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for trial in TRIALS:
        task = request_json("POST", f"{api_base}/ingest", trial.payload)
        delegated = request_json("POST", f"{api_base}/delegate-task", {"task_id": task["task_id"]})
        decisions = request_json("GET", f"{api_base}/tasks/{task['task_id']}/decisions")
        classification = delegated["classification"]
        delegation = delegated.get("delegation") or {}
        results.append(
            {
                "trial": trial.name,
                "task_id": task["task_id"],
                "status": delegated["status"],
                "level": classification["complexity_level"],
                "score": classification["complexity_score"],
                "recommended_model": classification["recommended_model"],
                "skills": classification.get("recommended_skills", []),
                "executions": delegation.get("executions", []),
                "decisions": decisions,
            }
        )
    return results


def write_report(results: list[dict[str, Any]]) -> Path:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = REPORT_DIR / f"karajan_trials_{stamp}.json"
    path.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description="Run KARAJAN skill-style routing trials.")
    parser.add_argument("--api", default=DEFAULT_API, help=f"KARAJAN API base URL. Default: {DEFAULT_API}")
    args = parser.parse_args()
    results = run(args.api.rstrip("/"))
    report = write_report(results)
    for item in results:
        print(
            f"{item['trial']}: {item['task_id']} | {item['status']} | "
            f"{item['level']} score={item['score']} model={item['recommended_model']} "
            f"skills={','.join(item['skills']) or '-'}"
        )
    print(f"Report: {report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
