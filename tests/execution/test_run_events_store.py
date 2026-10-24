"""Run lifecycle (`open_run`/`close_run`) and the execution-trace tables.

`run_events` and `artifacts` shipped as empty Fase-1 groundwork; these are the
first tests that actually write to them.
"""

from pathlib import Path

from app.database import TaskStore


def test_open_run_then_close_run_updates_the_same_row(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "trace.db")

    run_id = store.open_run(
        task_id="tsk_1",
        provider_name="ollama-qwen",
        routing_entity_id="entity-worker",
        routing_entity_name_snapshot="Worker",
        model_id="qwen2.5:7b",
        backend="cli",
    )

    opened = store.list_runs("tsk_1")
    assert len(opened) == 1
    assert opened[0]["status"] == "running"
    assert opened[0]["started_at"] is not None
    assert opened[0]["completed_at"] is None

    store.close_run(run_id, status="completed", latency_ms=1234, estimated_cost_usd=0.0)

    closed = store.list_runs("tsk_1")
    assert len(closed) == 1, "close_run must update, never insert a second row"
    assert closed[0]["status"] == "completed"
    assert closed[0]["latency_ms"] == 1234
    assert closed[0]["completed_at"] is not None


def test_open_run_indexes_are_monotonic_per_task(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "trace.db")
    for _ in range(3):
        store.open_run("tsk_1", "ollama-qwen", None, None, "qwen2.5:7b", "cli")
    store.open_run("tsk_2", "ollama-qwen", None, None, "qwen2.5:7b", "cli")

    assert [r["run_index"] for r in store.list_runs("tsk_1")] == [0, 1, 2]
    assert [r["run_index"] for r in store.list_runs("tsk_2")] == [0]


def test_close_run_on_unknown_id_is_a_no_op(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "trace.db")
    store.close_run("run_does_not_exist", status="failed")  # must not raise
    assert store.list_runs("tsk_1") == []


def test_run_events_round_trip_with_decoded_payload(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "trace.db")
    run_id = store.open_run("tsk_1", "ollama-qwen", None, None, "qwen2.5:7b", "cli")

    store.record_run_event(run_id, "agent_started", {"profile": "readonly", "turns": 12})
    store.record_run_event(run_id, "tool_call", {"tool": "read_file", "params": {"path": "app/main.py"}})
    store.record_run_event(run_id, "agent_finished", None)

    events = store.list_run_events(run_id)
    assert [e["event_type"] for e in events] == ["agent_started", "tool_call", "agent_finished"]
    assert events[0]["payload"] == {"profile": "readonly", "turns": 12}
    assert events[1]["payload"]["params"]["path"] == "app/main.py"
    assert events[2]["payload"] is None
    assert "payload_json" not in events[0], "the raw column must not leak to callers"


def test_run_events_are_scoped_to_their_run_and_paginate(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "trace.db")
    run_a = store.open_run("tsk_1", "ollama-qwen", None, None, "m", "cli")
    run_b = store.open_run("tsk_1", "ollama-qwen", None, None, "m", "cli")

    for index in range(5):
        store.record_run_event(run_a, "tool_call", {"i": index})
    store.record_run_event(run_b, "tool_call", {"i": 99})

    assert len(store.list_run_events(run_a)) == 5
    assert len(store.list_run_events(run_b)) == 1
    assert len(store.list_run_events(run_a, limit=2)) == 2
    assert len(store.list_run_events(run_a, limit=2, offset=4)) == 1
    assert store.list_run_events("run_unknown") == []


def test_record_run_event_survives_an_unserializable_payload(tmp_path: Path) -> None:
    """Tracing must never be able to break the run it is tracing."""
    store = TaskStore(tmp_path / "trace.db")
    run_id = store.open_run("tsk_1", "ollama-qwen", None, None, "m", "cli")

    store.record_run_event(run_id, "tool_result", {"handle": object()})

    events = store.list_run_events(run_id)
    assert len(events) == 1
    assert "unserializable" in events[0]["payload"]


def test_artifacts_round_trip(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "trace.db")
    run_id = store.open_run("tsk_1", "ollama-qwen", None, None, "m", "cli")

    store.record_artifact("tsk_1", run_id, "file_created", "src/app.py", 120, "abc123")
    store.record_artifact("tsk_1", run_id, "file_planned", "src/other.py", 40, None)
    store.record_artifact("tsk_2", None, "file_created", "elsewhere.py", 10, "def456")

    artifacts = store.list_artifacts("tsk_1")
    assert [a["file_path"] for a in artifacts] == ["src/app.py", "src/other.py"]
    assert artifacts[0]["kind"] == "file_created"
    assert artifacts[0]["content_hash"] == "abc123"
    assert artifacts[0]["run_id"] == run_id
    assert artifacts[1]["content_hash"] is None
    assert len(store.list_artifacts("tsk_2")) == 1
    assert store.list_artifacts("tsk_unknown") == []
