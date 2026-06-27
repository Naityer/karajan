from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app import delegation, main, monitoring
from app.database import TaskStore
from app.models import Backend, DecisionLogEntry, KarajanConfig, OrchestrationConfig
from app.providers.base import ModelProvider, ProviderRun
from app.providers.registry import Resolution
from app.providers.simulated import SimulatedModelProvider
from app.router import classify_prompt


DEFAULT_API = os.environ.get("KARAJAN_API", "http://127.0.0.1:8000")
REPORT_DIR = Path("data/audit_reports")


@dataclass(frozen=True)
class AuditCase:
    name: str
    phase: str
    mode: str


class AuditApi:
    def __init__(self, base_url: str, token: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token or os.environ.get("KARAJAN_TOKEN", "")

    def request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any] | list[Any]:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(f"{self.base_url}{path}", data=body, method=method)
        req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("X-KARAJAN-Token", self.token)
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{method} {path} failed: HTTP {exc.code} {detail}") from exc


class FailingAuditProvider(ModelProvider):
    backend = Backend.API

    def run(self, instruction: str, model_id: str, timeout_s: int) -> ProviderRun:
        return ProviderRun(output="", model_used=f"audit-failing:{model_id}", latency_ms=7, error="audit injected failure")


def _criteria(value: float) -> dict[str, float]:
    return {
        "ambiguity": value,
        "context_required": value,
        "reasoning_depth": value,
        "autonomy_required": value,
        "operational_risk": value,
        "validation_difficulty": value,
    }


def _agent_payload(
    name: str,
    criteria: dict[str, float],
    *,
    review: bool = False,
    domain: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "original_prompt": name,
        "domain": domain or ["product", "programming"],
        "intent": "audit_orchestration",
        "criteria": criteria,
        "recommended_strategy": "audit_and_delegate",
        "recommended_skills": ["repo-analyzer", "backend-builder", "security-review"],
        "requires_human_review": review,
        "validation_plan": "Confirmar decisiones, fallback, rol propietario y evidencia persistida.",
    }


def run_isolated_routing() -> dict[str, Any]:
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        previous_store = main.store
        previous_config = main.active_config
        try:
            main.store = TaskStore(Path(tmp) / "isolated-routing.db")
            main.active_config = KarajanConfig(backend=Backend.SIMULATED)
            client = TestClient(main.app)
            task = client.post(
                "/ingest",
                json=_agent_payload(
                    "Audita roles, prioridades y skills para una tarea de orquestación de agentes.",
                    {
                        "ambiguity": 2.4,
                        "context_required": 3.0,
                        "reasoning_depth": 3.2,
                        "autonomy_required": 2.7,
                        "operational_risk": 1.8,
                        "validation_difficulty": 2.6,
                    },
                ),
            ).json()
            delegated = client.post("/delegate-task", json={"task_id": task["task_id"]}).json()
            decisions = client.get(f"/tasks/{task['task_id']}/decisions").json()
            observability = client.get("/observability").json()
        finally:
            main.store = previous_store
            main.active_config = previous_config

    classification = delegated["classification"]
    return {
        "case": "isolated_routing_roles_priorities",
        "phase": "fase_1",
        "mode": "isolated",
        "task_id": task["task_id"],
        "status": delegated["status"],
        "level": classification["complexity_level"],
        "model": classification["recommended_model"],
        "skills": classification["recommended_skills"],
        "subtasks": classification["subtasks"],
        "roles_observed": [node["role"] for node in observability["nodes"]],
        "priority_inferred": classification["complexity_level"],
        "decisions": decisions,
    }


def run_isolated_fallback() -> dict[str, Any]:
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        store = TaskStore(Path(tmp) / "isolated-fallback.db")
        classification = classify_prompt(
            "Fuerza error de proveedor para validar retry, fallback gratuito y auditoría centralizada."
        )
        store.save_classification(classification, monitoring.build_classify_decision(classification))
        previous_resolve = delegation.resolve
        previous_fallbacks = delegation.fallback_resolutions
        try:
            delegation.resolve = lambda tier, config: Resolution(  # type: ignore[assignment]
                FailingAuditProvider(), Backend.API, tier.value, "audit-failing"
            )
            delegation.fallback_resolutions = lambda tier, config, tried: [  # type: ignore[assignment]
                Resolution(SimulatedModelProvider(), Backend.SIMULATED, tier.value, "simulated")
            ]
            result, decisions = delegation.delegate(
                classification,
                KarajanConfig(
                    backend=Backend.API,
                    orchestration=OrchestrationConfig(max_retries=1, enable_runtime_fallback=True),
                ),
            )
        finally:
            delegation.resolve = previous_resolve  # type: ignore[assignment]
            delegation.fallback_resolutions = previous_fallbacks  # type: ignore[assignment]
        record = store.save_delegation(result, decisions)
        stored_decisions = [item.model_dump(mode="json") for item in store.list_decisions(record.task_id)]

    fallback_decisions = [item for item in stored_decisions if item["phase"] == "fallback"]
    return {
        "case": "isolated_error_fallback",
        "phase": "fase_2",
        "mode": "isolated",
        "task_id": record.task_id,
        "status": record.status.value,
        "fallback_count": len(fallback_decisions),
        "executions": result.model_dump(mode="json")["executions"],
        "decisions": stored_decisions,
    }


def _free_ready_names(catalog: list[dict[str, Any]], providers: list[dict[str, Any]]) -> set[str]:
    free = {item["name"] for item in catalog if item.get("is_free")}
    return {item["provider"] for item in providers if item.get("ready") and item["provider"] in free}


def _active_config_is_free_or_simulated(config: dict[str, Any], free_ready: set[str]) -> bool:
    if config.get("backend") == "simulated":
        return True
    preferences = set((config.get("provider_preferences") or {}).values())
    return bool(preferences) and preferences.issubset(free_ready)


def run_real_free_alternatives(api: AuditApi) -> dict[str, Any]:
    health = api.request("GET", "/health")
    catalog = api.request("GET", "/catalog")
    providers = api.request("GET", "/providers")
    config = api.request("GET", "/config")
    assert isinstance(catalog, list)
    assert isinstance(providers, list)
    assert isinstance(config, dict)
    free_ready = _free_ready_names(catalog, providers)

    payload = _agent_payload(
        "Prueba real segura de alternativas gratuitas: detectar proveedores, delegar solo si el backend activo es gratis o simulado.",
        _criteria(1.4),
    )
    task = api.request("POST", "/ingest", payload)
    assert isinstance(task, dict)

    delegated: dict[str, Any] | None = None
    if _active_config_is_free_or_simulated(config, free_ready):
        delegated = api.request("POST", "/delegate-task", {"task_id": task["task_id"]})  # type: ignore[assignment]
    else:
        api.request(
            "POST",
            f"/tasks/{task['task_id']}/decisions",
            {
                "task_id": task["task_id"],
                "phase": "validate",
                "decision": "audit_policy=blocked;reason=active_provider_not_confirmed_free",
                "reason": "La auditoría no ejecuta proveedores potencialmente pagados sin aprobación humana.",
            },
        )

    decisions = api.request("GET", f"/tasks/{task['task_id']}/decisions")
    return {
        "case": "real_free_alternatives",
        "phase": "fase_3a",
        "mode": "real_api",
        "health": health,
        "free_ready": sorted(free_ready),
        "configured_backend": config.get("backend"),
        "delegated": delegated,
        "task_id": task["task_id"],
        "decisions": decisions,
    }


def run_real_agent_console(api: AuditApi) -> dict[str, Any]:
    task = api.request(
        "POST",
        "/ingest",
        _agent_payload(
            "Consola externa de agente: registrar fallback, reasignación y validación centralizadas.",
            {
                "ambiguity": 2.0,
                "context_required": 2.6,
                "reasoning_depth": 3.0,
                "autonomy_required": 2.1,
                "operational_risk": 2.0,
                "validation_difficulty": 2.8,
            },
        ),
    )
    assert isinstance(task, dict)
    task_id = task["task_id"]
    live_decisions = [
        {
            "task_id": task_id,
            "phase": "fallback",
            "decision": "console_reported_fallback;from=agent-primary;to=backup-free",
            "backend": "simulated",
            "reason": "Decisión reportada desde consola externa para validar centralización.",
        },
        {
            "task_id": task_id,
            "phase": "reassign",
            "decision": "role=reallocator;target=backup;priority=medium",
            "reason": "Validar que decisiones live aparecen en auditoría y observabilidad.",
        },
        {
            "task_id": task_id,
            "phase": "validate",
            "decision": "agent_console=accepted",
            "reason": "La consola externa pudo centralizar decisiones en el harness.",
        },
    ]
    for decision in live_decisions:
        api.request("POST", f"/tasks/{task_id}/decisions", decision)

    decisions = api.request("GET", f"/tasks/{task_id}/decisions")
    observability = api.request("GET", "/observability")
    metrics = api.request("GET", "/metrics")
    return {
        "case": "real_agent_console_centralization",
        "phase": "fase_3b",
        "mode": "real_api",
        "status": "recorded",
        "task_id": task_id,
        "decisions": decisions,
        "observability_status": observability["health"]["status"] if isinstance(observability, dict) else "unknown",
        "metrics": metrics,
    }


def build_summary(results: list[dict[str, Any]]) -> dict[str, Any]:
    fallback_count = sum(
        1
        for result in results
        for decision in result.get("decisions", [])
        if isinstance(decision, dict) and decision.get("phase") == "fallback"
    )
    failed_cases = [result["case"] for result in results if result.get("status") == "failed"]
    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "cases": len(results),
        "fallback_decisions": fallback_count,
        "failed_cases": failed_cases,
        "automatic_improvements_applied": [
            "Runner de auditoría aislado/real con reportes JSON y Markdown.",
            "Fallback runtime auditable a proveedores gratis ready y simulated final.",
            "Fase de decisión fallback reconocida por observabilidad.",
            "Catálogo ampliado con OpenRouter y Hugging Face como candidatos free/API-compatible.",
        ],
        "human_decisions_required": [
            "Activar o no API keys externas: GOOGLE_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, HF_TOKEN.",
            "Definir si fallback puede bajar de tier o debe respetar el mismo tier lógico.",
            "Aprobar uso de proveedores con coste/cuota antes de permitir delegación real.",
            "Formalizar prioridades operativas por rol, nivel y riesgo.",
            "Exigir KARAJAN_TOKEN para cualquier consola externa en entornos no locales.",
        ],
        "production_readiness_next": [
            "Añadir rate limiting en mutaciones.",
            "Persistir actor/origen de cada DecisionLogEntry.",
            "Añadir política configurable de fallback por proveedor/tier.",
            "Ejecutar este runner en CI con modo aislado y en staging con modo real.",
        ],
    }


def write_reports(results: list[dict[str, Any]], summary: dict[str, Any]) -> tuple[Path, Path]:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    json_path = REPORT_DIR / f"karajan_audit_{stamp}.json"
    md_path = REPORT_DIR / f"karajan_audit_{stamp}.md"
    payload = {"summary": summary, "results": results}
    json_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    lines = [
        "# KARAJAN Audit Report",
        "",
        f"- Generated: {summary['generated_at']}",
        f"- Cases: {summary['cases']}",
        f"- Fallback decisions: {summary['fallback_decisions']}",
        f"- Failed cases: {', '.join(summary['failed_cases']) or 'none'}",
        "",
        "## Cases",
    ]
    for result in results:
        lines.extend(
            [
                f"### {result['case']}",
                f"- Phase: {result['phase']}",
                f"- Mode: {result['mode']}",
                f"- Task: {result.get('task_id', '-')}",
                f"- Status: {result.get('status') or result.get('observability_status') or 'recorded'}",
                f"- Decisions: {len(result.get('decisions', []))}",
                "",
            ]
        )
    lines.extend(["## Automatic Improvements Applied", *[f"- {item}" for item in summary["automatic_improvements_applied"]]])
    lines.extend(["", "## Human Decisions Required", *[f"- {item}" for item in summary["human_decisions_required"]]])
    lines.extend(["", "## Production Readiness Next", *[f"- {item}" for item in summary["production_readiness_next"]], ""])
    md_path.write_text("\n".join(lines), encoding="utf-8")
    return json_path, md_path


def run(api_base: str, token: str | None = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    api = AuditApi(api_base, token)
    results = [
        run_isolated_routing(),
        run_isolated_fallback(),
        run_real_free_alternatives(api),
        run_real_agent_console(api),
    ]
    return results, build_summary(results)


def main_cli() -> int:
    parser = argparse.ArgumentParser(description="Run the 3-phase / 4-case KARAJAN production audit.")
    parser.add_argument("--api", default=DEFAULT_API, help=f"KARAJAN API base URL. Default: {DEFAULT_API}")
    parser.add_argument("--token", default=None, help="Optional X-KARAJAN-Token for protected mutation endpoints.")
    args = parser.parse_args()
    results, summary = run(args.api, args.token)
    json_path, md_path = write_reports(results, summary)
    for result in results:
        print(f"{result['phase']} | {result['case']} | {result.get('status', 'recorded')} | task={result.get('task_id', '-')}")
    print(f"JSON report: {json_path}")
    print(f"Markdown report: {md_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main_cli())
