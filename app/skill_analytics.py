from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping

from app.models import TaskRecord, TaskStatus


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _agent_name(run: Mapping[str, Any] | None, model_used: str) -> str:
    if run:
        for key in ("routing_entity_name_snapshot", "provider_name", "model_id"):
            if run.get(key):
                return str(run[key])
    return model_used or "Agente sin identificar"


def build_skill_analytics(
    records: Iterable[TaskRecord],
    *,
    runs_by_task: Mapping[str, list[Mapping[str, Any]]] | None = None,
    known_skills: Iterable[str] = (),
    days: int = 30,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Build deterministic skill telemetry without treating recommendations as usage."""
    now_utc = _utc(now or datetime.now(timezone.utc))
    cutoff = None if days == 0 else now_utc - timedelta(days=days)
    runs_by_task = runs_by_task or {}
    skill_rows: dict[str, dict[str, Any]] = {}
    agent_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    task_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    timeline: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"executions": 0, "successes": 0, "skills": defaultdict(int)}
    )
    recommended_task_ids: set[str] = set()
    executed_task_ids: set[str] = set()
    canonical_names: dict[str, str] = {}

    def row_for(name: str) -> dict[str, Any]:
        candidate = name.strip()
        folded = candidate.casefold()
        key = canonical_names.setdefault(folded, candidate)
        if key not in skill_rows:
            skill_rows[key] = {
                "name": key,
                "recommended_task_ids": set(),
                "executed_task_ids": set(),
                "executions": 0,
                "successes": 0,
                "failures": 0,
                "latency_total_ms": 0,
                "cost_total_usd": 0.0,
                "agents": defaultdict(int),
                "task_types": defaultdict(int),
                "last_used_at": None,
            }
        return skill_rows[key]

    for name in known_skills:
        if str(name).strip():
            row_for(str(name))

    for record in records:
        classification = record.classification
        task_type = classification.intent or "sin tipo"
        recommendation_in_period = cutoff is None or _utc(classification.created_at) >= cutoff
        if recommendation_in_period:
            recommendations = set(classification.recommended_skills)
            recommendations.update(s.recommended_skill for s in classification.subtasks if s.recommended_skill)
            for skill in recommendations:
                row_for(skill)["recommended_task_ids"].add(record.task_id)
                recommended_task_ids.add(record.task_id)

        if not record.delegation:
            continue
        occurred = _utc(record.delegation.completed_at)
        if cutoff is not None and occurred < cutoff:
            continue
        runs = list(runs_by_task.get(record.task_id, ()))
        subtasks = {subtask.id: subtask for subtask in classification.subtasks}
        for index, execution in enumerate(record.delegation.executions):
            subtask = subtasks.get(execution.subtask_id)
            skill = subtask.recommended_skill if subtask else None
            if not skill:
                continue
            row = row_for(skill)
            run = runs[index] if index < len(runs) else None
            agent = _agent_name(run, execution.model_used)
            success = execution.status == TaskStatus.COMPLETED
            day = occurred.date().isoformat()
            row["executed_task_ids"].add(record.task_id)
            row["executions"] += 1
            row["successes" if success else "failures"] += 1
            row["latency_total_ms"] += max(0, execution.latency_ms)
            row["cost_total_usd"] += max(0.0, execution.estimated_cost_usd)
            row["agents"][agent] += 1
            row["task_types"][task_type] += 1
            row["last_used_at"] = max(filter(None, (row["last_used_at"], occurred)), default=occurred)
            agent_counts[agent][skill] += 1
            task_counts[task_type][skill] += 1
            timeline[day]["executions"] += 1
            timeline[day]["successes"] += int(success)
            timeline[day]["skills"][row["name"]] += 1
            executed_task_ids.add(record.task_id)

    skills = []
    for row in skill_rows.values():
        executions = row["executions"]
        skills.append({
            "name": row["name"],
            "recommended_tasks": len(row["recommended_task_ids"]),
            "executed_tasks": len(row["executed_task_ids"]),
            "executions": executions,
            "successes": row["successes"],
            "failures": row["failures"],
            "success_rate": round(row["successes"] / executions, 4) if executions else None,
            "avg_latency_ms": round(row["latency_total_ms"] / executions, 1) if executions else None,
            "total_cost_usd": round(row["cost_total_usd"], 6),
            "agents": dict(sorted(row["agents"].items(), key=lambda item: (-item[1], item[0].lower()))),
            "task_types": dict(sorted(row["task_types"].items(), key=lambda item: (-item[1], item[0].lower()))),
            "last_used_at": row["last_used_at"].isoformat() if row["last_used_at"] else None,
        })
    skills.sort(key=lambda row: (-row["executions"], -row["recommended_tasks"], row["name"].lower()))
    total_executions = sum(row["executions"] for row in skills)
    successes = sum(row["successes"] for row in skills)
    catalog_count = len(skill_rows)
    active_count = sum(row["executions"] > 0 for row in skills)

    def dimension_rows(source: Mapping[str, Mapping[str, int]], key: str) -> list[dict[str, Any]]:
        rows = [{key: name, "executions": sum(values.values()), "skills": dict(values)} for name, values in source.items()]
        return sorted(rows, key=lambda row: (-row["executions"], row[key].lower()))

    return {
        "period_days": days,
        "generated_at": now_utc.isoformat(),
        "summary": {
            "catalog_skills": catalog_count,
            "recommended_tasks": len(recommended_task_ids),
            "executed_tasks": len(executed_task_ids),
            "executions": total_executions,
            "active_skills": active_count,
            "unused_skills": max(0, catalog_count - active_count),
            "successes": successes,
            "failures": total_executions - successes,
            "success_rate": round(successes / total_executions, 4) if total_executions else None,
            "assignment_coverage": round(len(executed_task_ids) / len(recommended_task_ids), 4) if recommended_task_ids else None,
        },
        "skills": skills,
        "by_agent": dimension_rows(agent_counts, "agent"),
        "by_task_type": dimension_rows(task_counts, "task_type"),
        "timeline": [
            {
                "date": day,
                "executions": values["executions"],
                "successes": values["successes"],
                "skills": dict(sorted(values["skills"].items(), key=lambda item: item[0].lower())),
            }
            for day, values in sorted(timeline.items())
        ],
        "definitions": {
            "recommended": "Skill sugerida por la clasificación o por una subtarea.",
            "execution": "Subtarea ejecutada que declara explícitamente una skill.",
            "success_rate": "Ejecuciones completadas / ejecuciones de la skill.",
            "assignment_coverage": "Tareas con una skill ejecutada / tareas con skills recomendadas.",
        },
    }
