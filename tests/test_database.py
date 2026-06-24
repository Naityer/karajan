from app.database import TaskStore
from app.delegation import delegate
from app.router import classify_prompt


def test_persists_classification_and_delegation(tmp_path) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    classification = classify_prompt("Corrige un bug en una API y valida con tests.")

    saved = store.save_classification(classification)
    assert saved.task_id == classification.task_id
    assert saved.delegation is None

    result, decisions = delegate(classification)
    updated = store.save_delegation(result, decisions)

    assert updated.delegation is not None
    assert updated.delegation.total_latency_ms > 0
    assert store.metrics().total_tasks == 1
    assert store.list_decisions(classification.task_id)
