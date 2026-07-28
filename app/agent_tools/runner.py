"""The single entry point `delegation.run_subtask` calls.

Everything it returns is an ordinary `ProviderRun`, so the fallback chain, the
validator loop, the cost math, `SubtaskExecution` and `_persist_run` are all
untouched. The tool loop replaces one call; it is not a parallel pipeline.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from app.agent_tools import catalog
from app.agent_tools.policy import AgentPlan
from app.agent_tools.session import AgentOutcome, AgentSession
from app.agent_tools.trace import Trace
from app.agent_tools.transport import CompletionTransport
from app.logging_config import get_logger, log_event
from app.models import AgentToolsConfig, ClassificationResult, Subtask
from app.providers.registry import Resolution

logger = get_logger("agent_tools")

# N parallel sessions against one local Ollama instance serialize at the model
# and blow every per-turn timeout. Guarded here rather than in the scheduler so
# both the ThreadPoolExecutor fan-out and the async queue path are covered.
_session_slots = threading.Semaphore(1)
_slots_configured_for = 1
_slots_lock = threading.Lock()


def configure_concurrency(max_sessions: int) -> None:
    global _session_slots, _slots_configured_for
    with _slots_lock:
        wanted = max(1, int(max_sessions))
        if wanted != _slots_configured_for:
            _session_slots = threading.Semaphore(wanted)
            _slots_configured_for = wanted


def build_transport(resolution: Resolution):
    """Pick how this provider is spoken to.

    Only `CompletionTransport` for now — which is exactly why every catalog
    provider gets tool use without a single provider file changing. Native
    tool-calling transports slot in here later without touching the session.
    """
    return CompletionTransport(resolution.provider, resolution.model_id)


def run_agent_subtask(
    classification: ClassificationResult,
    subtask: Subtask,
    resolution: Resolution,
    plan: AgentPlan,
    settings: AgentToolsConfig,
    *,
    store: Any | None = None,
    run_id: str | None = None,
    max_cost_usd: float = 0.0,
) -> AgentOutcome:
    """Run one subtask as an agent session. Never raises."""
    assert plan.workspace is not None  # guaranteed by `policy.plan`

    configure_concurrency(settings.max_concurrent_sessions)
    trace = Trace(store, classification.task_id, run_id)
    budget = plan.budget(settings, max_cost_usd=max_cost_usd)
    session = AgentSession(
        build_transport(resolution),
        plan.workspace,
        profile=plan.profile,
        budget=budget,
        trace=trace,
        model_used=f"{resolution.provider_name}:{resolution.model_id}",
        turn_timeout_s=settings.turn_timeout_s,
    )

    acquired = _session_slots.acquire(timeout=settings.max_wall_time_s)
    try:
        if not acquired:
            return AgentOutcome(
                status="failed", output="", model_used=session.model_used, latency_ms=0,
                error="no habia ningun hueco de sesion libre dentro del tiempo maximo",
            )
        return session.run(classification.original_prompt, subtask.name, subtask.validation)
    except Exception as exc:  # noqa: BLE001 - a loop bug must degrade, not kill the task
        log_event(
            logger, logging.ERROR, "agent_session_failed",
            task_id=classification.task_id, subtask_id=subtask.id,
            error=f"{type(exc).__name__}: {exc}",
        )
        return AgentOutcome(
            status="failed", output="", model_used=session.model_used, latency_ms=0,
            error=f"fallo interno del bucle de agente: {type(exc).__name__}: {exc}",
        )
    finally:
        if acquired:
            _session_slots.release()


def describe(plan: AgentPlan) -> str:
    """One-line summary for the decision log."""
    if not plan.enabled:
        return f"agent_tools=off;reason={plan.reason}"
    workspace = plan.workspace
    return (
        f"agent_tools=on;profile={plan.profile};risk={catalog.max_risk(plan.profile).value};"
        f"dry_run={bool(workspace and workspace.dry_run)}"
    )
