from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator




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
    QUEUED = "queued"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCEL_REQUESTED = "cancel_requested"
    OUTCOME_UNKNOWN = "outcome_unknown"


class TaskV2Status(str, Enum):
    """Broader lifecycle vocabulary for `tasks_v2` (Fase 1 schema).

    Distinct from `TaskStatus` (the legacy `tasks` table's vocabulary) — legacy
    rows are mapped onto this one deterministically, see `TaskStore._map_status_v2`.
    """

    DRAFT = "draft"
    QUEUED = "queued"
    RUNNING = "running"
    WAITING_HUMAN = "waiting_human"
    COMPLETED = "completed"
    FAILED = "failed"
    ARCHIVED = "archived"


class Backend(str, Enum):
    """How a provider is reached. There is deliberately no fake/offline member:
    when nothing is ready KARAJAN withholds execution rather than inventing one."""

    API = "api"
    CLI = "cli"


class AuthMethod(str, Enum):
    API_KEY = "api_key"
    CLI_LOGIN = "cli_login"
    LOCAL = "local"
    NONE = "none"


class Profile(str, Enum):
    """Config personas. `simple` auto-detects; `pro` honors a full config file.

    `offline` means *heuristic classification, no LLM call* — it does not mean
    "use a fake backend". Delegation under `offline` still needs a real ready
    provider, or it is withheld.
    """

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
    effort_level: ComplexityLevel | None = None
    entry_agent: str | None = Field(default=None, max_length=60)

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
    recommended_skills: list[str] = Field(default_factory=list)
    recommended_strategy: str | None = None
    validation: str


class ResourceRecommendationContext(BaseModel):
    resource_id: str
    slug: str
    name: str
    kind: Literal["skill", "capability", "reference"]
    summary: str = ""
    source_url: str | None = None
    parent_resource_id: str | None = None
    role: Literal["primary", "complementary"]
    score: float


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
    recommended_resources: list[ResourceRecommendationContext] = Field(default_factory=list)
    subtasks: list[Subtask]
    requires_human_review: bool
    reason: str
    validation_plan: str
    classified_by: str = "heuristic"  # "heuristic" | "llm:<provider>"
    # Agente que recibió el prompt (punto de entrada): claude, codex, qwen, atlas-dev… None en el histórico anterior.
    entry_agent: str | None = Field(default=None, max_length=60)
    created_at: datetime = Field(default_factory=_utcnow)


class IngestRequest(BaseModel):
    """Classification produced by the model in its own console (the parent).

    Numeric routing (score/level/model) is recomputed server-side; subtasks are
    optional and synthesized if absent. See `classifier.reconcile`.
    """

    original_prompt: str = Field(min_length=1, max_length=20000)
    entry_agent: str | None = Field(default=None, max_length=60)
    domain: list[str] = Field(default_factory=lambda: ["general"])
    intent: str = "classify_and_plan"
    criteria: CriteriaScores
    subtasks: list[Subtask] = Field(default_factory=list)
    recommended_strategy: str | None = None
    recommended_skills: list[str] = Field(default_factory=list)
    recommended_resources: list[ResourceRecommendationContext] = Field(default_factory=list)
    reason: str | None = None
    requires_human_review: bool | None = None
    validation_plan: str | None = None


class DelegationRequest(BaseModel):
    task_id: str
    # Force delegation to one named catalog provider or routing entity, bypassing
    # the tier-based routing in `flow_policy`/`registry.resolve`. Applies to the
    # whole task (every subtask), not per-subtask. Pass at most one of the two.
    force_provider: str | None = None
    force_entity_id: str | None = None
    # Context supplied after classification. It reaches providers during execution
    # but cannot inflate the task score or trigger gates by merely containing keywords.
    execution_context: str | None = Field(default=None, max_length=100_000)
    # Per-task workspace root for the agent tool loop. Without one the tools stay
    # disabled for this task — never a fallback to the server's cwd.
    workspace_root: str | None = None
    # Override `config.agent_tools` for this task: "off" disables the loop, any
    # profile name from `agent_tools.catalog.PROFILES` selects and enables it.
    agent_tools: str | None = None


class SubtaskExecution(BaseModel):
    subtask_id: str
    status: TaskStatus
    backend: Backend
    model_used: str
    latency_ms: int
    estimated_cost_usd: float
    output: str
    error: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    validation_iterations: int = 0
    # Selección terminal del perfil `doc`. Se conserva estructurada para que
    # Atlas pueda construir el handoff sin intentar extraer rutas del transcript.
    context_paths: list[str] = Field(default_factory=list)
    prepared_skills: list[str] = Field(default_factory=list)
    used_skills: list[str] = Field(default_factory=list)


class ValidationVerdict(BaseModel):
    """Structured feedback from the dedicated validator agent."""

    approved: bool
    feedback: str = ""
    iteration: int = 0
    validator_provider: str | None = None
    validator_model: str | None = None


class DelegationResult(BaseModel):
    task_id: str
    status: TaskStatus
    executions: list[SubtaskExecution]
    total_latency_ms: int
    total_estimated_cost_usd: float
    total_input_tokens: int = 0
    total_output_tokens: int = 0
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
    active_model: str = "sin asignar"
    provider: str = "sin proveedor"
    model_tier: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    token_budget: int = 0  # 0 = no subscription budget (free/local providers)
    estimated_cost: float = 0.0
    latency_ms: int = 0
    task_count: int = 0
    error_count: int = 0
    last_activity: str = ""
    confidence: float | None = None
    active_capabilities: list[str] = Field(default_factory=list)
    levels: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    skill_usage: dict[str, int] = Field(default_factory=dict)  # skill -> times this node used it
    extra: dict[str, Any] = Field(default_factory=dict)
    # Live availability (from the scheduler's in-memory tracker, not history).
    hierarchy_tier: int = 2
    max_concurrent: int = 1
    busy_slots: int = 0
    queue_depth: int = 0


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


class MetricsHistoryPoint(BaseModel):
    timestamp: datetime
    total_tasks: int
    total_estimated_cost_usd: float
    total_tokens: int = 0
    avg_latency_ms: int = 0


class MetricsHistory(BaseModel):
    points: list[MetricsHistoryPoint] = Field(default_factory=list)


class AgentPerformance(BaseModel):
    """Provider-keyed aggregation over `runs` — the stable replacement for the
    old fuzzy model-name/level-alias attribution in `monitoring._execution_owner`."""

    provider_name: str
    task_count: int
    error_count: int = 0
    avg_latency_ms: float | None = None
    total_cost: float = 0.0
    total_tokens: int = 0
