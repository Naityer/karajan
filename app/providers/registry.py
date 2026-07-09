from __future__ import annotations

from dataclasses import dataclass

from app import catalog
from app.models import Backend, KarajanConfig, ProviderInfo, RecommendedModel, RoutingEntity, RoutingLayout
from app.providers.api import ApiModelProvider
from app.providers.base import ModelProvider
from app.providers.cli import CliModelProvider
from app.providers.simulated import SimulatedModelProvider


@dataclass
class Resolution:
    provider: ModelProvider
    backend: Backend
    model_id: str
    provider_name: str


def resolve(tier: RecommendedModel, config: KarajanConfig) -> Resolution:
    """Pick the concrete provider + model id for a logical tier under `config`.

    Falls back to the simulated backend whenever no real provider is configured,
    so the harness always produces a result.
    """
    if config.backend == Backend.SIMULATED:
        return _simulated(tier)

    info = _provider_for_tier(tier, config)
    if info is None:
        return _simulated(tier)

    model_id = info.tiers.get(tier) or next(iter(info.tiers.values()), tier.value)
    if info.backend == Backend.API:
        return Resolution(ApiModelProvider(info), Backend.API, model_id, info.name)
    if info.backend == Backend.CLI:
        return Resolution(CliModelProvider(info), Backend.CLI, model_id, info.name)
    return _simulated(tier)


def fallback_resolutions(
    tier: RecommendedModel,
    config: KarajanConfig,
    tried_provider_names: set[str] | None = None,
    layout: RoutingLayout | None = None,
) -> list[Resolution]:
    """Return safe fallback providers for a failed runtime execution.

    Providers explicitly marked `role="backup"` in the routing layout (e.g. an
    OpenAI node backing up the Claude parent) are tried first, paid or not —
    that's an explicit operator decision, not an automatic one. After that,
    only free catalog providers are attempted automatically. The deterministic
    simulated provider is always last so delegation can still finish and record
    the fallback chain without spending money or requiring credentials.
    """
    tried = set(tried_provider_names or set())
    candidates: list[Resolution] = []
    from app import credentials  # local import avoids cycles and keeps detection lazy

    statuses = {status.provider: status for status in credentials.detect_all()}

    backup_names = [
        entity.provider
        for entity in (layout.entities if layout else [])
        if entity.provider and entity.role.strip().lower() == "backup"
    ]
    for name in backup_names:
        if name in tried:
            continue
        info = catalog.get_provider(name)
        status = statuses.get(name)
        if not info or tier not in info.tiers or not (status and status.ready):
            continue
        model_id = info.tiers.get(tier) or next(iter(info.tiers.values()), tier.value)
        if info.backend == Backend.API:
            candidates.append(Resolution(ApiModelProvider(info), Backend.API, model_id, info.name))
        elif info.backend == Backend.CLI:
            candidates.append(Resolution(CliModelProvider(info), Backend.CLI, model_id, info.name))
        tried.add(name)

    for info in catalog.all_providers():
        status = statuses.get(info.name)
        if not info.is_free or info.name in tried or tier not in info.tiers or not (status and status.ready):
            continue
        model_id = info.tiers.get(tier) or next(iter(info.tiers.values()), tier.value)
        if info.backend == Backend.API:
            candidates.append(Resolution(ApiModelProvider(info), Backend.API, model_id, info.name))
        elif info.backend == Backend.CLI:
            candidates.append(Resolution(CliModelProvider(info), Backend.CLI, model_id, info.name))

    if "simulated" not in tried:
        candidates.append(_simulated(tier))
    return candidates


def eligible_entities(level: str, layout: RoutingLayout | None) -> list[RoutingEntity]:
    """Every layout entity genuinely able to serve `level` (a "level_*" string).

    Unlike `flow_policy._owner_for_level` (which stops at the first match for
    audit-log attribution), this returns ALL matches — the real candidate pool
    a scheduler picks a *free* agent from, including entities with several
    `levels` entries (a real "multi-level worker").
    """
    from app import flow_policy  # local import avoids a cycle at module load time

    regular_roles = {"parent", "agent", "child", "worker"}
    entities = layout.entities if layout else []
    return [
        entity
        for entity in entities
        if entity.role.strip().lower() in regular_roles and flow_policy.level_matches(entity.levels, level)
    ]


def candidate_tiers(entities: list[RoutingEntity]) -> list[int]:
    """Distinct hierarchy tiers among `entities`, ascending, with tier 0 (root)
    moved to the end — root is the last-resort escalation target, not the
    first pick, mirroring the existing `fallback_resolutions` ordering."""
    tiers = sorted({entity.tier for entity in entities})
    return sorted(tiers, key=lambda tier: (tier == 0, tier))


def resolve_entity(entity: RoutingEntity, tier: RecommendedModel) -> Resolution | None:
    """Build a concrete `Resolution` for one specific layout entity.

    Returns `None` when the entity's provider is unknown to the catalog or
    doesn't support `tier` — callers should skip such entities rather than
    falling back to the simulated backend (that fallback is `resolve()`'s job
    for the static/tier-pinned path, not this per-entity lookup).
    """
    if not entity.provider:
        return None
    info = catalog.get_provider(entity.provider)
    if info is None or tier not in info.tiers:
        return None
    model_id = info.tiers[tier]
    if info.backend == Backend.API:
        return Resolution(ApiModelProvider(info), Backend.API, model_id, info.name)
    if info.backend == Backend.CLI:
        return Resolution(CliModelProvider(info), Backend.CLI, model_id, info.name)
    return None


def resolve_by_name(provider_name: str, tier: RecommendedModel) -> Resolution | None:
    """Build a concrete `Resolution` for a catalog provider looked up by name.

    Picks the provider's model for `tier`, or its first available tier if that
    exact tier is unmapped. Returns None when the provider is unknown or exposes
    no runnable tier. Thin wrapper over the same API/CLI machinery as
    `resolve_entity` — the Grafo explain/audit path resolves the workspace's
    `graph_agent_provider` (or a repo override) through here rather than the
    tier-pinned classification path.
    """
    info = catalog.get_provider(provider_name)
    if info is None:
        return None
    model_id = info.tiers.get(tier) or next(iter(info.tiers.values()), None)
    if model_id is None:
        return None
    if info.backend == Backend.API:
        return Resolution(ApiModelProvider(info), Backend.API, model_id, info.name)
    if info.backend == Backend.CLI:
        return Resolution(CliModelProvider(info), Backend.CLI, model_id, info.name)
    return None


def _provider_for_tier(tier: RecommendedModel, config: KarajanConfig) -> ProviderInfo | None:
    # Explicit preference from auto-detect / pro config wins.
    preferred = config.provider_preferences.get(tier.value)
    if preferred:
        info = catalog.get_provider(preferred)
        if info and tier in info.tiers:
            return info
    # Otherwise first catalog provider on the active backend that supports the tier.
    for info in catalog.providers_for_backend(config.backend):
        if tier in info.tiers:
            return info
    return None


def _simulated(tier: RecommendedModel) -> Resolution:
    return Resolution(SimulatedModelProvider(), Backend.SIMULATED, tier.value, "simulated")
