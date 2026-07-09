from __future__ import annotations

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
    # Force delegation to one named catalog provider or routing entity, bypassing
    # the tier-based routing in `flow_policy`/`registry.resolve`. Applies to the
    # whole task (every subtask), not per-subtask. Pass at most one of the two.
    force_provider: str | None = None
    force_entity_id: str | None = None


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
    active_model: str = "auto / simulado"
    provider: str = "simulated"
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


# --- Provider catalog & credentials -----------------------------------------


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


class GroupMembership(BaseModel):
    """An entity's membership in one `HierarchyGroup`, carrying its own Prio.

    Prio drives dispatch order: the lower the number, the higher the priority
    (Prio 1 is tried before Prio 2). Within a single group no two members may
    claim the same Prio — enforced across the whole layout by
    `RoutingLayout._reject_duplicate_group_prio`.
    """

    group_id: str
    prio: int = Field(ge=1)


class HierarchyGroup(BaseModel):
    """A named, colored container that agents can join (via `GroupMembership`).

    Orthogonal to `RoutingEntity.levels` (task-complexity axis). A group is a
    draggable node on the Decisión canvas; `x`/`y` mirror the entity coordinate
    convention. `color` is a UI tint (typically `#rrggbb` from a color picker).
    """

    id: str
    name: str
    color: str
    x: float = 0
    y: float = 0


class CanvasPoint(BaseModel):
    x: float = 0
    y: float = 0


class RoutingEntity(BaseModel):
    id: str
    name: str | None = None
    role: str
    role_tags: list[str] = Field(default_factory=list)
    provider: str | None = None
    parentId: str | None = ""
    target_ids: list[str] = Field(default_factory=list)  # guardian/validator: the entities it supervises/validates
    levels: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    capabilities: list[str] = Field(default_factory=list)
    # Hierarchy-group memberships. When non-empty, they drive dispatch order via
    # `effective_tier()` and override the raw `tier` fallback below.
    memberships: list[GroupMembership] = Field(default_factory=list)
    # Open-ended hierarchy/authority depth — 0=root, 1=L1, 2=L2, 3+=future growth.
    # Orthogonal to `levels` (task-complexity axis, fixed at 5 values).
    # Backward-compat fallback for entities with no group memberships.
    tier: int = Field(default=2, ge=0)
    max_concurrent: int = Field(default=1, ge=1)
    x: float = 0
    y: float = 0

    def effective_tier(self) -> int:
        """Dispatch tier actually used by the scheduler.

        An entity with group memberships is scheduled by the lowest (highest-
        priority) Prio number among its groups; an ungrouped entity falls back
        to its raw `tier`, so legacy behavior is preserved exactly.
        """
        if self.memberships:
            return min(m.prio for m in self.memberships)
        return self.tier

    @model_validator(mode="before")
    @classmethod
    def _migrate_legacy_target_id(cls, data: object) -> object:
        # Self-heals old JSON that predates the 1-to-N `target_ids`: an existing
        # single `target_id` string is folded into `target_ids` so upgrading
        # doesn't silently drop the saved supervision/validation association.
        if isinstance(data, dict) and not data.get("target_ids"):
            legacy = data.get("target_id")
            if legacy:
                data = {**data, "target_ids": [legacy]}
        return data

    @model_validator(mode="after")
    def _default_tier_by_role(self) -> "RoutingEntity":
        # Self-heals old JSON that predates `tier`: parent/backup entities default
        # to root (0) unless the file already set it explicitly.
        if "tier" not in self.model_fields_set and self.role.strip().lower() in {"parent", "backup"}:
            self.tier = 0
        return self


class RoutingLayout(BaseModel):
    entities: list[RoutingEntity] = Field(default_factory=list)
    groups: list[HierarchyGroup] = Field(default_factory=list)
    zoom: float = Field(default=1.0, ge=0.15, le=2.0)
    drawer_width: int = Field(default=320, ge=220, le=680)
    openclaw_pos: CanvasPoint = Field(default_factory=CanvasPoint)
    updated_at: datetime = Field(default_factory=_utcnow)

    @model_validator(mode="after")
    def _reject_duplicate_group_prio(self) -> "RoutingLayout":
        # Defense in depth: within one group, no two members may claim the same
        # Prio. Checked across ALL entities' memberships combined so an invalid
        # state can never be silently persisted (the frontend also prevents it).
        seen: dict[tuple[str, int], str] = {}
        for entity in self.entities:
            for membership in entity.memberships:
                key = (membership.group_id, membership.prio)
                if key in seen:
                    raise ValueError(
                        f"Duplicate Prio {membership.prio} in group '{membership.group_id}': "
                        f"claimed by both entity '{seen[key]}' and entity '{entity.id}'"
                    )
                seen[key] = entity.id
        return self


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
    # Async availability-driven queue (opt-in; "sync" preserves today's behavior).
    dispatch_mode: Literal["sync", "queue"] = "sync"
    # Real second-call validation loop (opt-in; off preserves today's logged-verdict behavior).
    enable_validator_loop: bool = False
    max_validation_iterations: int = Field(default=2, ge=0, le=5)
    escalate_to_root_after_max_iterations: bool = True


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
    # Workspace-default provider (a catalog `name`, e.g. "claude-cli"/"ollama-qwen")
    # used by the Grafo window's LLM explain/audit. Resolution order for a repo:
    # repo.provider_override -> this -> provider_preferences["medium_model"] -> first ready.
    graph_agent_provider: str | None = None
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


# --- Predictive analytics (Fase 4) -------------------------------------------


class PredictTaskRequest(BaseModel):
    """A draft task profile for prediction — the fields a caller already holds
    right after classify-task and before delegate-task.

    Deliberately shaped after `ClassificationResult` (same `domain`/`intent`/
    `criteria`/`complexity_score` fields) so it can be called mid-flow with the
    classification output, plus the routing hints (`provider_name`/`model_id`/
    `backend`) the caller is about to delegate to.
    """

    task_type: str | None = None  # falls back to `intent` when omitted
    domain: list[str] = Field(default_factory=lambda: ["general"])
    intent: str = "classify_and_plan"
    criteria: CriteriaScores
    complexity_score: float = Field(default=0.0, ge=0, le=5)
    provider_name: str | None = None
    model_id: str | None = None
    backend: str | None = None
    prompt_length: int | None = Field(default=None, ge=0)
    subtask_count: int | None = Field(default=None, ge=0)


class PredictTaskResponse(BaseModel):
    predicted_success_prob: float | None = None
    predicted_cost_usd: float | None = None
    predicted_latency_ms: float | None = None
    is_anomaly: bool = False
    top_features: list[dict[str, Any]] = Field(default_factory=list)


# --- Graph / multi-repo -------------------------------------------------------


class RepoConfig(BaseModel):
    """A registered repository tracked by the multi-repo code graph.

    In this phase a repo is pure metadata: no static analysis has run yet, so
    scan-related fields stay unset until a later phase populates them.
    """

    id: str = Field(default_factory=lambda: f"repo_{uuid4().hex[:12]}")
    name: str
    root_path: str  # resolved absolute path, so later path-safety checks are reliable
    language_hint: str | None = None
    provider_override: str | None = None
    exclude_globs: list[str] = Field(default_factory=list)
    created_at: str = Field(default_factory=lambda: _utcnow().isoformat())
    last_scanned_at: str | None = None
    last_scan_status: str | None = None


class RepoCreateRequest(BaseModel):
    """Payload to register a new repository (POST /repos)."""

    name: str
    root_path: str
    language_hint: str | None = None
    provider_override: str | None = None
    exclude_globs: list[str] = Field(default_factory=list)


class GraphNode(BaseModel):
    """A single node in a repo's code graph (repo/dir/file/class/function/method).

    Symbol-level nodes (class/function/method) carry rough health metrics
    (`loc`, `complexity_estimate`, `method_count`) that later phases turn into
    findings. `extraction_method` records how a node was recovered so the
    frontend can show a reduced-confidence badge on regex-extracted TS nodes.
    """

    id: str
    repo_id: str
    file_id: str | None = None
    kind: str  # repo | dir | file | class | function | method
    name: str | None = None
    qualified_name: str | None = None
    parent_id: str | None = None
    start_line: int | None = None
    end_line: int | None = None
    method_count: int | None = None
    loc: int | None = None
    complexity_estimate: int | None = None
    extraction_method: str | None = None  # "ast" | "tree_sitter" | "regex" | None


class GraphEdge(BaseModel):
    """A directed edge between two nodes (`contains` structural / `imports`).

    `dst_node_id` is set when the target resolves to an internal node; otherwise
    `dst_unresolved` keeps the raw specifier (external package or unresolved
    alias) so nothing is silently dropped.
    """

    id: str
    repo_id: str
    src_node_id: str
    dst_node_id: str | None = None
    edge_type: str  # contains | imports
    dst_unresolved: str | None = None


class GraphSnapshot(BaseModel):
    """The full node+edge set for one repo — powers the frontend graph fetch."""

    repo_id: str
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)
    generated_at: str = Field(default_factory=lambda: _utcnow().isoformat())


class ScanSummary(BaseModel):
    """Result of a `scan_repo` run, returned by POST /repos/{id}/scan."""

    repo_id: str
    files_scanned: int = 0
    files_skipped_unchanged: int = 0
    nodes_created: int = 0
    edges_created: int = 0
    duration_ms: int = 0
    errors: list[str] = Field(default_factory=list)


class RepoFileResponse(BaseModel):
    """Source file content for the embedded graph editor."""

    repo_id: str
    path: str
    content: str
    encoding: str = "utf-8"
    size: int = 0
    modified_at: str | None = None


class RepoFileSaveRequest(BaseModel):
    """Payload to save a repo-relative source file from the embedded editor."""

    path: str
    content: str


class RepoFileSaveResponse(BaseModel):
    """Confirmation for a source file save."""

    repo_id: str
    path: str
    saved: bool = True
    size: int = 0
    modified_at: str | None = None


# --- Code audit (Fase D) ------------------------------------------------------


class Finding(BaseModel):
    """One deterministic (or LLM-flagged) issue attached to a graph node.

    Mirrors the `graph_findings` table columns. `severity` is one of
    info|warning|critical; `node_id` is the graph node the finding attaches to
    (a file node for file-level detectors, a symbol node otherwise).
    """

    id: str = Field(default_factory=lambda: f"find_{uuid4().hex[:12]}")
    repo_id: str
    node_id: str | None = None
    severity: str  # info | warning | critical
    category: str
    message: str
    detector: str
    created_at: str = Field(default_factory=lambda: _utcnow().isoformat())
    resolved: int = 0


class AuditResult(BaseModel):
    """Outcome of `run_audit`: deterministic findings + optional LLM narrative."""

    repo_id: str
    findings: list[Finding] = Field(default_factory=list)
    counts_by_severity: dict[str, int] = Field(default_factory=dict)
    llm_summary: str | None = None
    truncated: bool = False
    generated_at: str = Field(default_factory=lambda: _utcnow().isoformat())


class AuditRequest(BaseModel):
    """Payload for POST /repos/{id}/audit."""

    include_llm: bool = False


class FixFindingRequest(BaseModel):
    """Request to delegate a graph finding to the Fixer role/agent."""

    finding_id: str
    finding_ids: list[str] = Field(default_factory=list)
    apply: bool = True
    mode: str = "single"
    rerun_audit: bool = False
    report: str | None = None


class FixFindingResult(BaseModel):
    """Result of a Fixer attempt for one graph finding."""

    repo_id: str
    finding_id: str
    applied: bool = False
    verified: bool = False
    provider: str | None = None
    model: str | None = None
    file_path: str | None = None
    severity: str | None = None
    detector: str | None = None
    message: str = ""
    error: str | None = None
    summary: str | None = None
    attempted_count: int = 1
    resolved_count: int = 0


class ExplainRequest(BaseModel):
    """Payload for POST /repos/{id}/explain."""

    node_id: str


class ExplainResult(BaseModel):
    """Response of POST /repos/{id}/explain (LLM-backed, not persisted)."""

    explanation: str | None = None
    provider: str | None = None
    model: str | None = None
    error: str | None = None
