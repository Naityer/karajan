from __future__ import annotations

from dataclasses import dataclass

from app import catalog
from app.models import Backend, KarajanConfig, ProviderInfo, RecommendedModel
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
