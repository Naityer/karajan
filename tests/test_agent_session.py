"""The agent loop, driven by scripted model turns — no Ollama, no network.

The compatibility guarantee is the point of most of these: however the session
ends, it must produce a usable `ProviderRun`, so a tool loop that fails is never
worse than the single blind completion it replaced.
"""

from pathlib import Path

import pytest

from app.agent_tools.budget import RunBudget
from app.agent_tools.session import AgentSession
from app.agent_tools.trace import Trace
from app.agent_tools.transport import Message, TransportTurn
from app.agent_tools.workspace import Workspace
from app.database import TaskStore


class ScriptedTransport:
    """Replays a fixed list of model turns and records what it was sent."""

    supports_native_tools = False

    def __init__(self, *turns: str, error: str | None = None) -> None:
        self.turns = list(turns)
        self.error = error
        self.seen: list[list[Message]] = []

    def chat(self, messages, tools, timeout_s):
        self.seen.append(list(messages))
        if self.error:
            return TransportTurn(error=self.error, latency_ms=1)
        text = self.turns.pop(0) if self.turns else "no se que hacer"
        return TransportTurn(text=text, latency_ms=5, input_tokens=10, output_tokens=5)


@pytest.fixture
def ws(tmp_path: Path) -> Workspace:
    (tmp_path / "app.py").write_text("def foo():\n    pass\n", encoding="utf-8")
    return Workspace.open(tmp_path)


def session(transport, ws: Workspace, *, profile="edit", budget=None, trace=None) -> AgentSession:
    return AgentSession(
        transport, ws, profile=profile, budget=budget or RunBudget(),
        trace=trace, model_used="stub:m",
    )


def tool(name: str, **params: str) -> str:
    body = "".join(f'<param name="{k}">{v}</param>' for k, v in params.items())
    return f'<karajan:tool name="{name}">{body}</karajan:tool>'


def test_read_then_edit_then_finish(ws: Workspace) -> None:
    transport = ScriptedTransport(
        tool("read_file", path="app.py"),
        tool("edit_file", path="app.py", old_text="    pass", new_text="    return 1"),
        tool("finish", summary="he cambiado foo"),
    )
    outcome = session(transport, ws).run("arregla foo", "editar foo", "foo devuelve 1")

    assert outcome.status == "completed"
    assert outcome.turns == 3 and outcome.tool_calls == 3
    assert "return 1" in (ws.root / "app.py").read_text(encoding="utf-8")
    assert outcome.output.endswith("he cambiado foo")
    assert outcome.artifacts and outcome.artifacts[0][0] == "app.py"
    assert outcome.as_provider_run().error is None


def test_a_failed_tool_is_an_observation_the_model_can_recover_from(ws: Workspace) -> None:
    transport = ScriptedTransport(
        tool("read_file", path="no-existe.py"),
        tool("read_file", path="app.py"),
        tool("finish", summary="listo"),
    )
    outcome = session(transport, ws).run("p", "s", "v")

    assert outcome.status == "completed"
    # The failure was fed back as text, not raised.
    third_turn = transport.seen[2]
    assert any("ERROR" in message.content for message in third_turn)


def test_three_parse_failures_degrade_to_the_models_own_text(ws: Workspace) -> None:
    """The compatibility guarantee: worst case is today's blind completion."""
    transport = ScriptedTransport("bla", "bla bla", "mi respuesta final en prosa")
    outcome = session(transport, ws).run("p", "s", "v")

    assert outcome.status == "protocol_failure"
    assert "mi respuesta final en prosa" in outcome.output
    assert outcome.as_provider_run().error is None  # not an error: it is an answer


def test_a_corrective_observation_is_sent_after_a_parse_failure(ws: Workspace) -> None:
    transport = ScriptedTransport("prosa", tool("finish", summary="ya"))
    session(transport, ws).run("p", "s", "v")

    second_turn = transport.seen[1]
    assert any("ERROR DE FORMATO" in message.content for message in second_turn)


def test_parse_strikes_reset_after_a_good_turn(ws: Workspace) -> None:
    transport = ScriptedTransport(
        "prosa", "mas prosa", tool("note", text="ya lo pillo"), "prosa otra vez",
        tool("finish", summary="hecho"),
    )
    outcome = session(transport, ws).run("p", "s", "v")
    assert outcome.status == "completed"


def test_budget_exhaustion_is_a_clean_terminal_state(ws: Workspace) -> None:
    transport = ScriptedTransport(*[tool("note", text=f"paso {i}") for i in range(10)])
    outcome = session(transport, ws, budget=RunBudget(max_turns=3)).run("p", "s", "v")

    assert outcome.status == "budget_exhausted"
    assert outcome.turns == 3
    assert "limite de turnos" in outcome.output
    assert outcome.as_provider_run().error is None


def test_a_transport_error_surfaces_so_the_fallback_chain_can_retry(ws: Workspace) -> None:
    outcome = session(ScriptedTransport(error="timeout after 120s"), ws).run("p", "s", "v")
    assert outcome.status == "transport_error"
    assert outcome.as_provider_run().error == "timeout after 120s"


def test_the_profile_is_enforced_inside_the_loop(ws: Workspace) -> None:
    """A readonly session cannot be talked into writing."""
    transport = ScriptedTransport(
        tool("write_file", path="nuevo.txt", content="x"),
        tool("finish", summary="no he podido"),
    )
    outcome = session(transport, ws, profile="readonly").run("p", "s", "v")
    assert not (ws.root / "nuevo.txt").exists()
    assert outcome.status == "completed"


def test_ask_human_suspends_the_session(ws: Workspace) -> None:
    transport = ScriptedTransport(tool("ask_human", question="cual de las dos migraciones?"))
    outcome = session(transport, ws).run("p", "s", "v")

    assert outcome.status == "awaiting_approval"
    assert outcome.pending_question == "cual de las dos migraciones?"


def test_finish_with_failed_status_propagates_an_error(ws: Workspace) -> None:
    transport = ScriptedTransport(tool("finish", summary="no se puede hacer", status="failed"))
    outcome = session(transport, ws).run("p", "s", "v")

    assert outcome.status == "failed"
    assert outcome.as_provider_run().error == "no se puede hacer"


def test_propose_context_returns_the_selection(ws: Workspace) -> None:
    transport = ScriptedTransport(tool("propose_context", paths="app.py", rationale="es el unico"))
    outcome = session(transport, ws, profile="doc").run("documenta", "seleccionar", "v")

    assert outcome.status == "completed"
    assert outcome.context_paths == ["app.py"]


def test_dry_run_reaches_the_model_and_writes_nothing(tmp_path: Path) -> None:
    (tmp_path / "app.py").write_text("old\n", encoding="utf-8")
    ws = Workspace.open(tmp_path, dry_run=True)
    transport = ScriptedTransport(
        tool("edit_file", path="app.py", old_text="old", new_text="new"),
        tool("finish", summary="propuesto"),
    )
    outcome = session(transport, ws).run("p", "s", "v")

    assert outcome.status == "completed"
    assert (tmp_path / "app.py").read_text(encoding="utf-8") == "old\n"
    assert "MODO SIMULACION" in transport.seen[0][0].content


def test_the_budget_is_visible_to_the_model_every_turn(ws: Workspace) -> None:
    transport = ScriptedTransport(tool("note", text="a"), tool("finish", summary="b"))
    session(transport, ws, budget=RunBudget(max_turns=5)).run("p", "s", "v")

    follow_up = transport.seen[1][-1].content
    assert "turnos restantes:" in follow_up


def test_an_empty_profile_fails_fast(ws: Workspace) -> None:
    outcome = session(ScriptedTransport(), ws, profile="no-such-profile").run("p", "s", "v")
    assert outcome.status == "failed"
    assert "no concede ninguna herramienta" in (outcome.error or "")


def test_the_session_writes_a_full_trace(ws: Workspace, tmp_path: Path) -> None:
    """This is what turns "the agent said something" into "the agent did something"."""
    store = TaskStore(tmp_path / "trace.db")
    run_id = store.open_run("tsk_1", "stub", None, None, "m", "cli")
    transport = ScriptedTransport(
        tool("read_file", path="app.py"),
        tool("write_file", path="nuevo.md", content="hola"),
        tool("finish", summary="hecho"),
    )
    session(transport, ws, trace=Trace(store, "tsk_1", run_id)).run("p", "s", "v")

    kinds = [event["event_type"] for event in store.list_run_events(run_id)]
    assert kinds[0] == "agent_started"
    assert kinds[-1] == "agent_finished"
    assert kinds.count("tool_call") == 3
    assert kinds.count("tool_result") == 3
    assert kinds.count("model_turn") == 3

    artifacts = store.list_artifacts("tsk_1")
    assert [a["file_path"] for a in artifacts] == ["nuevo.md"]
    assert artifacts[0]["kind"] == "file_created"
    assert len(artifacts[0]["content_hash"]) == 64


def test_the_trace_redacts_credential_shaped_params(ws: Workspace, tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "trace.db")
    run_id = store.open_run("tsk_1", "stub", None, None, "m", "cli")
    trace = Trace(store, "tsk_1", run_id)
    trace.tool_call(1, "write_file", {"path": "a", "api_key": "sk-supersecreto"}, "write")

    payload = store.list_run_events(run_id)[0]["payload"]
    assert payload["params"]["api_key"] == "[redactado]"
    assert payload["params"]["path"] == "a"


def test_tracing_without_a_store_is_a_no_op(ws: Workspace) -> None:
    transport = ScriptedTransport(tool("finish", summary="ok"))
    outcome = session(transport, ws, trace=Trace(None, "tsk", None)).run("p", "s", "v")
    assert outcome.status == "completed"
