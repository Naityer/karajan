from __future__ import annotations

from app.models import KarajanConfig
from app.providers.base import ProviderRun
from app.providers.registry import Resolution

"""Backend-agnostic execution helpers shared by the synchronous delegation path
(`app/delegation.py`) and the async availability-driven scheduler
(`app/scheduler.py`). Kept dependency-free of both so neither has to import the
other.
"""


def estimate_tokens(text: str) -> int:
    """Rough ~4-chars-per-token estimate for dashboard display — not a real
    tokenizer count, just enough to drive the Monitor view's token rings."""
    return max(0, len(text) // 4)


def run_with_retries(
    resolution: Resolution,
    instruction: str,
    config: KarajanConfig,
) -> ProviderRun:
    retries = config.orchestration.max_retries
    run = resolution.provider.run(instruction, resolution.model_id, config.orchestration.subtask_timeout_s)
    attempts = 0
    while run.error and attempts < retries:
        attempts += 1
        run = resolution.provider.run(instruction, resolution.model_id, config.orchestration.subtask_timeout_s)
    return run


def cost_for(tier: str, complexity: int, config: KarajanConfig) -> float:
    return round(config.cost_table.get(tier, 0.0) * complexity, 5)


def latency_for(tier: str, run: ProviderRun, config: KarajanConfig, index: int) -> int:
    # Real backends report measured latency; simulated returns 0 → use the config table.
    return run.latency_ms or (config.latency_table.get(tier, 0) + index * 37)
