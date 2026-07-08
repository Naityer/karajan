from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import timezone, timedelta
from typing import Any


@dataclass(slots=True)
class ModelUsage:
    provider: str = ""
    model: str = ""
    input_tokens: int | None = 0
    output_tokens: int | None = 0
    total_estimated_cost_usd: float = 0.0
    latency_ms: float = 0.0
    calls: int = 1
    status: str = "completed"
    timestamp: str = ""

    def __post_init__(self) -> None: ...


def format_usage(usage: dict[str, Any]) -> str:
    """Format a dictionary of model usage records into a readable string.""[9D[K
string."""
    if not usage or not isinstance(usage, dict):
        return "No usage data available."

    items = []
    for key, value in sorted(usage.items(), key=lambda kv: kv[1].get("estim[16D[K
kv[1].get("estimated_cost", 0), reverse=True):
        item = ModelUsage(**value) if hasattr(value, "__dict__") else value[5D[K
value
        provider = getattr(item, "provider", "") or ""
        model = getattr(item, "model", "") or ""
        cost = getattr(item, "total_estimated_cost_usd", 0.0) or 0.0
        latency = getattr(item, "latency_ms", 0.0) or 0.0
        tokens_in = getattr(item, "input_tokens", 0) or 0
        tokens_out = getattr(item, "output_tokens", 0) or 0
        status = getattr(item, "status", "") or ""
        timestamp = getattr(item, "timestamp", "") or ""

        if cost > 0:
            items.append(
                f"Provider: {provider}\nModel: {model}\nCost: ${cost:.5f} U[1D[K
USD\nTokens In/Out: {tokens_in}/{tokens_out}\nLatency: {latency:.1f}ms | St[2D[K
Status: {status}"
            )

    return "\n".join(items) if items else "No usage data available."