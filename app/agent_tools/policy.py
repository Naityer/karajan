"""When the tool loop runs, with which profile, and on which workspace.

Three ANDed gates, so merging this changes nothing until someone opts in:

1. `config.agent_tools.enabled` (default False), or a per-request override.
2. A resolvable workspace root. **No root ⇒ no tools.** Never the process's
   working directory: that is the existing `claude-cli` defect, where the child
   inherits uvicorn's cwd and operates on KARAJAN's own source instead of the
   user's project.
3. The subtask actually being worth it — analysis-only work stays on the cheap
   one-shot path.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.agent_tools import catalog
from app.agent_tools.budget import RunBudget
from app.agent_tools.spec import RiskTier, ToolDenied
from app.agent_tools.workspace import Workspace
from app.models import AgentToolsConfig, KarajanConfig

_RISK_ORDER = {tier.value: index for index, tier in enumerate(
    (RiskTier.CONTROL, RiskTier.READ, RiskTier.WRITE, RiskTier.EXECUTE)
)}

DISABLE_KEYWORDS = {"off", "no", "false", "none", "disabled"}


@dataclass
class AgentPlan:
    """The decision, plus everything the session needs to act on it."""

    enabled: bool
    profile: str = ""
    workspace: Workspace | None = None
    reason: str = ""

    def budget(self, settings: AgentToolsConfig, max_cost_usd: float = 0.0) -> RunBudget:
        return RunBudget(
            max_turns=settings.max_turns,
            max_tool_calls=settings.max_tool_calls,
            max_wall_time_s=settings.max_wall_time_s,
            max_cost_usd=max_cost_usd,
        )


def resolve_workspace_root(
    settings: AgentToolsConfig, requested: str | None = None
) -> str | None:
    """Precedence: request → config → the CLI's remembered repo root → nothing."""
    if requested and requested.strip():
        return requested.strip()
    if settings.default_workspace_root:
        return settings.default_workspace_root
    try:
        from karajan_cli import userconfig  # optional: the CLI may not be installed

        remembered = userconfig.load().get("repo_root")
    except Exception:  # noqa: BLE001 - a missing/broken CLI config is not an error here
        remembered = None
    return remembered or None


def plan(
    config: KarajanConfig,
    *,
    requested_workspace: str | None = None,
    requested_profile: str | None = None,
) -> AgentPlan:
    """Decide whether this task runs agentically, and how."""
    settings = config.agent_tools

    override = (requested_profile or "").strip().lower()
    if override in DISABLE_KEYWORDS:
        return AgentPlan(False, reason="desactivado explicitamente en la peticion")

    profile = override or settings.profile
    if not (settings.enabled or override):
        return AgentPlan(False, reason="agent_tools.enabled=false")
    if profile not in catalog.PROFILES:
        return AgentPlan(
            False,
            reason=f"perfil de herramientas desconocido: '{profile}' (validos: {', '.join(catalog.profile_names())})",
        )

    root = resolve_workspace_root(settings, requested_workspace)
    if not root:
        return AgentPlan(
            False,
            reason="sin raiz de trabajo declarada; las herramientas quedan deshabilitadas "
            "(no se usa el directorio del servidor como sustituto)",
        )

    try:
        workspace = Workspace.open(root, dry_run=settings.dry_run, allow_self=settings.allow_karajan_repo)
    except ToolDenied as exc:
        return AgentPlan(False, reason=f"raiz de trabajo rechazada: {exc}")

    return AgentPlan(True, profile=profile, workspace=workspace)


def requires_human_review(profile: str, settings: AgentToolsConfig) -> bool:
    """Whether a run with this profile must be signed off before it executes.

    Feeds `classification.requires_human_review`, so the *existing*
    `_pre_execution_gate` withholds the run and the *existing*
    `POST /tasks/{id}/approve-review` releases it. No second gate, no new
    endpoint, no parallel semantics.
    """
    threshold = _RISK_ORDER.get((settings.require_approval_from_risk or "write").lower())
    if threshold is None:
        threshold = _RISK_ORDER["write"]
    return _RISK_ORDER[catalog.max_risk(profile).value] >= threshold
