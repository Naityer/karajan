"""The agent loop.

    system prompt (rendered from the catalog)
    → model turn
    → parse a tool call (native array, or the text protocol)
    → execute it under the workspace + budget
    → feed the observation back
    → repeat until a terminal tool or a budget runs out

Synchronous on purpose (see `transport.py`).

**Compatibility guarantee.** However the session ends — terminal tool, budget
exhausted, transport error, three parse failures — it produces a `ProviderRun`
with the best text it has. A tool loop that fails is never *worse* than the
single blind completion it replaces; at worst it degrades back to it.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field

from app.agent_tools import catalog, executors, prompt as prompt_builder, protocol
from app.agent_tools.budget import RunBudget
from app.agent_tools.spec import ToolResult
from app.agent_tools.trace import Trace
from app.agent_tools.transport import Message, ToolTransport
from app.agent_tools.workspace import Workspace
from app.providers.base import ProviderRun

MAX_PARSE_STRIKES = 3
PROTOCOL_REMINDER_EVERY = 4
# Turns left at which the model is told, in as many words, to wrap up. Small
# models otherwise keep exploring right into the budget wall.
WRAP_UP_AT = 2


@dataclass
class AgentOutcome:
    status: str  # completed | failed | budget_exhausted | protocol_failure | awaiting_approval | transport_error
    output: str
    model_used: str
    latency_ms: int
    turns: int = 0
    tool_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    usage_source: str = "estimated"
    error: str | None = None
    artifacts: list[tuple[str, str]] = field(default_factory=list)
    pending_question: str | None = None
    context_paths: list[str] = field(default_factory=list)

    def as_provider_run(self) -> ProviderRun:
        """Hand back the exact shape `run_subtask` already handles, so nothing
        downstream — fallback chain, validator, cost, persistence — changes."""
        return ProviderRun(
            output=self.output,
            model_used=self.model_used,
            latency_ms=self.latency_ms,
            error=self.error,
        )


class AgentSession:
    def __init__(
        self,
        transport: ToolTransport,
        workspace: Workspace,
        *,
        profile: str = "readonly",
        budget: RunBudget | None = None,
        trace: Trace | None = None,
        model_used: str = "",
        turn_timeout_s: int = 120,
    ) -> None:
        self.transport = transport
        self.workspace = workspace
        self.profile = profile
        self.budget = budget or RunBudget()
        self.trace = trace or Trace(None, "", None)
        self.model_used = model_used
        self.turn_timeout_s = turn_timeout_s
        self.tools = catalog.tools_for_profile(profile)

    def run(self, original_prompt: str, subtask_name: str, validation: str) -> AgentOutcome:
        if not self.tools:
            return AgentOutcome(
                status="failed", output="", model_used=self.model_used, latency_ms=0,
                error=f"el perfil de herramientas '{self.profile}' no concede ninguna herramienta",
            )

        started = time.perf_counter()
        native = getattr(self.transport, "supports_native_tools", False)
        self.trace.started(
            self.profile, str(self.workspace.root), "native" if native else "text", self.budget.snapshot()
        )

        messages = [
            Message("system", prompt_builder.build_system(self.tools, self.workspace, self.budget, native_tools=native)),
            Message("user", prompt_builder.initial_user_message(original_prompt, subtask_name, validation)),
        ]
        transcript: list[str] = []
        artifacts: list[tuple[str, str]] = []
        seen: set[str] = set()
        last_text = ""
        strikes = 0
        totals = {"input": 0, "output": 0}
        usage_source = "estimated"

        while True:
            exhausted = self.budget.exhausted()
            if exhausted:
                self.trace.budget_exhausted(exhausted, self.budget.snapshot())
                return self._finish(
                    "budget_exhausted", transcript, last_text, started, totals, usage_source, artifacts,
                    note=f"Sesion detenida: {exhausted}.",
                )

            self.budget.record_turn()
            turn_index = self.budget.state.turns
            turn = self.transport.chat(messages, self.tools, self.turn_timeout_s)
            totals["input"] += turn.input_tokens
            totals["output"] += turn.output_tokens
            usage_source = turn.usage_source

            if turn.error:
                self.trace.model_turn(
                    turn_index, parsed="transport_error", latency_ms=turn.latency_ms,
                    input_tokens=turn.input_tokens, output_tokens=turn.output_tokens,
                    usage_source=turn.usage_source, raw=turn.error,
                )
                # Surfacing the provider error lets `_run_fallback_chain` retry
                # this subtask on another provider, exactly as before.
                return self._finish(
                    "transport_error", transcript, last_text, started, totals, usage_source, artifacts,
                    error=turn.error,
                )

            last_text = turn.text or last_text
            outcome = self._parse(turn)
            if outcome.call is None:
                strikes += 1
                self.trace.parse_error(turn_index, outcome.error or "", turn.text, strikes)
                self.trace.model_turn(
                    turn_index, parsed="parse_error", latency_ms=turn.latency_ms,
                    input_tokens=turn.input_tokens, output_tokens=turn.output_tokens,
                    usage_source=turn.usage_source, raw=turn.text,
                )
                if strikes >= MAX_PARSE_STRIKES:
                    # The compatibility guarantee: the model's own free text
                    # becomes the subtask output, i.e. today's behavior.
                    return self._finish(
                        "protocol_failure", transcript, last_text, started, totals, usage_source, artifacts,
                        note="El modelo no ha respetado el formato de herramientas; se devuelve su ultima respuesta.",
                    )
                messages.append(Message("assistant", turn.text))
                messages.append(Message("user", protocol.corrective_observation(outcome, self.tools)))
                continue

            strikes = 0
            call = outcome.call
            self.trace.model_turn(
                turn_index, parsed=call.source, latency_ms=turn.latency_ms,
                input_tokens=turn.input_tokens, output_tokens=turn.output_tokens,
                usage_source=turn.usage_source, raw=turn.text,
            )
            spec = catalog.get_tool(call.tool)
            self.trace.tool_call(turn_index, call.tool, call.params, spec.risk.value if spec else "unknown")

            signature = self._signature(call)
            if signature in seen and not executors.is_terminal(call.tool):
                # Small models loop: they re-emit an identical call because
                # nothing told them it already happened. Re-executing wastes a
                # turn and teaches them nothing, so the repeat is refused with
                # an instruction to move on instead.
                result = ToolResult.failure(
                    call.tool, "denied",
                    f"ya has llamado a `{call.tool}` con esos mismos parametros y el resultado fue el mismo. "
                    f"Haz algo distinto, o termina con: {', '.join(self._terminal_names())}.",
                )
            else:
                seen.add(signature)
                result = executors.dispatch(
                    call.tool, call.params, self.workspace, profile=self.profile, budget=self.budget
                )
            self.trace.tool_result(turn_index, result)
            self.trace.artifacts(result, dry_run=self.workspace.dry_run)
            artifacts.extend(result.artifacts)
            transcript.append(prompt_builder.observation_message(result.tool, result.ok, result.observation))

            if result.ok and executors.is_terminal(call.tool):
                return self._terminal(call.tool, result, transcript, started, totals, usage_source, artifacts)

            messages.append(Message("assistant", turn.text))
            messages.append(
                Message(
                    "user",
                    prompt_builder.turn_header(
                        self.budget,
                        remind_protocol=turn_index % PROTOCOL_REMINDER_EVERY == 0,
                        wrap_up_tools=self._terminal_names()
                        if self.budget.max_turns - self.budget.state.turns <= WRAP_UP_AT
                        else None,
                    )
                    + "\n"
                    + prompt_builder.observation_message(result.tool, result.ok, result.observation),
                )
            )

    # ── outcome construction ────────────────────────────────────────────────
    def _terminal_names(self) -> list[str]:
        return [spec.name for spec in self.tools if spec.terminal]

    @staticmethod
    def _signature(call) -> str:
        return json.dumps([call.tool, sorted(call.params.items())], ensure_ascii=False, sort_keys=True)

    def _parse(self, turn) -> protocol.ParseOutcome:
        if turn.tool_calls:
            return protocol.ParseOutcome(call=turn.tool_calls[0])
        return protocol.parse(turn.text, self.tools)

    def _terminal(
        self, tool: str, result: ToolResult, transcript: list[str],
        started: float, totals: dict, usage_source: str, artifacts: list[tuple[str, str]],
    ) -> AgentOutcome:
        if tool == "ask_human":
            self.trace.awaiting_approval(result.data.get("question", ""), self.budget.snapshot())
            outcome = self._finish(
                "awaiting_approval", transcript, result.observation, started, totals, usage_source, artifacts,
            )
            outcome.pending_question = result.data.get("question", "")
            return outcome

        if tool == "propose_context":
            outcome = self._finish(
                "completed", transcript, result.observation, started, totals, usage_source, artifacts,
            )
            outcome.context_paths = list(result.data.get("paths", []))
            return outcome

        status = "failed" if result.data.get("status") == "failed" else "completed"
        outcome = self._finish(
            status, transcript, result.data.get("summary", result.observation),
            started, totals, usage_source, artifacts,
        )
        if status == "failed":
            outcome.error = result.data.get("summary") or "el agente ha declarado la subtarea fallida"
        return outcome

    def _finish(
        self, status: str, transcript: list[str], tail: str, started: float,
        totals: dict, usage_source: str, artifacts: list[tuple[str, str]],
        *, note: str = "", error: str | None = None,
    ) -> AgentOutcome:
        latency_ms = int((time.perf_counter() - started) * 1000)
        body = "\n\n".join(part for part in ([*transcript, note, tail]) if part).strip()
        self.trace.finished(status, self.budget.snapshot(), self.budget.state.cost_usd)
        return AgentOutcome(
            status=status,
            output=body,
            model_used=self.model_used,
            latency_ms=latency_ms,
            turns=self.budget.state.turns,
            tool_calls=self.budget.state.tool_calls,
            input_tokens=totals["input"],
            output_tokens=totals["output"],
            usage_source=usage_source,
            error=error,
            artifacts=artifacts,
        )
