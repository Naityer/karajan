from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


from .tasks import _utcnow, ComplexityLevel, RecommendedModel, TaskStatus, TaskV2Status, Backend, AuthMethod, Profile, CriteriaScores, TaskRequest, Subtask, ResourceRecommendationContext, ClassificationResult, IngestRequest, DelegationRequest, SubtaskExecution, ValidationVerdict, DelegationResult, TaskRecord, Metrics, NodeMetrics, FlowEvent, ModelUsage, SystemHealth, ObservabilitySnapshot, MetricsHistoryPoint, MetricsHistory, AgentPerformance
from .execution import RunInfo, RunEventInfo, ArtifactInfo, ContextPackRequest, ContextPackSummary, ContextPackDetail, DocResultRequest, AgentToolsConfig, ToolParamInfo, ToolSpecInfo, ToolProfileInfo


class SetupStatus(BaseModel):
    completed: bool


class SetupTutorial(BaseModel):
    markdown: str


class HealthStatus(BaseModel):
    """Cheap liveness/readiness probe for production monitoring."""

    status: str  # "ok" | "degraded"
    version: str
    backend: str
    profile: str
    auth_enabled: bool
    db_ok: bool
    total_tasks: int


class ProviderInfo(BaseModel):
    """Static catalog entry for an AI provider (free or paid)."""

    name: str
    label: str
    is_free: bool
    is_cloud_hosted: bool = False  # invoked via local CLI but executes on the provider's cloud (e.g. `ollama run x:cloud`) — not free local compute
    auth_method: AuthMethod
    backend: Backend
    tiers: dict[RecommendedModel, str] = Field(default_factory=dict)
    endpoint: str | None = None
    signup_url: str | None = None
    env_var: str | None = None
    cli_command: str | None = None  # template, e.g. "ollama run {model}"
    login_command: str | None = None  # e.g. "ollama serve" / "claude /login"
    probe_command: str | None = None  # cheap readiness check, e.g. "ollama list"


class CredentialStatus(BaseModel):
    provider: str
    available: bool  # credential/binary present
    ready: bool  # actually usable now (model pulled / server up); ready <= available
    auth_method: AuthMethod
    detail: str


class ProviderSetup(BaseModel):
    provider: str
    available: bool
    steps: list[str]
    signup_url: str | None = None


class ProviderRunRequest(BaseModel):
    slot: Literal["login_command", "probe_command"]


class ProviderRunResult(BaseModel):
    ok: bool
    provider: str
    slot: str
    command: str
    stdout: str
    stderr: str
    returncode: int
    detail: str


class DefaultConfigApplyResult(BaseModel):
    ok: bool
    restored: list[str] = Field(default_factory=list)
    backups: list[str] = Field(default_factory=list)
    ollama_installed: list[str] = Field(default_factory=list)
    ollama_missing: list[str] = Field(default_factory=list)
    credentials: dict[str, CredentialStatus] = Field(default_factory=dict)
    next_steps: list[str] = Field(default_factory=list)


class SkillInfo(BaseModel):
    name: str
    description: str
    installed: bool
    recommended: bool
    applies_to: list[str] = Field(default_factory=list)
    install_command: str | None = None
    repo_url: str | None = None


class SkillInstallResult(BaseModel):
    ok: bool
    detail: str


class OpenClawConfig(BaseModel):
    enabled: bool = True
    cli_path: str = "openclaw"
    gateway_url: str = "http://127.0.0.1:18789"
    auth_token_env: str = "OPENCLAW_GATEWAY_TOKEN"
    prefer_admin_http_rpc: bool = False


class OpenClawSetupCommand(BaseModel):
    section: str
    command: str
    description: str


class OpenClawStatus(BaseModel):
    enabled: bool
    cli_path: str
    cli_available: bool
    ready: bool
    gateway_url: str | None = None
    version: str | None = None
    gateway_status: str | None = None
    detail: str
    raw: dict[str, Any] = Field(default_factory=dict)
    setup_commands: list[OpenClawSetupCommand] = Field(default_factory=list)


class OpenClawSkillInfo(BaseModel):
    name: str
    description: str = ""
    installed: bool = True
    source: str = "openclaw"
    agent: str | None = None
    spec: str | None = None


class OpenClawChannelInfo(BaseModel):
    id: str
    label: str
    status: str
    ready: bool = False
    detail: str = ""


class OpenClawInstallRequest(BaseModel):
    spec: str = Field(min_length=1, max_length=400)
    agent: str | None = Field(default=None, max_length=120)
    global_install: bool = False
    force: bool = False
    acknowledge_clawhub_risk: bool = False


class OpenClawUpdateRequest(BaseModel):
    spec: str | None = Field(default=None, max_length=400)
    all: bool = False
    agent: str | None = Field(default=None, max_length=120)
    global_install: bool = False
    acknowledge_clawhub_risk: bool = False


class OpenClawOperationResult(BaseModel):
    ok: bool
    command: str
    detail: str
    returncode: int | None = None


class OpenClawDaemonStatus(BaseModel):
    installed: bool
    running: bool
    detail: str = ""


class OpenClawPluginInfo(BaseModel):
    name: str
    description: str = ""
    installed: bool = False
    spec: str | None = None


class OpenClawPluginInstallRequest(BaseModel):
    spec: str = Field(min_length=1, max_length=400)
    acknowledge_clawhub_risk: bool = False
