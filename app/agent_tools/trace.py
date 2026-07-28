"""Execution trace: what turns "the agent said something" into "the agent did
something verifiable".

Writes into `run_events` and `artifacts` — the two tables shipped empty as
Fase-1 groundwork.

Every method is guarded the same way `delegation._persist_run` is: tracing must
never be able to break the run it is tracing. A store failure degrades to a log
line, never an exception into the loop.
"""

from __future__ import annotations

import logging
from typing import Any

from app import events
from app.agent_tools.spec import ToolResult
from app.logging_config import get_logger, log_event

logger = get_logger("agent_tools")

MAX_EXCERPT = 2000


def _excerpt(text: str, limit: int = MAX_EXCERPT) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n[…{len(text) - limit} caracteres omitidos…]"


class Trace:
    """Writer bound to one run. `store=None` makes every method a no-op, which
    is what keeps the loop usable from tests and from callers with no DB."""

    def __init__(self, store: Any | None, task_id: str, run_id: str | None) -> None:
        self.store = store
        self.task_id = task_id
        self.run_id = run_id

    @property
    def enabled(self) -> bool:
        return self.store is not None and self.run_id is not None

    def event(self, event_type: str, payload: dict | None = None) -> None:
        if not self.enabled:
            return
        try:
            self.store.record_run_event(self.run_id, event_type, payload)
        except Exception:  # noqa: BLE001 - tracing must never break the run
            log_event(
                logger, logging.WARNING, "run_event_failed",
                task_id=self.task_id, run_id=self.run_id, event_type=event_type,
            )

    # ── lifecycle ───────────────────────────────────────────────────────────
    def started(self, profile: str, workspace_root: str, tool_mode: str, budget: dict) -> None:
        self.event(
            "agent_started",
            {"profile": profile, "workspace_root": workspace_root, "tool_mode": tool_mode, "budget": budget},
        )

    def model_turn(
        self, turn: int, *, parsed: str, latency_ms: int,
        input_tokens: int, output_tokens: int, usage_source: str, raw: str,
    ) -> None:
        self.event(
            "model_turn",
            {
                "turn": turn, "parsed": parsed, "latency_ms": latency_ms,
                "input_tokens": input_tokens, "output_tokens": output_tokens,
                "usage_source": usage_source, "raw_excerpt": _excerpt(raw, 1200),
            },
        )

    def tool_call(self, turn: int, tool: str, params: dict, risk: str) -> None:
        self.event(
            "tool_call",
            {"turn": turn, "tool": tool, "risk": risk, "params": _redact_params(params)},
        )
        events.publish("tool_call", task_id=self.task_id, run_id=self.run_id, tool=tool)

    def tool_result(self, turn: int, result: ToolResult) -> None:
        self.event(
            "tool_result",
            {
                "turn": turn, "tool": result.tool, "ok": result.ok,
                "error_code": result.error_code, "duration_ms": result.duration_ms,
                "bytes_read": result.bytes_read, "bytes_written": result.bytes_written,
                "observation_excerpt": _excerpt(result.observation),
            },
        )
        if not result.ok and result.error_code == "denied":
            self.event("tool_denied", {"turn": turn, "tool": result.tool, "reason": _excerpt(result.observation, 500)})

    def parse_error(self, turn: int, reason: str, raw: str, strikes: int) -> None:
        self.event("parse_error", {"turn": turn, "reason": reason, "strikes": strikes, "raw_excerpt": _excerpt(raw, 1200)})

    def budget_exhausted(self, reason: str, budget: dict) -> None:
        self.event("budget_exhausted", {"reason": reason, "budget": budget})

    def awaiting_approval(self, question: str, budget: dict) -> None:
        self.event("awaiting_approval", {"question": _excerpt(question, 1000), "budget": budget})

    def finished(self, status: str, budget: dict, cost_usd: float) -> None:
        self.event("agent_finished", {"status": status, "budget": budget, "cost_usd": round(cost_usd, 6)})

    # ── artifacts ───────────────────────────────────────────────────────────
    def artifacts(self, result: ToolResult, *, dry_run: bool) -> None:
        """One row per file touched. `file_path` stays workspace-relative so the
        ledger is portable and the operator's home path never enters it."""
        if not self.enabled or not result.artifacts:
            return
        kind = "file_planned" if dry_run else ("file_created" if result.tool == "write_file" else "file_modified")
        for rel_path, digest in result.artifacts:
            try:
                self.store.record_artifact(
                    task_id=self.task_id, run_id=self.run_id, kind=kind,
                    file_path=rel_path, size_bytes=result.bytes_written, content_hash=digest,
                )
            except Exception:  # noqa: BLE001
                log_event(
                    logger, logging.WARNING, "record_artifact_failed",
                    task_id=self.task_id, run_id=self.run_id, file_path=rel_path,
                )


_SENSITIVE_HINTS = ("token", "key", "secret", "password", "passwd", "credential")


def _redact_params(params: dict) -> dict:
    """Trim long bodies and drop anything that smells like a credential.

    The trace is read by humans and shipped to the dashboard; a full file body
    per call would drown it, and a parameter literally named `api_key` has no
    business being persisted at all.
    """
    cleaned: dict[str, Any] = {}
    for key, value in params.items():
        if any(hint in key.lower() for hint in _SENSITIVE_HINTS):
            cleaned[key] = "[redactado]"
            continue
        text = str(value)
        cleaned[key] = text if len(text) <= 400 else text[:400] + f"…(+{len(text) - 400})"
    return cleaned
