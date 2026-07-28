"""Vocabulary of the agent tool layer: what a tool *is*, and what it returns.

Two design rules the rest of the package depends on:

1. **Tools are data.** A `ToolSpec` is a frozen record with everything needed to
   describe the tool to a model, validate a call against it, render it in the
   dashboard, and test it — the same shape `app/catalog.py` uses for providers.
   Nothing here executes anything.
2. **Errors are observations, not exceptions.** A failed tool returns
   `ToolResult(ok=False, ...)` carrying a message the model can act on. Only
   budget exhaustion ends a session. A 7b model that gets "file not found, did
   you mean X?" recovers; one that gets a stack trace does not.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Literal

ParamType = Literal["string", "integer", "boolean"]

# Stable error vocabulary. The loop uses these to decide whether an observation
# is worth retrying, and the trace groups failures by them.
ErrorCode = Literal[
    "bad_params",
    "not_found",
    "outside_workspace",
    "denied",
    "ambiguous",
    "too_large",
    "timeout",
    "conflict",
    "internal",
]


class RiskTier(str, Enum):
    """What a tool can do to the world, ascending. Drives the approval policy:
    a profile's highest tier decides whether a run needs human sign-off."""

    CONTROL = "control"  # steers the loop; touches nothing
    READ = "read"        # observes the workspace
    WRITE = "write"      # changes files
    EXECUTE = "execute"  # runs programs


@dataclass(frozen=True)
class ToolParam:
    name: str
    type: ParamType = "string"
    required: bool = True
    default: Any = None
    description: str = ""
    # Free-text params (file bodies, patterns) must never be truncated for
    # display; short scalars can be.
    multiline: bool = False

    def signature(self) -> str:
        suffix = "" if self.required else f"={self.default!r}"
        return f"{self.name}:{self.type}{suffix}"


@dataclass(frozen=True)
class ToolSpec:
    name: str
    summary: str                                   # one line, goes verbatim into the system prompt
    params: tuple[ToolParam, ...]
    returns: str                                   # one line describing the observation
    risk: RiskTier
    terminal: bool = False                         # ends the session when called
    failure_modes: tuple[str, ...] = ()            # rendered as "Errores:" hints
    example: str = ""                              # ONE canonical call in the text protocol
    max_output_chars: int = 8_000

    def param(self, name: str) -> ToolParam | None:
        return next((p for p in self.params if p.name == name), None)

    def signature(self) -> str:
        return f"{self.name}({', '.join(p.signature() for p in self.params)})"


@dataclass
class ToolResult:
    """Uniform envelope. The loop, the trace writer and the DB never special-case
    a tool, which is what keeps adding one cheap."""

    ok: bool
    tool: str
    observation: str                                # what the model sees: truncated + redacted
    data: dict[str, Any] = field(default_factory=dict)  # structured, becomes the run_event payload
    error_code: ErrorCode | None = None
    bytes_read: int = 0
    bytes_written: int = 0
    duration_ms: int = 0
    # (workspace-relative path, sha256) for every file touched.
    artifacts: tuple[tuple[str, str], ...] = ()

    @classmethod
    def failure(cls, tool: str, code: ErrorCode, message: str, **data: Any) -> ToolResult:
        return cls(ok=False, tool=tool, observation=message, data=data, error_code=code)

    @classmethod
    def success(cls, tool: str, observation: str, **data: Any) -> ToolResult:
        return cls(ok=True, tool=tool, observation=observation, data=data)


class ToolDenied(Exception):
    """Raised inside the confinement layer and converted to a `ToolResult` at the
    executor boundary — never propagated into the loop."""

    def __init__(self, message: str, code: ErrorCode = "denied") -> None:
        super().__init__(message)
        self.code: ErrorCode = code


def coerce_params(spec: ToolSpec, raw: dict[str, Any]) -> dict[str, Any]:
    """Validate and type-coerce a parsed call against its spec.

    Weak models emit everything as text, so `"true"`/`"1"` must become booleans
    and `"400"` an int. Unknown keys are dropped rather than rejected: a model
    that adds a stray field should still get its call executed.

    Raises `ToolDenied("bad_params")` for a missing required param or a value
    that cannot be coerced — the loop turns that into a corrective observation.
    """
    values: dict[str, Any] = {}
    for param in spec.params:
        if param.name not in raw or raw[param.name] is None:
            if param.required:
                raise ToolDenied(
                    f"falta el parametro obligatorio '{param.name}'. Firma: {spec.signature()}",
                    "bad_params",
                )
            values[param.name] = param.default
            continue

        value = raw[param.name]
        if param.type == "integer":
            try:
                values[param.name] = int(str(value).strip())
            except (TypeError, ValueError):
                raise ToolDenied(
                    f"'{param.name}' debe ser un entero, se recibio {value!r}. Firma: {spec.signature()}",
                    "bad_params",
                ) from None
        elif param.type == "boolean":
            values[param.name] = str(value).strip().lower() in {"true", "1", "yes", "si", "sí", "y"}
        else:
            values[param.name] = str(value)
    return values
