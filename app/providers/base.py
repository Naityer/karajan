from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from app.models import Backend


@dataclass
class ProviderRun:
    """Raw result of running one instruction against a concrete model."""

    output: str
    model_used: str
    latency_ms: int
    error: str | None = None


class ModelProvider(ABC):
    backend: Backend

    @abstractmethod
    def run(self, instruction: str, model_id: str, timeout_s: int) -> ProviderRun:
        """Execute a single bounded instruction and return its result."""
