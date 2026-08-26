"""Errores de aplicación independientes de cualquier transporte."""

from __future__ import annotations


class KarajanApplicationError(RuntimeError):
    pass


class TaskNotFoundError(KarajanApplicationError):
    pass


class ConflictError(KarajanApplicationError):
    pass


class BudgetExceededError(ConflictError):
    pass


class HostedModeRequiredError(KarajanApplicationError):
    pass


class ProviderUnavailableError(KarajanApplicationError):
    pass


class DeadlineExceededError(KarajanApplicationError):
    pass


class AuthorizationDeniedError(KarajanApplicationError):
    pass


class InvalidOverrideError(KarajanApplicationError):
    pass


class OutcomeUnknownError(KarajanApplicationError):
    pass
