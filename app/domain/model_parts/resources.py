from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


from .tasks import _utcnow, ComplexityLevel, RecommendedModel, TaskStatus, TaskV2Status, Backend, AuthMethod, Profile, CriteriaScores, TaskRequest, Subtask, ResourceRecommendationContext, ClassificationResult, IngestRequest, DelegationRequest, SubtaskExecution, ValidationVerdict, DelegationResult, TaskRecord, Metrics, NodeMetrics, FlowEvent, ModelUsage, SystemHealth, ObservabilitySnapshot, MetricsHistoryPoint, MetricsHistory, AgentPerformance
from .execution import RunInfo, RunEventInfo, ArtifactInfo, ContextPackRequest, ContextPackSummary, ContextPackDetail, DocResultRequest, AgentToolsConfig, ToolParamInfo, ToolSpecInfo, ToolProfileInfo
from .providers import SetupStatus, SetupTutorial, HealthStatus, ProviderInfo, CredentialStatus, ProviderSetup, ProviderRunRequest, ProviderRunResult, DefaultConfigApplyResult, SkillInfo, SkillInstallResult, OpenClawConfig, OpenClawSetupCommand, OpenClawStatus, OpenClawSkillInfo, OpenClawChannelInfo, OpenClawInstallRequest, OpenClawUpdateRequest, OpenClawOperationResult, OpenClawDaemonStatus, OpenClawPluginInfo, OpenClawPluginInstallRequest
from .routing import GroupMembership, HierarchyGroup, CanvasPoint, RoutingEntity, RoutingRule, _reject_duplicate_group_prio, RoutingProfile, RoutingLayout, OrchestrationConfig, PolicyConfig, KarajanConfig, DecisionLogEntry, ErrorResponse


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
