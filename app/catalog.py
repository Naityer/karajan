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
            RM.STRONG_MODEL: "deepseek-r1:32b",
            RM.STRONG_MODEL_WITH_HUMAN_REVIEW: "qwen2.5:32b",
        },
        endpoint="http://127.0.0.1:11434",
        signup_url="https://ollama.com/download",
        cli_command="ollama run {model}",
        login_command="ollama serve",
        probe_command="ollama list",
    ),
    ProviderInfo(
        # Production low-tier worker: best local-friendly size + community
        # track record for N1/N2 (cheap, cheap_or_medium) among open weights.
        name="ollama-qwen",
        label="Qwen (local)",
        is_free=True,
        auth_method=AuthMethod.LOCAL,
        backend=Backend.CLI,
        tiers={
            RM.CHEAP_MODEL: "qwen2.5:7b",
            RM.CHEAP_OR_MEDIUM_MODEL: "qwen2.5:7b",
        },
        endpoint="http://127.0.0.1:11434",
        signup_url="https://ollama.com/download",
        cli_command="ollama run {model}",
        login_command="ollama serve",
        probe_command="ollama list",
    ),
    ProviderInfo(
        # Production low-tier worker: strongest local reasoning per GB for N3
        # (medium/intermediate) among open weights.
        name="ollama-deepseek",
        label="DeepSeek (local)",
        is_free=True,
        auth_method=AuthMethod.LOCAL,
        backend=Backend.CLI,
        tiers={
            RM.MEDIUM_MODEL: "deepseek-r1:8b",
        },
        endpoint="http://127.0.0.1:11434",
        signup_url="https://ollama.com/download",
        cli_command="ollama run {model}",
        login_command="ollama serve",
        probe_command="ollama list",
    ),
    ProviderInfo(
        # Coding-focused local worker. MiniMax M3 is a ~450B-parameter MoE
        # (no Ollama distribution and impractical on local hardware), so this
        # uses Qwen2.5-Coder instead: code-tuned, actively maintained, and the
        # best-regarded locally-runnable coding model in the Ollama community.
        name="ollama-qwen-coder",
        label="Qwen Coder (local)",
        is_free=True,
        auth_method=AuthMethod.LOCAL,
        backend=Backend.CLI,
        tiers={
            RM.CHEAP_OR_MEDIUM_MODEL: "qwen2.5-coder:7b",
            RM.MEDIUM_MODEL: "qwen2.5-coder:7b",
        },
        endpoint="http://127.0.0.1:11434",
        signup_url="https://ollama.com/download",
        cli_command="ollama run {model}",
        login_command="ollama serve",
        probe_command="ollama list",
    ),
    ProviderInfo(
        # N3-N4 bridge worker: best locally-runnable general-reasoning model
        # in the 10-14B range. Covers intermediate and complex tasks locally,
        # reducing OpenAI/cloud calls for N4 when VRAM allows (~7 GB needed).
        name="ollama-mistral-nemo",
        label="Mistral Nemo (local)",
        is_free=True,
        auth_method=AuthMethod.LOCAL,
        backend=Backend.CLI,
        tiers={
            RM.MEDIUM_MODEL: "mistral-nemo:12b",
            RM.STRONG_MODEL: "mistral-nemo:12b",
        },
        endpoint="http://127.0.0.1:11434",
        signup_url="https://ollama.com/download",
        cli_command="ollama run {model}",
        login_command="ollama serve",
        probe_command="ollama list",
    ),
    ProviderInfo(
        # General-purpose N2-N3 worker: Google's Gemma 2 9B ranks above most
        # 7B models on reasoning benchmarks while staying within 6 GB VRAM.
        # Good complement to Qwen Coder when the task is not code-specific.
        name="ollama-gemma2",
        label="Gemma 2 (local)",
        is_free=True,
        auth_method=AuthMethod.LOCAL,
        backend=Backend.CLI,
        tiers={
            RM.CHEAP_OR_MEDIUM_MODEL: "gemma2:9b",
            RM.MEDIUM_MODEL: "gemma2:9b",
        },
        endpoint="http://127.0.0.1:11434",
        signup_url="https://ollama.com/download",
        cli_command="ollama run {model}",
        login_command="ollama serve",
        probe_command="ollama list",
    ),
    ProviderInfo(
        name="openclaw",
        label="OpenClaw Gateway (add-on)",
        is_free=True,
        auth_method=AuthMethod.CLI_LOGIN,
        backend=Backend.CLI,
        tiers={},
        endpoint="http://127.0.0.1:8765",
        signup_url="https://github.com/openclaw/openclaw",
        cli_command="openclaw gateway status --json",
        login_command="openclaw configure --section models",
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
    ProviderInfo(
        name="copilot",
        label="GitHub Copilot CLI (local)",
        is_free=False,
        auth_method=AuthMethod.CLI_LOGIN,
        backend=Backend.CLI,
        tiers={
            RM.CHEAP_OR_MEDIUM_MODEL: "gh-copilot",
            RM.MEDIUM_MODEL: "gh-copilot",
            RM.STRONG_MODEL: "gh-copilot",
        },
        signup_url="https://docs.github.com/copilot",
        cli_command="gh copilot suggest --target shell",
        login_command="gh auth login",
        probe_command="gh copilot --help",
    ),
    ProviderInfo(
        name="claude-cli",
        label="Claude Code CLI (local)",
        is_free=False,
        auth_method=AuthMethod.CLI_LOGIN,
        backend=Backend.CLI,
        tiers={
            RM.CHEAP_MODEL: "haiku",
            RM.CHEAP_OR_MEDIUM_MODEL: "haiku",
            RM.MEDIUM_MODEL: "haiku",
            RM.STRONG_MODEL: "sonnet",
            RM.STRONG_MODEL_WITH_HUMAN_REVIEW: "opus",
        },
        signup_url="https://claude.com/claude-code",
        cli_command="claude -p --model {model} --max-budget-usd 0.02 --output-format text",
        login_command="claude /login",
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
        name="qwen",
        label="Qwen",
        is_free=False,
        auth_method=AuthMethod.API_KEY,
        backend=Backend.API,
        tiers={
            RM.CHEAP_MODEL: "qwen-turbo",
            RM.CHEAP_OR_MEDIUM_MODEL: "qwen-plus",
            RM.MEDIUM_MODEL: "qwen-plus",
            RM.STRONG_MODEL: "qwen-max",
            RM.STRONG_MODEL_WITH_HUMAN_REVIEW: "qwen-max",
        },
        endpoint="https://dashscope.aliyuncs.com/compatible-mode/v1",
        signup_url="https://dashscope.console.aliyun.com/apiKey",
        env_var="QWEN_API_KEY",
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
        name="deepseek",
        label="DeepSeek",
        is_free=False,
        auth_method=AuthMethod.API_KEY,
        backend=Backend.API,
        tiers={
            RM.CHEAP_MODEL: "deepseek-chat",
            RM.CHEAP_OR_MEDIUM_MODEL: "deepseek-chat",
            RM.MEDIUM_MODEL: "deepseek-chat",
            RM.STRONG_MODEL: "deepseek-reasoner",
            RM.STRONG_MODEL_WITH_HUMAN_REVIEW: "deepseek-reasoner",
        },
        endpoint="https://api.deepseek.com",
        signup_url="https://platform.deepseek.com/api_keys",
        env_var="DEEPSEEK_API_KEY",
    ),
    ProviderInfo(
        name="zai",
        label="Z.AI GLM",
        is_free=False,
        auth_method=AuthMethod.API_KEY,
        backend=Backend.API,
        tiers={
            RM.CHEAP_MODEL: "glm-4.5-air",
            RM.CHEAP_OR_MEDIUM_MODEL: "glm-4.5-air",
            RM.MEDIUM_MODEL: "glm-4.5-air",
            RM.STRONG_MODEL: "glm-4.5",
            RM.STRONG_MODEL_WITH_HUMAN_REVIEW: "glm-4.5",
        },
        endpoint="https://api.z.ai/api/paas/v4",
        signup_url="https://z.ai",
        env_var="ZAI_API_KEY",
    ),
    ProviderInfo(
        name="moonshot",
        label="Moonshot Kimi",
        is_free=False,
        auth_method=AuthMethod.API_KEY,
        backend=Backend.API,
        tiers={
            RM.CHEAP_MODEL: "kimi-latest",
            RM.CHEAP_OR_MEDIUM_MODEL: "kimi-latest",
            RM.MEDIUM_MODEL: "kimi-latest",
            RM.STRONG_MODEL: "kimi-k2",
            RM.STRONG_MODEL_WITH_HUMAN_REVIEW: "kimi-k2",
        },
        endpoint="https://api.moonshot.ai/v1",
        signup_url="https://platform.moonshot.ai",
        env_var="MOONSHOT_API_KEY",
    ),
    ProviderInfo(
        name="together",
        label="Together AI open models",
        is_free=False,
        auth_method=AuthMethod.API_KEY,
        backend=Backend.API,
        tiers={
            RM.CHEAP_MODEL: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
            RM.CHEAP_OR_MEDIUM_MODEL: "Qwen/Qwen2.5-7B-Instruct-Turbo",
            RM.MEDIUM_MODEL: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B",
            RM.STRONG_MODEL: "Qwen/Qwen2.5-Coder-32B-Instruct",
            RM.STRONG_MODEL_WITH_HUMAN_REVIEW: "Qwen/Qwen2.5-Coder-32B-Instruct",
        },
        endpoint="https://api.together.ai/v1",
        signup_url="https://api.together.ai",
        env_var="TOGETHER_API_KEY",
    ),
    ProviderInfo(
        name="openrouter",
        label="OpenRouter (free router)",
        is_free=True,
        auth_method=AuthMethod.API_KEY,
        backend=Backend.API,
        tiers={
            RM.CHEAP_MODEL: "meta-llama/llama-3.1-8b-instruct:free",
            RM.CHEAP_OR_MEDIUM_MODEL: "meta-llama/llama-3.1-8b-instruct:free",
            RM.MEDIUM_MODEL: "meta-llama/llama-3.3-70b-instruct:free",
            RM.STRONG_MODEL: "meta-llama/llama-3.3-70b-instruct:free",
            RM.STRONG_MODEL_WITH_HUMAN_REVIEW: "meta-llama/llama-3.3-70b-instruct:free",
        },
        endpoint="https://openrouter.ai/api/v1",
        signup_url="https://openrouter.ai",
        env_var="OPENROUTER_API_KEY",
    ),
    ProviderInfo(
        name="huggingface",
        label="Hugging Face Inference Providers",
        is_free=True,
        auth_method=AuthMethod.API_KEY,
        backend=Backend.API,
        tiers={
            RM.CHEAP_MODEL: "openai/gpt-oss-20b",
            RM.CHEAP_OR_MEDIUM_MODEL: "openai/gpt-oss-20b",
            RM.MEDIUM_MODEL: "openai/gpt-oss-120b",
            RM.STRONG_MODEL: "openai/gpt-oss-120b",
            RM.STRONG_MODEL_WITH_HUMAN_REVIEW: "openai/gpt-oss-120b",
        },
        endpoint="https://router.huggingface.co/v1",
        signup_url="https://huggingface.co/settings/tokens",
        env_var="HF_TOKEN",
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
