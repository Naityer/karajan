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
    # Stable Biblioteca references. ``skills``/``capabilities`` remain the
    # routing projection used by older clients; this list is the canonical
    # link back to catalog records.
    resource_ids: list[str] = Field(default_factory=list)
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


_CANVAS_FIELD_NAMES = ("entities", "groups", "zoom", "drawer_width", "openclaw_pos")


def _reject_duplicate_group_prio(entities: list[RoutingEntity]) -> None:
    seen: dict[tuple[str, int], str] = {}
    for entity in entities:
        for membership in entity.memberships:
            key = (membership.group_id, membership.prio)
            if key in seen:
                raise ValueError(
                    f"Duplicate Prio {membership.prio} in group '{membership.group_id}': "
                    f"claimed by both entity '{seen[key]}' and entity '{entity.id}'"
                )
            seen[key] = entity.id


class RoutingProfile(BaseModel):
    """One named, independently editable canvas inside the decision view."""

    id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    name: str = Field(min_length=1, max_length=100)
    entities: list[RoutingEntity] = Field(default_factory=list)
    groups: list[HierarchyGroup] = Field(default_factory=list)
    zoom: float = Field(default=1.0, ge=0.15, le=2.0)
    drawer_width: int = Field(default=320, ge=220, le=680)
    openclaw_pos: CanvasPoint = Field(default_factory=CanvasPoint)

    @field_validator("id", "name")
    @classmethod
    def _strip_identity(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("profile id and name cannot be blank")
        return value

    @model_validator(mode="after")
    def _validate_group_priorities(self) -> "RoutingProfile":
        _reject_duplicate_group_prio(self.entities)
        return self


class RoutingLayout(BaseModel):
    entities: list[RoutingEntity] = Field(default_factory=list)
    groups: list[HierarchyGroup] = Field(default_factory=list)
    zoom: float = Field(default=1.0, ge=0.15, le=2.0)
    drawer_width: int = Field(default=320, ge=220, le=680)
    openclaw_pos: CanvasPoint = Field(default_factory=CanvasPoint)
    active_profile_id: str = "current"
    default_profile_id: str = "current"
    profiles: list[RoutingProfile] = Field(min_length=1)
    updated_at: datetime = Field(default_factory=_utcnow)

    @model_validator(mode="before")
    @classmethod
    def _migrate_legacy_canvas(cls, data: object) -> object:
        if not isinstance(data, dict):
            return data
        migrated = dict(data)
        if "profiles" not in migrated:
            profile = {
                "id": "current",
                "name": "Esquema actual",
                **{name: migrated.get(name) for name in _CANVAS_FIELD_NAMES if name in migrated},
            }
            migrated["profiles"] = [profile]
        if not migrated.get("default_profile_id"):
            profiles = migrated.get("profiles") or []
            first_profile_id = profiles[0].get("id") if profiles and isinstance(profiles[0], dict) else "current"
            migrated["default_profile_id"] = migrated.get("active_profile_id") or first_profile_id
        return migrated

    @model_validator(mode="after")
    def _reject_duplicate_group_prio(self) -> "RoutingLayout":
        # Defense in depth: within one group, no two members may claim the same
        # Prio. Checked across ALL entities' memberships combined so an invalid
        # state can never be silently persisted (the frontend also prevents it).
        _reject_duplicate_group_prio(self.entities)
        profile_ids = [profile.id for profile in self.profiles]
        if len(profile_ids) != len(set(profile_ids)):
            raise ValueError("routing profile ids must be unique")
        if self.active_profile_id not in profile_ids:
            raise ValueError(f"active routing profile '{self.active_profile_id}' does not exist")
        if self.default_profile_id not in profile_ids:
            raise ValueError(f"default routing profile '{self.default_profile_id}' does not exist")
        return self

    def active_profile(self) -> RoutingProfile:
        return next(profile for profile in self.profiles if profile.id == self.active_profile_id)

    def default_profile(self) -> RoutingProfile:
        return next(profile for profile in self.profiles if profile.id == self.default_profile_id)

    def project_active_profile(self) -> "RoutingLayout":
        active = self.active_profile()
        for name in _CANVAS_FIELD_NAMES:
            setattr(self, name, deepcopy(getattr(active, name)))
        return self

    def project_default_profile(self) -> "RoutingLayout":
        default = self.default_profile()
        for name in _CANVAS_FIELD_NAMES:
            setattr(self, name, deepcopy(getattr(default, name)))
        return self

    def reconcile_active_profile(self, changed_fields: set[str] | None = None) -> "RoutingLayout":
        changed = set(_CANVAS_FIELD_NAMES) if changed_fields is None else changed_fields
        active = self.active_profile()
        updates: dict[str, object] = {}
        for name in _CANVAS_FIELD_NAMES:
            if name in changed:
                updates[name] = getattr(self, name)
            else:
                setattr(self, name, deepcopy(getattr(active, name)))
        replacement = active.model_copy(update=updates, deep=True)
        self.profiles = [replacement if profile.id == active.id else profile for profile in self.profiles]
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
    # Local CLI providers first: they are the free ones, and `auto_detect` only
    # ever picks a provider that actually probed ready.
    backend: Backend = Backend.CLI
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
    agent_tools: AgentToolsConfig = Field(default_factory=AgentToolsConfig)
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


# --- Resource library -------------------------------------------------------


class ResourceKind(str, Enum):
    SKILL = "skill"
    CAPABILITY = "capability"
    REFERENCE = "reference"


class ResourceInstallation(BaseModel):
    target: Literal["claude", "codex"]
    path: str
    digest: str
    verified: bool = True
    installed_at: datetime = Field(default_factory=_utcnow)


class ResourceItem(BaseModel):
    """Persisted resource exposed by the Biblioteca API.

    The fields are intentionally data-oriented: callers can render and filter
    the catalog without importing installer implementations.
    """

    id: str = Field(default_factory=lambda: f"res_{uuid4().hex[:12]}")
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,119}$")
    name: str = Field(min_length=1, max_length=160)
    kind: ResourceKind
    source: str = Field(min_length=1, max_length=80)
    repo_url: str | None = None
    # Nested directories are modelled as ordinary resources linked to their
    # catalog parent.  ``source_url`` is the canonical page inspected for this
    # concrete entry (which may differ from a GitHub ``repo_url``).
    parent_resource_id: str | None = None
    source_url: str | None = None
    indexed_at: datetime | None = None
    index_status: Literal["active", "inactive", "error"] = "active"
    summary: str = Field(default="", max_length=4000)
    tags: list[str] = Field(default_factory=list)
    requirements: list[str] = Field(default_factory=list)
    capabilities: list[str] = Field(default_factory=list)
    compatible_runtimes: list[str] = Field(default_factory=list)
    install_strategy: str = "none"
    status: Literal["available", "installed", "partial", "error"] = "available"
    installations: list[ResourceInstallation] = Field(default_factory=list)
    visible_agent_ids: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)

    @field_validator("tags", "requirements", "capabilities", "compatible_runtimes", "visible_agent_ids")
    @classmethod
    def _clean_resource_lists(cls, values: list[str]) -> list[str]:
        return sorted({value.strip() for value in values if value and value.strip()}, key=str.casefold)


class ResourceCreateRequest(BaseModel):
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,119}$")
    name: str = Field(min_length=1, max_length=160)
    kind: ResourceKind
    source: str = Field(default="manual", min_length=1, max_length=80)
    repo_url: str | None = None
    parent_resource_id: str | None = None
    source_url: str | None = None
    indexed_at: datetime | None = None
    index_status: Literal["active", "inactive", "error"] = "active"
    summary: str = Field(default="", max_length=4000)
    tags: list[str] = Field(default_factory=list)
    requirements: list[str] = Field(default_factory=list)
    capabilities: list[str] = Field(default_factory=list)
    compatible_runtimes: list[str] = Field(default_factory=list)
    install_strategy: str = "none"
    metadata: dict[str, Any] = Field(default_factory=dict)
    # Single-use server ticket proving that a GitHub URL was inspected before
    # it can become installable. It is transport metadata, not persisted.
    analysis_token: str | None = None


class ResourceUpdateRequest(BaseModel):
    """Editorial fields that can be corrected after a safe scan."""

    name: str | None = Field(default=None, min_length=1, max_length=160)
    summary: str | None = Field(default=None, max_length=4000)
    tags: list[str] | None = None


class AnalyzeRequest(BaseModel):
    repo_url: str = Field(min_length=1, max_length=500)


class AnalyzeResult(BaseModel):
    valid: bool
    repo_url: str
    owner: str | None = None
    repository: str | None = None
    default_branch: str | None = None
    summary: str = ""
    skill_paths: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    preview: ResourceCreateRequest | None = None
    warnings: list[str] = Field(default_factory=list)
    analysis_token: str | None = None


class ResourceOperationRequest(BaseModel):
    action: Literal["install", "update", "verify", "uninstall"]
    targets: list[Literal["claude", "codex"]] = Field(default_factory=list)
    confirmed: bool = False


class ResourceVisibilityRequest(BaseModel):
    agent_ids: list[str] = Field(default_factory=list)

    @field_validator("agent_ids")
    @classmethod
    def _clean_agent_ids(cls, values: list[str]) -> list[str]:
        return sorted({value.strip() for value in values if value and value.strip()}, key=str.casefold)


class ResourceRecommendationRequest(BaseModel):
    """Prompt-to-resource decision request used by agents and the dashboard."""

    prompt: str = Field(min_length=3, max_length=20_000)
    runtime: str | None = Field(default=None, max_length=80)
    agent_id: str | None = Field(default=None, max_length=160)
    limit: int = Field(default=12, ge=1, le=50)
    include_complementary: bool = True


class ResourceIndexRequest(BaseModel):
    """Explicit confirmation for bounded, pre-query child indexing."""

    confirmed: bool = False


class ArtifactValidityPolicy(BaseModel):
    """Operator-owned acceptance policy for the Inspiration catalog."""

    version: int = Field(default=1, ge=1)
    stars_enabled: bool = True
    min_github_stars: int = Field(default=10_000, ge=0, le=100_000_000)
    require_source_url: bool = True
    require_detection_success: bool = True
    required_runtimes: list[Literal["claude", "codex"]] = Field(default_factory=lambda: ["claude", "codex"])
    require_web_reference: bool = True
    updated_at: datetime = Field(default_factory=_utcnow)

    @field_validator("required_runtimes")
    @classmethod
    def _clean_required_runtimes(cls, values: list[str]) -> list[str]:
        return [value for value in ("claude", "codex") if value in set(values)]


class ArtifactValidityPolicyImpactRequest(BaseModel):
    stars_enabled: bool = True
    min_github_stars: int = Field(default=10_000, ge=0, le=100_000_000)
    require_source_url: bool = True
    require_detection_success: bool = True
    required_runtimes: list[Literal["claude", "codex"]] = Field(default_factory=lambda: ["claude", "codex"])
    require_web_reference: bool = True


class ArtifactValidityPolicyUpdate(ArtifactValidityPolicyImpactRequest):
    expected_version: int = Field(ge=1)
    confirm_reset: bool = False


class ArtifactReviewDecisionRequest(BaseModel):
    decision: Literal["accept", "discard", "automatic"]


class ResourceRefreshSettingsUpdate(BaseModel):
    """Cadence for repository reanalysis and the Inspiration radar."""

    repository_enabled: bool = True
    repository_interval_days: int = Field(default=7, ge=1, le=90)
    radar_interval_minutes: int = Field(default=60, ge=15, le=1440)


class ResourceGroup(BaseModel):
    """Operator-owned classification node for the Inspiration catalog."""

    id: str = Field(default_factory=lambda: f"rgrp_{uuid4().hex[:12]}")
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=1000)
    parent_id: str | None = None
    sort_order: int = Field(default=0, ge=0, le=1_000_000)
    resource_ids: list[str] = Field(default_factory=list)

    @field_validator("name", "description", mode="before")
    @classmethod
    def _clean_group_text(cls, value: str) -> str:
        return value.strip() if isinstance(value, str) else value

    @field_validator("parent_id", mode="before")
    @classmethod
    def _clean_group_parent(cls, value: str | None) -> str | None:
        return value.strip() if isinstance(value, str) and value.strip() else None

    @field_validator("resource_ids")
    @classmethod
    def _clean_group_resources(cls, values: list[str]) -> list[str]:
        return sorted({value.strip() for value in values if value and value.strip()})

    @model_validator(mode="after")
    def _reject_self_parent(self) -> "ResourceGroup":
        if self.parent_id == self.id:
            raise ValueError("a resource group cannot be its own parent")
        return self


class ResourceGroupCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=1000)
    parent_id: str | None = None
    sort_order: int = Field(default=0, ge=0, le=1_000_000)

    @field_validator("name", "description", mode="before")
    @classmethod
    def _clean_group_create_text(cls, value: str) -> str:
        return value.strip() if isinstance(value, str) else value

    @field_validator("parent_id", mode="before")
    @classmethod
    def _clean_group_create_parent(cls, value: str | None) -> str | None:
        return value.strip() if isinstance(value, str) and value.strip() else None


class ResourceGroupUpdateRequest(ResourceGroupCreateRequest):
    pass


class ResourceGroupAssignmentsRequest(BaseModel):
    """Atomic resource-to-group changes; null removes the classification."""

    assignments: dict[str, str | None] = Field(default_factory=dict, max_length=500)

    @field_validator("assignments")
    @classmethod
    def _clean_group_assignments(cls, values: dict[str, str | None]) -> dict[str, str | None]:
        cleaned: dict[str, str | None] = {}
        for resource_id, group_id in values.items():
            resource_id = resource_id.strip()
            if not resource_id:
                raise ValueError("resource ids cannot be blank")
            cleaned[resource_id] = group_id.strip() if group_id and group_id.strip() else None
        return cleaned


class InspirationSourcePreference(BaseModel):
    """Operator choice for the allowlisted sources shown in Inspiration Radar."""

    source_ids: list[str] = Field(default_factory=list, max_length=12)

    @field_validator("source_ids")
    @classmethod
    def _clean_source_ids(cls, values: list[str]) -> list[str]:
        return sorted({value.strip() for value in values if value and value.strip()}, key=str.casefold)


class DiscoverySourceCreateRequest(BaseModel):
    """A followed account/publication/feed; never a library artifact."""

    url: str = Field(min_length=3, max_length=500)
    name: str | None = Field(default=None, max_length=160)
    enabled: bool = True


class DiscoverySource(BaseModel):
    id: str
    name: str
    url: str
    provider: str
    source_type: Literal["account", "publication", "feed", "community"] = "account"
    description: str = ""
    enabled: bool = True
    available: bool = False
    requires_credentials: bool = False
    setup_hint: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)


class ResourceOperationResult(BaseModel):
    operation_id: str
    resource_id: str | None = None
    action: str
    status: Literal["planned", "succeeded", "failed", "denied"]
    detail: str = ""
    targets: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=_utcnow)


class NaityerPreflight(BaseModel):
    component: str
    allowed: bool
    ready: bool
    launcher_path: str | None = None
    script_path: str | None = None
    powershell_path: str | None = None
    checks: dict[str, bool] = Field(default_factory=dict)
    detail: str = ""


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
