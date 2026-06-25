"""Render harness metrics in the Prometheus text exposition format.

Dependency-free on purpose: the format is small and stable, so we emit it
directly instead of pulling in `prometheus_client`. A Prometheus/OTel scraper can
hit `GET /metrics/prometheus` to collect KARAJAN KPIs alongside the rest of the
fleet.
"""

from __future__ import annotations

from app.models import Metrics

_PREFIX = "karajan"
CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"


def _escape_label(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _sample(name: str, value: object, labels: dict[str, str] | None = None) -> str:
    if labels:
        rendered = ",".join(f'{key}="{_escape_label(val)}"' for key, val in labels.items())
        return f"{_PREFIX}_{name}{{{rendered}}} {value}"
    return f"{_PREFIX}_{name} {value}"


def render_prometheus(metrics: Metrics, db_up: bool = True) -> str:
    lines: list[str] = []

    def scalar(name: str, help_text: str, value: object) -> None:
        lines.append(f"# HELP {_PREFIX}_{name} {help_text}")
        lines.append(f"# TYPE {_PREFIX}_{name} gauge")
        lines.append(_sample(name, value))

    def family(name: str, help_text: str, mapping: dict[str, int], label: str) -> None:
        lines.append(f"# HELP {_PREFIX}_{name} {help_text}")
        lines.append(f"# TYPE {_PREFIX}_{name} gauge")
        for key, count in sorted(mapping.items()):
            lines.append(_sample(name, count, {label: key}))

    scalar("tasks_total", "Total tasks recorded by the harness.", metrics.total_tasks)
    scalar("subtasks_total", "Total subtasks across all tasks.", metrics.total_subtasks)
    scalar("delegated_tasks", "Tasks that reached delegation.", metrics.delegated_tasks)
    scalar("human_review_required", "Tasks flagged for human review.", metrics.human_review_required)
    scalar("estimated_cost_usd_total", "Sum of estimated delegation cost (USD).", metrics.total_estimated_cost_usd)
    scalar("average_complexity_score", "Mean complexity score across tasks.", metrics.average_complexity_score)
    scalar("db_up", "1 if the task store is reachable, else 0.", int(db_up))

    family("tasks_by_level", "Task count by complexity level.", metrics.by_level, "level")
    family("tasks_by_model", "Task count by recommended model tier.", metrics.by_model, "model")
    family("tasks_by_status", "Task count by status.", metrics.by_status, "status")
    family("executions_by_backend", "Subtask executions by backend.", metrics.by_backend, "backend")
    family("tasks_by_skill", "Skill recommendation frequency.", metrics.by_skill, "skill")

    return "\n".join(lines) + "\n"
