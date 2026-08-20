"""Contratos que la capa de API consume y la de persistencia implementa."""

from app.core.contracts.repositories import (
    AnalyticsRepository,
    ConfigRepository,
    ResourceRepository,
    RoutingRepository,
    TaskRepository,
)

__all__ = [
    "AnalyticsRepository",
    "ConfigRepository",
    "ResourceRepository",
    "RoutingRepository",
    "TaskRepository",
]
