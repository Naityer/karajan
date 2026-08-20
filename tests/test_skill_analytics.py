from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from app import main
from app.database import TaskStore
from app.models import (
    Backend,
    ClassificationResult,
    ComplexityLevel,
    CriteriaScores,
    DelegationResult,
    RecommendedModel,
    Subtask,
    SubtaskExecution,
    TaskRecord,
    TaskStatus,
)
from app.skill_analytics import build_skill_analytics


NOW = datetime(2026, 8, 11, 12, 0, tzinfo=timezone.utc)

# `app.js` (nota "Plan de mejora", §18) se partió en
# `dashboard/static/src/modules/*.js`; estos tests comprueban comportamiento
# del dashboard, no la ubicación de un fichero concreto, así que leen el
# conjunto de módulos concatenado como si fuera el `app.js` monolítico de antes.
_STATIC_DIR = Path(__file__).parents[1] / "dashboard" / "static"


def _frontend_js() -> str:
    return "\n\n".join(
        p.read_text(encoding="utf-8") for p in sorted((_STATIC_DIR / "src" / "modules").glob("*.js"))
    )


def _record(*, delegated: bool = True, status: TaskStatus = TaskStatus.COMPLETED) -> TaskRecord:
    subtask = Subtask(
        id="sub_1",
        name="Auditar repositorio",
        complexity=3,
        recommended_model=RecommendedModel.MEDIUM_MODEL,
        recommended_skill="repo-analyzer",
        validation="Informe verificable",
    )
    classification = ClassificationResult(
        task_id="tsk_1",
        original_prompt="Comprueba la auditoría de un repositorio",
        domain=["software"],
        intent="audit_repository",
        criteria=CriteriaScores(
            ambiguity=1,
            context_required=3,
            reasoning_depth=3,
            autonomy_required=2,
            operational_risk=2,
            validation_difficulty=3,
        ),
        complexity_score=3,
        complexity_level=ComplexityLevel.LEVEL_3_INTERMEDIATE,
        recommended_strategy="analyze",
        recommended_model=RecommendedModel.MEDIUM_MODEL,
        recommended_skills=["repo-analyzer", "security-review"],
        subtasks=[subtask],
        requires_human_review=False,
        reason="Auditoría técnica",
        validation_plan="Revisar hallazgos",
        created_at=NOW,
    )
    delegation = None
    if delegated:
        delegation = DelegationResult(
            task_id="tsk_1",
            status=status,
            executions=[SubtaskExecution(
                subtask_id="sub_1",
                status=status,
                backend=Backend.CLI,
                model_used="codex",
                latency_ms=125,
                estimated_cost_usd=0.004,
                output="ok" if status == TaskStatus.COMPLETED else "",
                error=None if status == TaskStatus.COMPLETED else "fallo",
            )],
            total_latency_ms=125,
            total_estimated_cost_usd=0.004,
            completed_at=NOW,
        )
    return TaskRecord(
        task_id="tsk_1",
        prompt=classification.original_prompt,
        status=status if delegated else TaskStatus.CLASSIFIED,
        classification=classification,
        delegation=delegation,
        created_at=NOW,
        updated_at=NOW,
    )


def test_recommendation_is_not_counted_as_usage() -> None:
    report = build_skill_analytics([_record(delegated=False)], known_skills=["repo-analyzer"], now=NOW)
    row = next(item for item in report["skills"] if item["name"] == "repo-analyzer")
    assert row["recommended_tasks"] == 1
    assert row["executions"] == 0
    assert row["success_rate"] is None
    assert report["summary"]["assignment_coverage"] == 0


def test_execution_is_attributed_to_agent_task_and_success() -> None:
    report = build_skill_analytics(
        [_record()],
        runs_by_task={"tsk_1": [{"routing_entity_name_snapshot": "Codex Auditor"}]},
        known_skills=["repo-analyzer", "unused-skill"],
        now=NOW,
    )
    row = next(item for item in report["skills"] if item["name"] == "repo-analyzer")
    assert row["executions"] == 1
    assert row["success_rate"] == 1
    assert row["agents"] == {"Codex Auditor": 1}
    assert row["task_types"] == {"audit_repository": 1}
    assert report["by_agent"][0]["agent"] == "Codex Auditor"
    assert report["timeline"] == [{
        "date": "2026-08-11",
        "executions": 1,
        "successes": 1,
        "skills": {"repo-analyzer": 1},
    }]
    assert report["summary"]["unused_skills"] == 2  # security-review + unused-skill


def test_failed_execution_is_in_success_denominator() -> None:
    report = build_skill_analytics([_record(status=TaskStatus.FAILED)], now=NOW)
    row = next(item for item in report["skills"] if item["name"] == "repo-analyzer")
    assert row["failures"] == 1
    assert row["success_rate"] == 0
    assert report["summary"]["success_rate"] == 0


def test_skill_names_are_case_insensitive() -> None:
    record = _record()
    record.classification.subtasks[0].recommended_skill = "Repo-Analyzer"
    report = build_skill_analytics([record], known_skills=["repo-analyzer"], now=NOW)
    matching = [item for item in report["skills"] if item["name"].casefold() == "repo-analyzer"]
    assert len(matching) == 1
    assert matching[0]["executions"] == 1


def test_period_uses_execution_date_even_for_an_old_task() -> None:
    record = _record()
    old = datetime(2025, 1, 1, tzinfo=timezone.utc)
    record.created_at = old
    record.classification.created_at = old
    report = build_skill_analytics([record], days=7, now=NOW)
    row = next(item for item in report["skills"] if item["name"] == "repo-analyzer")
    assert row["recommended_tasks"] == 0
    assert row["executions"] == 1


def test_monitor_ui_exposes_statistics_and_skills_tab() -> None:
    html = (Path(__file__).parents[1] / "dashboard" / "static" / "index.html").read_text(encoding="utf-8")
    js = _frontend_js()
    assert 'data-view="monitor">Estadísticas<' in html
    assert 'data-subview="skills"' in html
    assert 'id="subview-skills"' in html
    assert 'api(`/analytics/skills?days=${state.skillAnalyticsDays}`)' in js


def test_skills_tab_falls_back_when_running_backend_predates_endpoint() -> None:
    js = _frontend_js()
    assert "function buildSkillsAnalyticsFallback(records, catalogSkills, days)" in js
    assert "async function loadSkillsAnalyticsReport()" in js
    assert "if (error.status !== 404) throw error;" in js
    assert 'api("/tasks?limit=500")' in js
    assert 'api("/skills")' in js
    assert "compatibility_mode: true" in js
    assert "const report = await loadSkillsAnalyticsReport();" in js
    # `error.status` lo pone `ApiClient.request` (src/core/api-client.js), del
    # que `api()` es un wrapper desde la extracción a módulos del frontend
    # (nota "Plan de mejora", §3/§19) — antes vivía inline en app.js.
    api_client_js = (Path(__file__).parents[1] / "dashboard" / "static" / "src" / "core" / "api-client.js").read_text(
        encoding="utf-8"
    )
    assert "error.status = res.status" in api_client_js


def test_skill_inventory_can_switch_to_per_skill_timeline() -> None:
    js = _frontend_js()
    assert 'data-skills-inventory-view="table"' in js
    assert 'data-skills-inventory-view="timeline"' in js
    assert 'localStorage.setItem("karajan-skill-inventory-view"' in js
    assert "y: Number(point.skills?.[row.name]) || 0" in js
    assert 'yLabel: "Usos verificados por skill"' in js
    assert "legendAlways: true" in js


def test_skill_analytics_endpoint_is_readable_without_mutating_state(karajan_install) -> None:
    response = karajan_install.client.get("/analytics/skills?days=30")
    assert response.status_code == 200
    payload = response.json()
    assert payload["period_days"] == 30
    assert payload["summary"]["executions"] == 0
    assert payload["skills"]
