from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


from .tasks import _utcnow, ComplexityLevel, RecommendedModel, TaskStatus, TaskV2Status, Backend, AuthMethod, Profile, CriteriaScores, TaskRequest, Subtask, ResourceRecommendationContext, ClassificationResult, IngestRequest, DelegationRequest, SubtaskExecution, ValidationVerdict, DelegationResult, TaskRecord, Metrics, NodeMetrics, FlowEvent, ModelUsage, SystemHealth, ObservabilitySnapshot, MetricsHistoryPoint, MetricsHistory, AgentPerformance


class RunInfo(BaseModel):
    """One row of `runs` — the per-execution ledger the Tareas drill-down reads.

    Deliberately permissive on every field but `id`/`task_id`/`run_index`: rows
    backfilled from the pre-Fase-1 schema (see `TaskStore._backfill_v2`) carry
    NULLs the live path never writes, and the drill-down must still render them.
    """

    id: str
    task_id: str
    run_index: int
    provider_name: str | None = None
    routing_entity_id: str | None = None
    routing_entity_name_snapshot: str | None = None
    model_id: str | None = None
    backend: str | None = None
    status: str
    started_at: str | None = None
    completed_at: str | None = None
    latency_ms: int | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    estimated_cost_usd: float | None = None
    error: str | None = None


class RunEventInfo(BaseModel):
    """One entry of a run's execution trace (tool call, model turn, denial...).

    `payload` is already decoded from the `payload_json` column so callers never
    parse JSON twice; an unreadable payload degrades to `None` rather than
    failing the whole trace.
    """

    id: str
    run_id: str
    event_type: str
    ts: str
    payload: dict | None = None


class ArtifactInfo(BaseModel):
    """A file an agent actually touched during a run.

    `file_path` is workspace-relative on purpose: the ledger stays portable and
    the operator's absolute home path never enters the audit trail.
    """

    id: str
    task_id: str
    run_id: str | None = None
    kind: str
    file_path: str
    size_bytes: int | None = None
    content_hash: str | None = None
    created_at: str


class ContextPackRequest(BaseModel):
    """Build a documentation context pack from a selection of files.

    `paths` is normally what the `doc` profile's `propose_context` tool returned,
    but it can be passed by hand for a selection you already know.
    """

    task_id: str
    prompt: str = Field(min_length=1, max_length=20000)
    paths: list[str] = Field(min_length=1)
    workspace_root: str | None = None
    rationale: str = ""


class ContextPackSummary(BaseModel):
    id: str
    task_id: str
    prompt: str
    created_at: str
    files: int
    total_chars: int
    status: str  # pending | ready


class ContextPackDetail(ContextPackSummary):
    workspace_root: str
    rationale: str = ""
    markdown: str
    skipped: list[str] = Field(default_factory=list)
    result_markdown: str | None = None


class DocResultRequest(BaseModel):
    """The answer pasted back from the web chat."""

    markdown: str = Field(min_length=1)


class AgentToolsConfig(BaseModel):
    """Settings for the agent tool loop.

    `enabled` defaults to False and `dry_run` to True: turning the loop on is an
    explicit operator decision, and the first thing it should do is show what it
    *would* change, following the same opt-in shape as `enable_validator_loop`.
    """

    enabled: bool = False
    dry_run: bool = True
    profile: str = "readonly"
    # No default root on purpose: without a workspace the tools are disabled,
    # rather than silently operating on the server's working directory (which is
    # the long-standing `claude-cli` bug this design refuses to repeat).
    default_workspace_root: str | None = None
    allow_karajan_repo: bool = False
    max_turns: int = 12
    max_tool_calls: int = 24
    max_wall_time_s: int = 900
    turn_timeout_s: int = 120
    # Local models serialize at the model anyway; more than one session against
    # one Ollama instance just multiplies timeouts.
    max_concurrent_sessions: int = 1
    require_approval_from_risk: str = "write"  # control | read | write | execute


class ToolParamInfo(BaseModel):
    name: str
    type: str
    required: bool
    default: Any = None
    description: str = ""


class ToolSpecInfo(BaseModel):
    """One entry of the agent tool catalog, as the dashboard renders it.

    Mirrors `ProviderInfo`'s role for providers: the catalog is data, so it can
    be listed, diffed and reviewed without reading the executor code.
    """

    name: str
    summary: str
    params: list[ToolParamInfo]
    returns: str
    risk: str
    terminal: bool
    failure_modes: list[str] = Field(default_factory=list)
    example: str = ""


class ToolProfileInfo(BaseModel):
    """A permission set. `max_risk` is what drives the human-approval policy."""

    name: str
    tools: list[str]
    max_risk: str
    terminal_tools: list[str]
