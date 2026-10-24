"""Budgets: exhaustion is a clean terminal state, never an exception."""

from app.agent_tools.budget import RunBudget


def test_a_fresh_budget_is_not_exhausted() -> None:
    assert RunBudget().exhausted() is None


def test_turns_exhaust_the_session() -> None:
    budget = RunBudget(max_turns=2)
    budget.record_turn()
    assert budget.exhausted() is None
    budget.record_turn()
    assert "turnos" in (budget.exhausted() or "")


def test_tool_calls_exhaust_the_session() -> None:
    budget = RunBudget(max_tool_calls=1)
    budget.record_call("read_file")
    assert "llamadas a herramientas" in (budget.exhausted() or "")


def test_wall_time_exhausts_the_session() -> None:
    budget = RunBudget(max_wall_time_s=0)
    assert "tiempo" in (budget.exhausted() or "")


def test_cost_exhausts_the_session_only_when_a_cap_is_set() -> None:
    uncapped = RunBudget(max_cost_usd=0.0)
    uncapped.record_cost(999.0)
    assert uncapped.exhausted() is None

    capped = RunBudget(max_cost_usd=0.01)
    capped.record_cost(0.02)
    assert "coste" in (capped.exhausted() or "")


def test_refusal_stops_one_call_not_the_session() -> None:
    """The model gets an observation and can pick something cheaper."""
    budget = RunBudget(max_commands=1)
    budget.record_call("run_command")
    assert budget.refuses("run_command") is not None
    assert budget.refuses("read_file") is None
    assert budget.exhausted() is None


def test_write_budget_counts_files_and_bytes() -> None:
    budget = RunBudget(max_files_written=1, max_bytes_written=100)
    budget.record_call("write_file", bytes_written=50)
    assert "archivos escritos" in (budget.refuses("write_file") or "")

    fresh = RunBudget(max_bytes_written=100)
    fresh.record_call("write_file", bytes_written=80)
    assert "bytes escritos" in (fresh.refuses("write_file", bytes_out=50) or "")
    assert fresh.refuses("write_file", bytes_out=10) is None


def test_read_budget_refuses_further_calls() -> None:
    budget = RunBudget(max_bytes_read=100)
    budget.record_call("read_file", bytes_read=150)
    assert "bytes leidos" in (budget.refuses("read_file") or "")


def test_remaining_summary_is_what_the_prompt_shows_the_model() -> None:
    budget = RunBudget(max_turns=12, max_tool_calls=24)
    budget.record_turn()
    budget.record_call("read_file")
    summary = budget.remaining_summary()
    assert "turnos restantes: 11" in summary
    assert "llamadas restantes: 23" in summary


def test_remaining_summary_never_goes_negative() -> None:
    budget = RunBudget(max_turns=1)
    budget.record_turn()
    budget.record_turn()
    assert "turnos restantes: 0" in budget.remaining_summary()


def test_snapshot_is_serializable_for_the_trace() -> None:
    import json

    budget = RunBudget()
    budget.record_turn()
    budget.record_call("write_file", bytes_written=10)
    snapshot = budget.snapshot()
    assert json.loads(json.dumps(snapshot))["files_written"] == 1
