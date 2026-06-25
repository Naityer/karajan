"""WAL mode and the Prometheus metrics export."""

from pathlib import Path

from fastapi.testclient import TestClient

from app import main
from app import metrics_export
from app.database import TaskStore
from app.delegation import delegate
from app.models import Backend, KarajanConfig
from app.router import classify_prompt


def _seeded_store(tmp_path: Path) -> TaskStore:
    store = TaskStore(tmp_path / "export.db")
    config = KarajanConfig(backend=Backend.SIMULATED)
    classification = classify_prompt("Corrige un bug en una API y valida con tests.", config)
    store.save_classification(classification)
    result, decisions = delegate(classification, config)
    store.save_delegation(result, decisions)
    return store


# --- P2: WAL mode -------------------------------------------------------------


def test_store_uses_wal_journal_mode(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "wal.db")
    with store._connect() as conn:
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode.lower() == "wal"


# --- P2: Prometheus export ----------------------------------------------------


def test_render_prometheus_has_help_type_and_samples(tmp_path: Path) -> None:
    metrics = _seeded_store(tmp_path).metrics()
    text = metrics_export.render_prometheus(metrics, db_up=True)

    assert "# TYPE karajan_tasks_total gauge" in text
    assert f"karajan_tasks_total {metrics.total_tasks}" in text
    assert "karajan_db_up 1" in text
    # Labeled family present for the level the seeded task landed in.
    assert any(line.startswith("karajan_tasks_by_level{level=") for line in text.splitlines())
    assert text.endswith("\n")


def test_render_prometheus_marks_db_down() -> None:
    from app.models import Metrics

    empty = Metrics(
        total_tasks=0, by_level={}, by_model={}, by_backend={},
        human_review_required=0, total_estimated_cost_usd=0.0, average_complexity_score=0.0,
    )
    text = metrics_export.render_prometheus(empty, db_up=False)
    assert "karajan_db_up 0" in text
    # Empty families still emit HELP/TYPE headers (valid, zero samples).
    assert "# TYPE karajan_tasks_by_skill gauge" in text


def test_prometheus_endpoint_serves_text_format(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("KARAJAN_TOKEN", raising=False)
    main.store = _seeded_store(tmp_path)
    main.active_config = KarajanConfig(backend=Backend.SIMULATED)
    client = TestClient(main.app)

    res = client.get("/metrics/prometheus")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/plain")
    assert "karajan_tasks_total" in res.text
