from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

_CANVAS_FIELD_NAMES = ("entities", "groups", "zoom", "drawer_width", "openclaw_pos", "rules")


from .tasks import _utcnow, ComplexityLevel, RecommendedModel, TaskStatus, TaskV2Status, Backend, AuthMethod, Profile, CriteriaScores, TaskRequest, Subtask, ResourceRecommendationContext, ClassificationResult, IngestRequest, DelegationRequest, SubtaskExecution, ValidationVerdict, DelegationResult, TaskRecord, Metrics, NodeMetrics, FlowEvent, ModelUsage, SystemHealth, ObservabilitySnapshot, MetricsHistoryPoint, MetricsHistory, AgentPerformance
from .execution import RunInfo, RunEventInfo, ArtifactInfo, ContextPackRequest, ContextPackSummary, ContextPackDetail, DocResultRequest, AgentToolsConfig, ToolParamInfo, ToolSpecInfo, ToolProfileInfo
from .providers import SetupStatus, SetupTutorial, HealthStatus, ProviderInfo, CredentialStatus, ProviderSetup, ProviderRunRequest, ProviderRunResult, DefaultConfigApplyResult, SkillInfo, SkillInstallResult, OpenClawConfig, OpenClawSetupCommand, OpenClawStatus, OpenClawSkillInfo, OpenClawChannelInfo, OpenClawInstallRequest, OpenClawUpdateRequest, OpenClawOperationResult, OpenClawDaemonStatus, OpenClawPluginInfo, OpenClawPluginInstallRequest


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


class RoutingRule(BaseModel):
    """Domain rule of a profile: when a subtask matches it, its entity runs the subtask.

    Rules are evaluated in order and the first enabled match wins; when none matches,
    dispatch falls back to the usual level/tier resolution. Empty lists and missing
    bounds mean "any". `domains` is matched against the classification domains plus
    the routing areas (`frontend`, `backend`, `oficina`) detected in the prompt.
    A rule whose entity no longer exists is ignored at runtime (never rejected), so
    editing the canvas without knowing about rules can't break a save.
    """

    id: str = Field(min_length=1, max_length=80)
    name: str = ""
    entity_id: str
    domains: list[str] = Field(default_factory=list)
    intents: list[str] = Field(default_factory=list)
    level_min: int | None = Field(default=None, ge=1, le=5)
    level_max: int | None = Field(default=None, ge=1, le=5)
    enabled: bool = True


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
    # Qué hace el perfil, en una frase (la enseña el selector de perfiles de Atlas dev).
    description: str = Field(default="", max_length=600)
    entities: list[RoutingEntity] = Field(default_factory=list)
    groups: list[HierarchyGroup] = Field(default_factory=list)
    zoom: float = Field(default=1.0, ge=0.15, le=2.0)
    drawer_width: int = Field(default=320, ge=220, le=680)
    openclaw_pos: CanvasPoint = Field(default_factory=CanvasPoint)
    rules: list[RoutingRule] = Field(default_factory=list)

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
    rules: list[RoutingRule] = Field(default_factory=list)
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

    def preserve_rules_from(self, previous: "RoutingLayout | None") -> "RoutingLayout":
        """Keep the saved rules of profiles that arrive without a `rules` key.

        Clients that predate rules (the native Decisión canvas) rebuild profiles
        with only their canvas fields; without this, every autosave would wipe the
        domain rules configured elsewhere (e.g. from Atlas dev).
        """
        if previous is None:
            return self
        saved = {profile.id: profile.rules for profile in previous.profiles}
        self.profiles = [
            profile if "rules" in profile.model_fields_set or profile.id not in saved
            else profile.model_copy(update={"rules": deepcopy(saved[profile.id])})
            for profile in self.profiles
        ]
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
