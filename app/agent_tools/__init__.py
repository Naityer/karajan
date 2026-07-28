"""KARAJAN's own agent tool layer.

Gives any local model — including Ollama models with no native function-calling
— the ability to perform real, confined, audited operations, instead of the
single blind text completion a subtask used to be.

Public surface (kept small on purpose; everything else is an implementation
detail of the loop):

    catalog     the tool catalog and permission profiles, as data
    Workspace   the confinement boundary every path is checked against
    RunBudget   per-session limits; exhausting one is a clean terminal state
    dispatch    parsed call -> validated params -> executor -> ToolResult
"""

from __future__ import annotations

from app.agent_tools import catalog, policy
from app.agent_tools.budget import RunBudget
from app.agent_tools.executors import dispatch, is_terminal
from app.agent_tools.policy import AgentPlan, plan, requires_human_review
from app.agent_tools.runner import describe, run_agent_subtask
from app.agent_tools.session import AgentOutcome, AgentSession
from app.agent_tools.spec import RiskTier, ToolDenied, ToolResult, ToolSpec
from app.agent_tools.workspace import Workspace

__all__ = [
    "AgentOutcome",
    "AgentPlan",
    "AgentSession",
    "RiskTier",
    "RunBudget",
    "ToolDenied",
    "ToolResult",
    "ToolSpec",
    "Workspace",
    "catalog",
    "describe",
    "dispatch",
    "is_terminal",
    "plan",
    "policy",
    "requires_human_review",
    "run_agent_subtask",
]
