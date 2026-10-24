"""Integration of the tool loop into `delegation`.

The load-bearing test is the first one: with the flag off, delegation must
behave exactly as it did before this feature existed.
"""

from pathlib import Path

import pytest

from app import delegation, monitoring
from app.agent_tools.policy import plan
from app.database import TaskStore
from app.models import AgentToolsConfig, Backend, KarajanConfig, OrchestrationConfig
from app.providers.base import ModelProvider, ProviderRun
from app.providers.registry import Resolution
from app.router import classify_prompt

PROMPT = "Corrige un bug en una API y valida con tests de integracion."


class _ScriptedProvider(ModelProvider):
    """One-shot provider replaying scripted turns, so the CompletionTransport
    path is exercised end to end without a model."""

    backend = Backend.CLI

    def __init__(self, *turns: str) -> None:
        self.script = list(turns)
        self.calls = 0

    def run(self, instruction: str, model_id: str, timeout_s: int) -> ProviderRun:
        self.calls += 1
        text = self.script[min(self.calls - 1, len(self.script) - 1)] if self.script else "prosa"
        return ProviderRun(output=text, model_used=f"scripted:{model_id}", latency_ms=4)


def _tool(name: str, **params: str) -> str:
    body = "".join(f'<param name="{k}">{v}</param>' for k, v in params.items())
    return f'<karajan:tool name="{name}">{body}</karajan:tool>'


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    (tmp_path / "app.py").write_text("def foo():\n    pass\n", encoding="utf-8")
    return tmp_path


def _patch(monkeypatch, provider: ModelProvider) -> None:
    monkeypatch.setattr(
        delegation, "resolve",
        lambda tier, config: Resolution(provider, Backend.CLI, tier.value, "scripted"),
    )


def test_flag_off_behaves_exactly_as_before(monkeypatch) -> None:
    provider = _ScriptedProvider("respuesta directa")
    _patch(monkeypatch, provider)
    classification = classify_prompt(PROMPT)

    result, decisions = delegation.delegate(classification, KarajanConfig(backend=Backend.CLI))

    assert result.status.value == "completed"
    # One provider call per subtask: the single blind completion, unchanged.
    assert provider.calls == len(classification.subtasks)
    assert all(ex.output == "respuesta directa" for ex in result.executions)
    assert not any("agent_tools" in decision.decision for decision in decisions)


def test_flag_on_without_a_workspace_stays_on_the_one_shot_path(monkeypatch) -> None:
    """No root ⇒ no tools. Never a fallback to the server's cwd."""
    monkeypatch.setattr("app.agent_tools.policy.resolve_workspace_root", lambda settings, requested=None: None)
    provider = _ScriptedProvider("respuesta directa")
    _patch(monkeypatch, provider)
    config = KarajanConfig(backend=Backend.CLI, agent_tools=AgentToolsConfig(enabled=True))

    result, decisions = delegation.delegate(classify_prompt(PROMPT), config)

    assert result.status.value == "completed"
    reasons = [d.reason for d in decisions if "agent_tools=off" in d.decision]
    assert reasons and "sin raiz de trabajo" in reasons[0]


def test_flag_on_runs_the_loop_and_keeps_the_execution_shape(monkeypatch, repo: Path) -> None:
    provider = _ScriptedProvider(
        _tool("read_file", path="app.py"),
        _tool("finish", summary="revisado"),
    )
    _patch(monkeypatch, provider)
    config = KarajanConfig(
        backend=Backend.CLI,
        orchestration=OrchestrationConfig(parallel=False),
        agent_tools=AgentToolsConfig(
            enabled=True, profile="readonly", default_workspace_root=str(repo), dry_run=False
        ),
    )
    classification = classify_prompt(PROMPT)

    result, decisions = delegation.delegate(classification, config)

    assert result.status.value == "completed"
    # Same shape downstream: one SubtaskExecution per subtask, costed as always.
    assert len(result.executions) == len(classification.subtasks)
    assert all(ex.backend == Backend.CLI for ex in result.executions)
    assert result.total_estimated_cost_usd > 0
    assert any("agent_tools=on" in d.decision for d in decisions)
    assert any("profile=readonly" in d.decision for d in decisions)
    # Multi-turn: more provider calls than subtasks.
    assert provider.calls > len(classification.subtasks)


def test_the_loop_writes_a_trace_against_the_runs_row(monkeypatch, repo: Path, tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "trace.db")
    provider = _ScriptedProvider(
        _tool("write_file", path="notas.md", content="hola"),
        _tool("finish", summary="escrito"),
    )
    _patch(monkeypatch, provider)
    config = KarajanConfig(
        backend=Backend.CLI,
        orchestration=OrchestrationConfig(parallel=False),
        agent_tools=AgentToolsConfig(
            enabled=True, profile="edit", default_workspace_root=str(repo), dry_run=False
        ),
    )
    classification = classify_prompt(PROMPT)
    store.save_classification(classification, monitoring.build_classify_decision(classification))

    delegation.delegate(classification, config, store=store)

    runs = store.list_runs(classification.task_id)
    assert runs, "the agentic path must still record a runs row"
    assert all(run["status"] in ("completed", "failed") for run in runs), "open_run must be closed"
    assert all(run["started_at"] and run["completed_at"] for run in runs)

    events = store.list_run_events(runs[0]["id"])
    assert [e["event_type"] for e in events][:1] == ["agent_started"]
    assert any(e["event_type"] == "tool_call" for e in events)
    assert store.list_artifacts(classification.task_id)
    assert (repo / "notas.md").read_text(encoding="utf-8") == "hola"


def test_dry_run_records_planned_artifacts_without_writing(monkeypatch, repo: Path, tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "dry.db")
    provider = _ScriptedProvider(
        _tool("write_file", path="planificado.md", content="hola"),
        _tool("finish", summary="propuesto"),
    )
    _patch(monkeypatch, provider)
    config = KarajanConfig(
        backend=Backend.CLI,
        orchestration=OrchestrationConfig(parallel=False),
        agent_tools=AgentToolsConfig(
            enabled=True, profile="edit", default_workspace_root=str(repo), dry_run=True
        ),
    )
    classification = classify_prompt(PROMPT)
    store.save_classification(classification, monitoring.build_classify_decision(classification))

    delegation.delegate(classification, config, store=store)

    assert not (repo / "planificado.md").exists()
    artifacts = store.list_artifacts(classification.task_id)
    assert artifacts and all(item["kind"] == "file_planned" for item in artifacts)


def test_a_session_error_still_feeds_the_fallback_chain(monkeypatch, repo: Path) -> None:
    """Degradation path: a failed agent run retries the one-shot form elsewhere."""

    class _Failing(ModelProvider):
        backend = Backend.CLI

        def run(self, instruction, model_id, timeout_s):
            return ProviderRun(output="", model_used=f"failing:{model_id}", latency_ms=1, error="boom")

    _patch(monkeypatch, _Failing())
    backup = _ScriptedProvider("respuesta del backup")
    monkeypatch.setattr(
        delegation, "fallback_resolutions",
        lambda tier, config, tried, layout=None: [Resolution(backup, Backend.CLI, tier.value, "backup")],
    )
    config = KarajanConfig(
        backend=Backend.CLI,
        orchestration=OrchestrationConfig(parallel=False, max_retries=0),
        agent_tools=AgentToolsConfig(enabled=True, default_workspace_root=str(repo)),
    )

    result, decisions = delegation.delegate(classify_prompt(PROMPT), config)

    assert result.status.value == "completed"
    assert all(ex.output == "respuesta del backup" for ex in result.executions)
    assert any(d.phase == "fallback" for d in decisions)


def test_a_per_request_profile_overrides_the_config(repo: Path) -> None:
    config = KarajanConfig(agent_tools=AgentToolsConfig(enabled=False, default_workspace_root=str(repo)))
    assert plan(config).enabled is False
    assert plan(config, requested_profile="doc").enabled is True
    assert plan(config, requested_profile="doc").profile == "doc"


def test_doc_selection_survives_in_the_public_execution_shape(monkeypatch, repo: Path) -> None:
    provider = _ScriptedProvider(
        _tool("propose_context", paths="app.py", rationale="entrada relevante"),
    )
    _patch(monkeypatch, provider)
    config = KarajanConfig(
        backend=Backend.CLI,
        orchestration=OrchestrationConfig(parallel=False),
        agent_tools=AgentToolsConfig(default_workspace_root=str(repo)),
    )

    result, _ = delegation.delegate(
        classify_prompt("Documenta app.py"),
        config,
        workspace_root=str(repo),
        agent_tools_profile="doc",
    )

    assert result.status.value == "completed"
    assert result.executions
    assert all(execution.context_paths == ["app.py"] for execution in result.executions)


def test_off_disables_the_loop_even_when_enabled(repo: Path) -> None:
    config = KarajanConfig(
        agent_tools=AgentToolsConfig(enabled=True, default_workspace_root=str(repo))
    )
    assert plan(config).enabled is True
    assert plan(config, requested_profile="off").enabled is False


def test_an_unknown_profile_is_refused_not_silently_defaulted(repo: Path) -> None:
    config = KarajanConfig(
        agent_tools=AgentToolsConfig(enabled=True, default_workspace_root=str(repo))
    )
    decision = plan(config, requested_profile="superuser")
    assert decision.enabled is False and "desconocido" in decision.reason
