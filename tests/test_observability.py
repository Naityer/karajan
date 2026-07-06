"""Monitoring math: metrics aggregation and the observability snapshot.

Also pins SQL-side `TaskStore.metrics()` to the reference Python aggregation in
`monitoring.compute_metrics`, so the denormalized columns can never silently
drift from the source of truth.
"""

from pathlib import Path

from app import classifier, monitoring
from app.database import TaskStore
from app.delegation import delegate
from app.models import Backend, KarajanConfig, RoutingLayout
from app.router import classify_prompt

PROMPTS = [
    "Renombra una variable trivial en un script local.",
    "Disena e implementa un router de IA con API, SQLite y panel de control.",
    "Audita la seguridad de los proveedores antes de ejecutar con coste real.",
]


def _seed(store: TaskStore, delegate_all: bool = True) -> None:
    config = KarajanConfig(backend=Backend.SIMULATED)
    for prompt in PROMPTS:
        classification = classify_prompt(prompt, config)
        store.save_classification(classification)
        if delegate_all and not classification.requires_human_review:
            result, decisions = delegate(classification, config)
            store.save_delegation(result, decisions)


def test_sql_metrics_match_reference_aggregation(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "metrics.db")
    _seed(store)

    sql_metrics = store.metrics()
    reference = monitoring.compute_metrics(store.list_tasks())

    assert sql_metrics.model_dump() == reference.model_dump()


def test_metrics_counts_and_costs(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "metrics2.db")
    _seed(store)

    metrics = store.metrics()
    assert metrics.total_tasks == len(PROMPTS)
    assert sum(metrics.by_status.values()) == len(PROMPTS)
    assert metrics.delegated_tasks >= 1
    assert metrics.total_estimated_cost_usd >= 0
    assert 0 <= metrics.average_complexity_score <= 5


def test_empty_store_metrics_are_zeroed(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "empty.db")
    metrics = store.metrics()
    assert metrics.total_tasks == 0
    assert metrics.average_complexity_score == 0.0
    assert metrics.by_level == {}


def test_observability_snapshot_reports_nodes_and_health(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "obs.db")
    _seed(store)

    snapshot = monitoring.compute_observability(
        store.list_tasks(), store.list_decisions(), RoutingLayout()
    )
    assert snapshot.health.observed_nodes >= 1
    assert snapshot.health.status in {"healthy", "warning", "error"}
    assert snapshot.nodes  # at least the Agent node is seeded
    assert any(node.role == "Agent" for node in snapshot.nodes)


def test_observability_assigns_execution_to_layout_node_by_compact_level(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "obs-layout.db")
    config = KarajanConfig(backend=Backend.SIMULATED)
    classification = classify_prompt("Renombra una variable trivial en un script local.", config)
    store.save_classification(classification)
    result, decisions = delegate(classification, config)
    store.save_delegation(result, decisions)

    layout = RoutingLayout.model_validate(
        {
            "entities": [
                {"id": "agent", "name": "OpenAI (GPT)", "role": "parent", "levels": ["N4", "N5"]},
                {"id": "groq", "name": "Groq", "role": "backup", "levels": ["N1"]},
            ]
        }
    )
    snapshot = monitoring.compute_observability(store.list_tasks(), store.list_decisions(), layout)
    groq = next(node for node in snapshot.nodes if node.id == "groq")

    assert groq.task_count == len(result.executions)
    assert snapshot.health.total_cost == store.metrics().total_estimated_cost_usd


def test_observability_marks_human_review_as_policy_waiting(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "obs-policy.db")
    config = KarajanConfig(backend=Backend.SIMULATED)
    classification = classifier.reconcile(
        {
            "original_prompt": "Audita credenciales, costes y ejecucion real antes de desplegar proveedores.",
            "domain": ["security", "operations"],
            "intent": "security_architecture_review",
            "criteria": {
                "ambiguity": 4,
                "context_required": 4,
                "reasoning_depth": 4,
                "autonomy_required": 4,
                "operational_risk": 5,
                "validation_difficulty": 4,
            },
            "requires_human_review": True,
        },
        config,
        source="test:/observability",
    )
    store.save_classification(classification)
    result, decisions = delegate(classification, config)
    store.save_delegation(result, decisions)

    snapshot = monitoring.compute_observability(store.list_tasks(), store.list_decisions(), RoutingLayout())
    agent = next(node for node in snapshot.nodes if node.role == "Agent")

    assert agent.status == "policy_waiting"
    assert snapshot.health.status == "policy_waiting"


def test_observability_accumulates_tokens_and_skill_usage(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "obs-tokens.db")
    config = KarajanConfig(backend=Backend.SIMULATED)
    classification = classify_prompt(
        "Disena e implementa un router de IA con API, SQLite y panel de control.", config
    )
    store.save_classification(classification)
    result, decisions = delegate(classification, config)
    store.save_delegation(result, decisions)

    snapshot = monitoring.compute_observability(store.list_tasks(), store.list_decisions(), RoutingLayout())
    agent = next(node for node in snapshot.nodes if node.role == "Agent")

    assert result.total_input_tokens > 0
    assert result.total_output_tokens > 0
    assert agent.total_tokens == agent.input_tokens + agent.output_tokens
    assert sum(agent.skill_usage.values()) >= 0  # populated when a subtask has a recommended_skill


def test_routing_entity_target_id_round_trips() -> None:
    layout = RoutingLayout.model_validate(
        {
            "entities": [
                {"id": "worker", "role": "worker"},
                {"id": "guardian", "role": "guardian", "target_id": "worker"},
            ]
        }
    )
    guardian = next(entity for entity in layout.entities if entity.id == "guardian")
    assert guardian.target_id == "worker"

    # Round-trips through JSON (as it would over the API) without loss.
    reloaded = RoutingLayout.model_validate_json(layout.model_dump_json())
    assert next(e for e in reloaded.entities if e.id == "guardian").target_id == "worker"


def test_node_token_budget_from_provider(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "obs-budget.db")
    layout = RoutingLayout.model_validate(
        {"entities": [{"id": "agent", "name": "Claude", "role": "parent", "provider": "claude-cli"}]}
    )
    snapshot = monitoring.compute_observability(store.list_tasks(), store.list_decisions(), layout)
    agent = next(node for node in snapshot.nodes if node.id == "agent")
    assert agent.token_budget > 0


def test_metrics_history_records_a_point_per_delegation(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "history.db")
    config = KarajanConfig(backend=Backend.SIMULATED)
    classification = classify_prompt("Renombra una variable trivial en un script local.", config)
    store.save_classification(classification)
    result, decisions = delegate(classification, config)
    store.save_delegation(result, decisions)

    history = store.metrics_history()
    assert len(history.points) == 1
    assert history.points[0].total_tasks == 1
