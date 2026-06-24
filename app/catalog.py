from __future__ import annotations

from app.models import AuthMethod, Backend, ProviderInfo, RecommendedModel as RM

# Catalog of the main AI providers, free and paid. Static data only — no calls.
# `tiers` maps a logical complexity tier to the concrete model id for that provider.
_CATALOG: tuple[ProviderInfo, ...] = (
    # --- Local / free (CLI) ---
    ProviderInfo(
        name="ollama",
        label="Ollama (local)",
        is_free=True,
        auth_method=AuthMethod.LOCAL,
        backend=Backend.CLI,
        tiers={
            RM.CHEAP_MODEL: "llama3.2:3b",
            RM.CHEAP_OR_MEDIUM_MODEL: "llama3.1:8b",
            RM.MEDIUM_MODEL: "qwen2.5:14b",
            RM.STRONG_MODEL: "qwen2.5:32b",
            RM.STRONG_MODEL_WITH_HUMAN_REVIEW: "qwen2.5:32b",
        },
        endpoint="http://127.0.0.1:11434",
        signup_url="https://ollama.com/download",
        cli_command="ollama run {model}",
        login_command="ollama serve",
        probe_command="ollama list",
    ),
    ProviderInfo(
        name="aider",
        label="Aider (local pair-programming CLI)",
        is_free=True,
        auth_method=AuthMethod.CLI_LOGIN,
        backend=Backend.CLI,
        tiers={RM.MEDIUM_MODEL: "aider", RM.STRONG_MODEL: "aider"},
        signup_url="https://aider.chat",
        cli_command="aider --message {model}",
    ),
    ProviderInfo(
        name="claude-cli",
        label="Claude Code CLI (local)",
        is_free=False,
        auth_method=AuthMethod.CLI_LOGIN,
        backend=Backend.CLI,
        tiers={
            RM.MEDIUM_MODEL: "claude-haiku-4-5-20251001",
            RM.STRONG_MODEL: "claude-sonnet-4-6",
            RM.STRONG_MODEL_WITH_HUMAN_REVIEW: "claude-opus-4-8",
        },
        signup_url="https://claude.com/claude-code",
        cli_command="claude -p {model}",
        login_command="claude /login",
    ),
    ProviderInfo(
        name="codex",
        label="OpenAI Codex CLI (local)",
        is_free=False,
        auth_method=AuthMethod.CLI_LOGIN,
        backend=Backend.CLI,
        tiers={
            RM.MEDIUM_MODEL: "gpt-5-codex",
            RM.STRONG_MODEL: "gpt-5-codex",
            RM.STRONG_MODEL_WITH_HUMAN_REVIEW: "gpt-5-codex",
        },
        signup_url="https://developers.openai.com/codex/cli",
        cli_command="codex exec {model}",
        login_command="codex login",
    ),
    # --- Cloud API (paid, some free tiers) ---
    ProviderInfo(
        name="anthropic",
        label="Anthropic (Claude)",
        is_free=False,
        auth_method=AuthMethod.API_KEY,
        backend=Backend.API,
        tiers={
            RM.CHEAP_MODEL: "claude-haiku-4-5-20251001",
            RM.CHEAP_OR_MEDIUM_MODEL: "claude-haiku-4-5-20251001",
            RM.MEDIUM_MODEL: "claude-sonnet-4-6",
            RM.STRONG_MODEL: "claude-opus-4-8",
            RM.STRONG_MODEL_WITH_HUMAN_REVIEW: "claude-opus-4-8",
        },
        endpoint="https://api.anthropic.com",
        signup_url="https://console.anthropic.com",
        env_var="ANTHROPIC_API_KEY",
    ),
    ProviderInfo(
        name="openai",
        label="OpenAI (GPT)",
        is_free=False,
        auth_method=AuthMethod.API_KEY,
        backend=Backend.API,
        tiers={
            RM.CHEAP_MODEL: "gpt-4o-mini",
            RM.CHEAP_OR_MEDIUM_MODEL: "gpt-4o-mini",
            RM.MEDIUM_MODEL: "gpt-4o",
            RM.STRONG_MODEL: "gpt-4o",
            RM.STRONG_MODEL_WITH_HUMAN_REVIEW: "gpt-4o",
        },
        endpoint="https://api.openai.com",
        signup_url="https://platform.openai.com",
        env_var="OPENAI_API_KEY",
    ),
    ProviderInfo(
        name="google",
        label="Google (Gemini)",
        is_free=True,  # generous free tier
        auth_method=AuthMethod.API_KEY,
        backend=Backend.API,
        tiers={
            RM.CHEAP_MODEL: "gemini-2.0-flash",
            RM.CHEAP_OR_MEDIUM_MODEL: "gemini-2.0-flash",
            RM.MEDIUM_MODEL: "gemini-2.0-flash",
            RM.STRONG_MODEL: "gemini-2.0-pro",
            RM.STRONG_MODEL_WITH_HUMAN_REVIEW: "gemini-2.0-pro",
        },
        endpoint="https://generativelanguage.googleapis.com",
        signup_url="https://aistudio.google.com",
        env_var="GOOGLE_API_KEY",
    ),
    ProviderInfo(
        name="groq",
        label="Groq (free, fast inference)",
        is_free=True,
        auth_method=AuthMethod.API_KEY,
        backend=Backend.API,
        tiers={
            RM.CHEAP_MODEL: "llama-3.1-8b-instant",
            RM.CHEAP_OR_MEDIUM_MODEL: "llama-3.1-8b-instant",
            RM.MEDIUM_MODEL: "llama-3.3-70b-versatile",
            RM.STRONG_MODEL: "llama-3.3-70b-versatile",
            RM.STRONG_MODEL_WITH_HUMAN_REVIEW: "llama-3.3-70b-versatile",
        },
        endpoint="https://api.groq.com",
        signup_url="https://console.groq.com",
        env_var="GROQ_API_KEY",
    ),
    ProviderInfo(
        name="mistral",
        label="Mistral AI",
        is_free=False,
        auth_method=AuthMethod.API_KEY,
        backend=Backend.API,
        tiers={
            RM.CHEAP_MODEL: "mistral-small-latest",
            RM.CHEAP_OR_MEDIUM_MODEL: "mistral-small-latest",
            RM.MEDIUM_MODEL: "mistral-medium-latest",
            RM.STRONG_MODEL: "mistral-large-latest",
            RM.STRONG_MODEL_WITH_HUMAN_REVIEW: "mistral-large-latest",
        },
        endpoint="https://api.mistral.ai",
        signup_url="https://console.mistral.ai",
        env_var="MISTRAL_API_KEY",
    ),
)

_BY_NAME = {provider.name: provider for provider in _CATALOG}


def all_providers() -> list[ProviderInfo]:
    return list(_CATALOG)


def get_provider(name: str) -> ProviderInfo | None:
    return _BY_NAME.get(name)


def providers_for_backend(backend: Backend) -> list[ProviderInfo]:
    return [p for p in _CATALOG if p.backend == backend]
