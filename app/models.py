from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ComplexityLevel(str, Enum):
    LEVEL_1_SIMPLE = "level_1_simple"
    LEVEL_2_MODERATE = "level_2_moderate"
    LEVEL_3_INTERMEDIATE = "level_3_intermediate"
    LEVEL_4_COMPLEX = "level_4_complex"
    LEVEL_5_CRITICAL = "level_5_critical"


class RecommendedModel(str, Enum):
    """Logical model tier. `registry` maps each tier to a concrete provider+model."""

    CHEAP_MODEL = "cheap_model"
    CHEAP_OR_MEDIUM_MODEL = "cheap_or_medium_model"
    MEDIUM_MODEL = "medium_model"
    STRONG_MODEL = "strong_model"
    STRONG_MODEL_WITH_HUMAN_REVIEW = "strong_model_with_human_review"


class TaskStatus(str, Enum):
    CLASSIFIED = "classified"
    DELEGATED = "delegated"
    COMPLETED = "completed"
    FAILED = "failed"


class Backend(str, Enum):
    SIMULATED = "simulated"
    API = "api"
    CLI = "cli"


class AuthMethod(str, Enum):
    API_KEY = "api_key"
    CLI_LOGIN = "cli_login"
    LOCAL = "local"
    NONE = "none"


class Profile(str, Enum):
    """Config personas. `simple` auto-detects; `pro` honors a full config file."""

    SIMPLE = "simple"
    PRO = "pro"
    OFFLINE = "offline"


class CriteriaScores(BaseModel):
    ambiguity: float = Field(ge=0, le=5)
    context_required: float = Field(ge=0, le=5)
    reasoning_depth: float = Field(ge=0, le=5)
    autonomy_required: float = Field(ge=0, le=5)
    operational_risk: float = Field(ge=0, le=5)
    validation_difficulty: float = Field(ge=0, le=5)


class TaskRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=20000)

    @field_validator("prompt")
    @classmethod
    def strip_prompt(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("prompt cannot be blank")
        return value


class Subtask(BaseModel):
    id: str
    name: str
    complexity: int = Field(ge=1, le=5)
    recommended_model: RecommendedModel
    recommended_skill: str | None = None
    recommended_strategy: str | None = None
    validation: str


class ClassificationResult(BaseModel):
    task_id: str = Field(default_factory=lambda: f"tsk_{uuid4().hex[:12]}")
    original_prompt: str
    domain: list[str]
    intent: str
    criteria: CriteriaScores
    complexity_score: float = Field(ge=0, le=5)
    complexity_level: ComplexityLevel
    recommended_strategy: str
    recommended_model: RecommendedModel
    recommended_skills: list[str] = Field(default_factory=list)
    subtasks: list[Subtask]
    requires_human_review: bool
    reason: str
    validation_plan: str
    classified_by: str = "heuristic"  # "heuristic" | "llm:<provider>"
    created_at: datetime = Field(default_factory=_utcnow)


class IngestRequest(BaseModel):
    """Classification produced by the model in its own console (the parent).

    Numeric routing (score/level/model) is recomputed server-side; subtasks are
    optional and synthesized if absent. See `classifier.reconcile`.
    """

    original_prompt: str = Field(min_length=1, max_length=20000)
    domain: list[str] = Field(default_factory=lambda: ["general"])
    intent: str = "classify_and_plan"
    criteria: CriteriaScores
    subtasks: list[Subtask] = Field(default_factory=list)
    recommended_strategy: str | None = None
    recommended_skills: list[str] = Field(default_factory=list)
    reason: str | None = None
    requires_human_review: bool | None = None
    validation_plan: str | None = None


class DelegationRequest(BaseModel):
    task_id: str


class SubtaskExecution(BaseModel):
    subtask_id: str
    status: TaskStatus
    backend: Backend
    model_used: str
    latency_ms: int
    estimated_cost_usd: float
    output: str
    error: str | None = None


class DelegationResult(BaseModel):
    task_id: str
    status: TaskStatus
    executions: list[SubtaskExecution]
    total_latency_ms: int
    total_estimated_cost_usd: float
    completed_at: datetime = Field(default_factory=_utcnow)


class TaskRecord(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    task_id: str
    prompt: str
    status: TaskStatus
    classification: ClassificationResult
    delegation: DelegationResult | None = None
    created_at: datetime
    updated_at: datetime


class Metrics(BaseModel):
    total_tasks: int
    by_level: dict[str, int]
    by_model: dict[str, int]
    by_backend: dict[str, int]
    by_status: dict[str, int] = Field(default_factory=dict)
    by_skill: dict[str, int] = Field(default_factory=dict)
    total_subtasks: int = 0
    delegated_tasks: int = 0
    human_review_required: int
    total_estimated_cost_usd: float
    average_complexity_score: float


class NodeMetrics(BaseModel):
    id: str
    name: str
    role: str
    status: str = "idle"
    active_model: str = "auto / simulado"
    provider: str = "simulated"
    model_tier: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    estimated_cost: float = 0.0
    latency_ms: int = 0
    task_count: int = 0
    error_count: int = 0
    last_activity: str = ""
    confidence: float | None = None
    active_capabilities: list[str] = Field(default_factory=list)
    levels: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    extra: dict[str, Any] = Field(default_factory=dict)


class FlowEvent(BaseModel):
    timestamp: datetime
    event_type: str
    source_node: str = "Agent"
    target_node: str | None = None
    task_id: str
    summary: str
    model: str | None = None
    cost: float = 0.0
    latency_ms: int = 0
    status: str = "completed"


class ModelUsage(BaseModel):
    model: str
    provider: str
    calls: int = 0
    estimated_cost: float = 0.0
    latency_ms: int = 0
    errors: int = 0


class SystemHealth(BaseModel):
    status: str
    observed_nodes: int
    healthy_nodes: int
    warning_nodes: int
    error_nodes: int
    active_tasks: int
    failed_tasks: int
    blocked_tasks: int
    total_cost: float
    avg_latency_ms: int
    last_activity: str = ""


class ObservabilitySnapshot(BaseModel):
    health: SystemHealth
    nodes: list[NodeMetrics] = Field(default_factory=list)
    execution_flow: list[FlowEvent] = Field(default_factory=list)
    audit_timeline: list[FlowEvent] = Field(default_factory=list)
    model_usage: list[ModelUsage] = Field(default_factory=list)


class HealthStatus(BaseModel):
    """Cheap liveness/readiness probe for production monitoring."""

    status: str  # "ok" | "degraded"
    version: str
    backend: str
    profile: str
    auth_enabled: bool
    db_ok: bool
    total_tasks: int


# --- Provider catalog & credentials -----------------------------------------


class ProviderInfo(BaseModel):
    """Static catalog entry for an AI provider (free or paid)."""

    name: str
    label: str
    is_free: bool
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


class RoutingEntity(BaseModel):
    id: str
    name: str | None = None
    role: str
    role_tags: list[str] = Field(default_factory=list)
    provider: str | None = None
    parentId: str | None = ""
    levels: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    capabilities: list[str] = Field(default_factory=list)
    x: float = 0
    y: float = 0


class RoutingLayout(BaseModel):
    entities: list[RoutingEntity] = Field(default_factory=list)
    zoom: float = Field(default=1.0, ge=0.4, le=2.0)
    drawer_width: int = Field(default=320, ge=220, le=680)
    updated_at: datetime = Field(default_factory=_utcnow)


# --- Configuration -----------------------------------------------------------


class OrchestrationConfig(BaseModel):
    parallel: bool = False
    max_parallel: int = Field(default=3, ge=1, le=16)
    subtask_timeout_s: int = Field(default=120, ge=1)
    classify_timeout_s: int = Field(default=10, ge=1)
    max_retries: int = Field(default=1, ge=0, le=5)
    enable_runtime_fallback: bool = True
    require_human_review_gate: bool = True
    # Cost guardrails evaluated BEFORE any subtask runs. 0 disables the cap.
    max_cost_per_task_usd: float = Field(default=0.0, ge=0.0)
    max_daily_cost_usd: float = Field(default=0.0, ge=0.0)


class PolicyConfig(BaseModel):
    sensitive_domains: list[str] = Field(default_factory=lambda: ["security", "operations", "devops"])
    critical_intents: list[str] = Field(default_factory=lambda: ["security_architecture_review", "security_review"])
    human_review_min_level: int = Field(default=5, ge=1, le=5)
    operational_risk_review_threshold: float = Field(default=4.0, ge=0.0, le=5.0)
    require_review_for_paid_providers: bool = False
    require_review_for_missing_credentials: bool = True


class KarajanConfig(BaseModel):
    """Adjustable parameters for the whole flow. Defaults match legacy behavior."""

    profile: Profile = Profile.SIMPLE
    backend: Backend = Backend.SIMULATED
    criteria_weights: dict[str, float] = Field(
        default_factory=lambda: {
            "ambiguity": 0.20,
            "context_required": 0.20,
            "reasoning_depth": 0.20,
            "autonomy_required": 0.15,
            "operational_risk": 0.15,
            "validation_difficulty": 0.10,
        }
    )
    level_thresholds: list[float] = Field(default_factory=lambda: [1.5, 2.5, 3.5, 4.3])
    level_to_model: dict[str, str] = Field(
        default_factory=lambda: {
            ComplexityLevel.LEVEL_1_SIMPLE.value: RecommendedModel.CHEAP_MODEL.value,
            ComplexityLevel.LEVEL_2_MODERATE.value: RecommendedModel.CHEAP_OR_MEDIUM_MODEL.value,
            ComplexityLevel.LEVEL_3_INTERMEDIATE.value: RecommendedModel.MEDIUM_MODEL.value,
            ComplexityLevel.LEVEL_4_COMPLEX.value: RecommendedModel.STRONG_MODEL.value,
            ComplexityLevel.LEVEL_5_CRITICAL.value: RecommendedModel.STRONG_MODEL_WITH_HUMAN_REVIEW.value,
        }
    )
    cost_table: dict[str, float] = Field(
        default_factory=lambda: {
            RecommendedModel.CHEAP_MODEL.value: 0.0004,
            RecommendedModel.CHEAP_OR_MEDIUM_MODEL.value: 0.0010,
            RecommendedModel.MEDIUM_MODEL.value: 0.0025,
            RecommendedModel.STRONG_MODEL.value: 0.0090,
            RecommendedModel.STRONG_MODEL_WITH_HUMAN_REVIEW.value: 0.0125,
        }
    )
    latency_table: dict[str, int] = Field(
        default_factory=lambda: {
            RecommendedModel.CHEAP_MODEL.value: 180,
            RecommendedModel.CHEAP_OR_MEDIUM_MODEL.value: 320,
            RecommendedModel.MEDIUM_MODEL.value: 650,
            RecommendedModel.STRONG_MODEL.value: 1300,
            RecommendedModel.STRONG_MODEL_WITH_HUMAN_REVIEW.value: 1700,
        }
    )
    orchestration: OrchestrationConfig = Field(default_factory=OrchestrationConfig)
    policy: PolicyConfig = Field(default_factory=PolicyConfig)
    # tier -> preferred provider name (filled by auto-detect in simple mode)
    provider_preferences: dict[str, str] = Field(default_factory=dict)
    prefer_free: bool = True
    openclaw: OpenClawConfig = Field(default_factory=OpenClawConfig)


# --- Decision log (lightweight harness audit) --------------------------------


class DecisionLogEntry(BaseModel):
    """Compact, append-only record of a single harness decision."""

    id: str = Field(default_factory=lambda: f"dec_{uuid4().hex[:10]}")
    task_id: str
    phase: str  # "classify" | "delegate" | "validate"
    decision: str  # short machine-readable summary, e.g. "model=strong_model"
    score: float | None = None
    backend: Backend | None = None
    reason: str = ""
    created_at: datetime = Field(default_factory=_utcnow)


class ErrorResponse(BaseModel):
    detail: str
    context: dict[str, Any] = Field(default_factory=dict)
