from __future__ import annotations

from app.models import Backend
from app.providers.base import ModelProvider, ProviderRun


class SimulatedModelProvider(ModelProvider):
    """Deterministic, offline provider. Default for tests and demos (no cost)."""

    backend = Backend.SIMULATED

    def run(self, instruction: str, model_id: str, timeout_s: int) -> ProviderRun:
        return ProviderRun(
            output=f"[simulated:{model_id}] {instruction}",
            model_used=f"simulated:{model_id}",
            latency_ms=0,  # delegation engine fills latency from config table
        )
