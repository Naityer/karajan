"""How a turn reaches a model.

`CompletionTransport` is the universal floor: it wraps **any** existing
`ModelProvider` by flattening the conversation into one prompt and calling
`provider.run(...)`. That is what gives every provider in `app/catalog.py` tool
use on day one without touching a single provider file — the native
tool-calling transports (Ollama `/api/chat`, provider `tools=` arrays) are an
optimization layered on later, not a prerequisite.

Kept deliberately synchronous: `delegation.delegate` fans out over a
`ThreadPoolExecutor` and `scheduler` calls `asyncio.to_thread`, and a blocking
transport composes with both. An async one composes with neither without
rewriting `delegation.py`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from app.agent_tools.protocol import ParsedCall
from app.providers.base import ModelProvider


@dataclass
class Message:
    role: str  # "system" | "user" | "assistant"
    content: str


@dataclass
class TransportTurn:
    text: str = ""
    tool_calls: list[ParsedCall] = field(default_factory=list)
    latency_ms: int = 0
    error: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    # "measured" once a provider reports real usage; until then the numbers are
    # a 4-chars-per-token estimate and must not be priced as if they were real.
    usage_source: str = "estimated"


class ToolTransport(Protocol):
    supports_native_tools: bool

    def chat(self, messages: list[Message], tools: list, timeout_s: int) -> TransportTurn: ...


class CompletionTransport:
    """Adapts a one-shot `ModelProvider` into the transport interface."""

    supports_native_tools = False

    def __init__(self, provider: ModelProvider, model_id: str) -> None:
        self.provider = provider
        self.model_id = model_id

    def chat(self, messages: list[Message], tools: list, timeout_s: int) -> TransportTurn:
        from app.execution import estimate_tokens

        prompt = self.flatten(messages)
        run = self.provider.run(prompt, self.model_id, timeout_s)
        return TransportTurn(
            text=run.output or "",
            latency_ms=run.latency_ms,
            error=run.error,
            input_tokens=estimate_tokens(prompt),
            output_tokens=estimate_tokens(run.output or ""),
            usage_source="estimated",
        )

    @staticmethod
    def flatten(messages: list[Message]) -> str:
        """Collapse the conversation into one prompt.

        Roles are labelled explicitly because a bare concatenation makes a small
        model lose track of which text was its own output and which was the
        tool's answer — and that confusion shows up as it "replying" to its own
        previous turn instead of acting.
        """
        labels = {"system": "SISTEMA", "user": "USUARIO", "assistant": "TU RESPUESTA ANTERIOR"}
        parts = [f"### {labels.get(message.role, message.role.upper())}\n{message.content}" for message in messages]
        parts.append("### TU RESPUESTA")
        return "\n\n".join(parts)
