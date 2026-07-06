from app.catalog import get_provider
from app.models import AuthMethod, Backend, RecommendedModel
from app.providers.api import _openai_base_url


def test_qwen_provider_is_available_for_worker_routing() -> None:
    provider = get_provider("qwen")

    assert provider is not None
    assert provider.backend == Backend.API
    assert provider.auth_method == AuthMethod.API_KEY
    assert provider.env_var == "QWEN_API_KEY"
    assert provider.tiers[RecommendedModel.CHEAP_MODEL] == "qwen-turbo"
    assert _openai_base_url(provider) == "https://dashscope.aliyuncs.com/compatible-mode/v1"


def test_openclaw_provider_is_catalogued_as_gateway_addon() -> None:
    provider = get_provider("openclaw")

    assert provider is not None
    assert provider.backend == Backend.CLI
    assert provider.auth_method == AuthMethod.CLI_LOGIN
    assert provider.tiers == {}
    assert provider.cli_command == "openclaw gateway status --json"


def test_ornith_provider_is_genuinely_local() -> None:
    provider = get_provider("ollama-ornith")

    assert provider is not None
    assert provider.is_free is True
    assert provider.is_cloud_hosted is False
    assert provider.backend == Backend.CLI
    assert provider.auth_method == AuthMethod.LOCAL
    assert provider.tiers[RecommendedModel.MEDIUM_MODEL] == "ornith:9b"
    assert provider.tiers[RecommendedModel.STRONG_MODEL] == "ornith:35b"
    assert provider.probe_command == "ollama list"


def test_glm_provider_is_ollama_cloud_hosted() -> None:
    provider = get_provider("ollama-glm")

    assert provider is not None
    assert provider.is_free is False
    assert provider.is_cloud_hosted is True
    assert provider.backend == Backend.CLI
    assert provider.tiers[RecommendedModel.STRONG_MODEL] == "glm-5.2:cloud"
    assert provider.login_command == "ollama signin"


def test_kimi_provider_is_ollama_cloud_hosted() -> None:
    provider = get_provider("ollama-kimi")

    assert provider is not None
    assert provider.is_free is False
    assert provider.is_cloud_hosted is True
    assert provider.backend == Backend.CLI
    assert provider.tiers[RecommendedModel.STRONG_MODEL] == "kimi-k2.7-code:cloud"
    assert provider.login_command == "ollama signin"
