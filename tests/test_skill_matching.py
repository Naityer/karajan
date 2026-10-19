from pathlib import Path

from app.models import ClassificationResult, ComplexityLevel, CriteriaScores, RecommendedModel, Subtask, SubtaskExecution, TaskRecord, TaskStatus, Backend, DelegationResult
from app.resource_activation import attach_installed_skills
from app.skill_analytics import build_skill_analytics
from app.skill_matching import AvailableSkill, discover_skills, prepare_skills, select_skills


def _skill(home: Path, root: str, name: str, description: str) -> None:
    directory = home / root / name
    directory.mkdir(parents=True)
    (directory / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {description}\n---\nBody must never be loaded into a prompt.\n", encoding="utf-8")


def test_inventory_includes_archive_but_skips_disabled_and_reads_only_metadata(tmp_path):
    _skill(tmp_path, ".agents/skills", "pdf", "Edit PDF documents")
    _skill(tmp_path, ".karajan/skills-almacen/codex", "backend-builder", "Build APIs and databases")
    _skill(tmp_path, ".codex/skills", "old.disabled", "disabled")
    found = {skill.name: skill for skill in discover_skills(tmp_path)}
    assert set(found) == {"pdf", "backend-builder"}
    assert found["backend-builder"].stored_in == frozenset({"codex"})
    assert "Body must never" not in found["pdf"].description


def test_selection_supports_every_explicit_installed_name_and_abstains():
    catalog = [AvailableSkill(name, "", frozenset({"agents"}), frozenset()) for name in
               ("pdf", "backend-builder", "source-command-repo-analyzer")]
    for skill in catalog:
        assert skill.name in select_skills(f"Usa {skill.name} en esta tarea", catalog)
    assert select_skills("Hola, responde brevemente", catalog) == []
    assert select_skills("Analiza un repositorio", catalog) == []  # no implicit command wrapper


def test_multi_skill_selection_and_targeted_preparation(tmp_path):
    _skill(tmp_path, ".agents/skills", "pdf", "Edit PDF documents")
    _skill(tmp_path, ".karajan/skills-almacen/codex", "backend-builder", "Build APIs and databases")
    catalog = discover_skills(tmp_path)
    selected = select_skills("Lee el PDF y modifica la API backend", catalog)
    assert selected == ["pdf", "backend-builder"]
    assert prepare_skills(selected, "codex", tmp_path) == selected
    assert (tmp_path / ".codex/skills/pdf/SKILL.md").is_file()
    assert (tmp_path / ".codex/skills/backend-builder/SKILL.md").is_file()
    assert prepare_skills(selected, "ollama-qwen", tmp_path) == []


def test_sequence_starts_with_repository_analysis_and_finishes_with_security():
    catalog = [AvailableSkill(name, "", frozenset({"agents"}), frozenset()) for name in
               ("frontend-builder", "repo-analyzer", "security-review")]
    assert select_skills("Revisa seguridad del repositorio y corrige el frontend", catalog) == [
        "repo-analyzer", "frontend-builder", "security-review",
    ]


def test_classification_and_metrics_do_not_confuse_preparation_with_usage():
    catalog = [AvailableSkill("pdf", "PDF documents", frozenset({"codex"}), frozenset())]
    subtask = Subtask(id="sub_001", name="Resolver", complexity=1, recommended_model=RecommendedModel.CHEAP_MODEL, validation="ok")
    classification = ClassificationResult(original_prompt="Lee el PDF", domain=["documents"], intent="transform_or_extract",
        criteria=CriteriaScores(ambiguity=1, context_required=1, reasoning_depth=1, autonomy_required=1, operational_risk=1, validation_difficulty=1),
        complexity_score=1, complexity_level=ComplexityLevel.LEVEL_1_SIMPLE, recommended_strategy="single_model_execution",
        recommended_model=RecommendedModel.CHEAP_MODEL, subtasks=[subtask], requires_human_review=False, reason="ok", validation_plan="ok")
    classification = attach_installed_skills(classification, catalog)
    assert classification.subtasks[0].recommended_skills == ["pdf"]
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    execution = SubtaskExecution(subtask_id="sub_001", status=TaskStatus.COMPLETED, backend=Backend.CLI, model_used="codex",
        latency_ms=1, estimated_cost_usd=0, output="ok", prepared_skills=["pdf"])
    record = TaskRecord(task_id=classification.task_id, prompt=classification.original_prompt, status=TaskStatus.COMPLETED,
        classification=classification, delegation=DelegationResult(task_id=classification.task_id, status=TaskStatus.COMPLETED,
        executions=[execution], total_latency_ms=1, total_estimated_cost_usd=0, completed_at=now), created_at=now, updated_at=now)
    row = build_skill_analytics([record], days=0)["skills"][0]
    assert (row["recommended_tasks"], row["preparations"], row["executions"]) == (1, 1, 0)
    execution.used_skills = ["pdf"]
    assert build_skill_analytics([record], days=0)["skills"][0]["executions"] == 1
    reviewed = build_skill_analytics([record], reviewed_skills_by_task={record.task_id: ["pdf"]}, days=0)
    assert reviewed["skills"][0]["executions"] == 1  # same evidence is not counted twice
    execution.used_skills = []
    reviewed = build_skill_analytics([record], reviewed_skills_by_task={record.task_id: ["pdf"]}, days=0)
    assert reviewed["skills"][0]["executions"] == 1
    assert reviewed["by_agent"] == []  # a review alone cannot identify the agent


def test_forced_local_model_cannot_silently_skip_a_required_skill():
    from app.delegation import run_subtask
    from app.models import KarajanConfig
    from app.providers.base import ModelProvider
    from app.providers.registry import Resolution

    class LocalProvider(ModelProvider):
        backend = Backend.CLI

        def run(self, instruction: str, model_id: str, timeout_s: int):
            raise AssertionError("The agent must not run without its required skill")

    from app.router import classify_prompt
    classification = classify_prompt("Resume este PDF")
    subtask = classification.subtasks[0].model_copy(update={"recommended_skill": "pdf", "recommended_skills": ["pdf"]})
    execution, decisions = run_subtask(classification, 0, subtask, KarajanConfig(backend=Backend.CLI), None,
        preresolved=Resolution(LocalProvider(), Backend.CLI, "local", "ollama-qwen"))
    assert execution.status == TaskStatus.FAILED
    assert "pdf" in (execution.error or "")
    assert any("skill-unavailable" in decision.decision for decision in decisions)
