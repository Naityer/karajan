from __future__ import annotations

import os
import time

from app.models import Backend, ProviderInfo
from app.providers.base import ModelProvider, ProviderRun


class ApiModelProvider(ModelProvider):
    """Cloud API provider. SDKs are imported lazily so they stay optional."""

    backend = Backend.API

    def __init__(self, provider: ProviderInfo) -> None:
        self.provider = provider

    def run(self, instruction: str, model_id: str, timeout_s: int) -> ProviderRun:
        start = time.perf_counter()
        try:
            output = self._dispatch(instruction, model_id, timeout_s)
            error = None
        except Exception as exc:  # noqa: BLE001 - surface any SDK/network failure as a run error
            output = ""
            error = f"{type(exc).__name__}: {exc}"
        latency_ms = int((time.perf_counter() - start) * 1000)
        return ProviderRun(output=output, model_used=f"{self.provider.name}:{model_id}", latency_ms=latency_ms, error=error)

    def _dispatch(self, instruction: str, model_id: str, timeout_s: int) -> str:
        name = self.provider.name
        key = os.environ.get(self.provider.env_var or "", "")
        if not key:
            raise RuntimeError(f"missing API key ({self.provider.env_var})")

        if name == "anthropic":
            return self._anthropic(instruction, model_id, key, timeout_s)
        if name in ("openai", "groq", "mistral"):
            return self._openai_compatible(instruction, model_id, key, timeout_s)
        if name == "google":
            return self._google(instruction, model_id, key, timeout_s)
        raise RuntimeError(f"no API client wired for provider '{name}'")

    def _anthropic(self, instruction: str, model_id: str, key: str, timeout_s: int) -> str:
        import anthropic  # optional dependency

        client = anthropic.Anthropic(api_key=key, timeout=timeout_s)
        message = client.messages.create(
            model=model_id,
            max_tokens=2048,
            messages=[{"role": "user", "content": instruction}],
        )
        return "".join(block.text for block in message.content if getattr(block, "type", "") == "text")

    def _openai_compatible(self, instruction: str, model_id: str, key: str, timeout_s: int) -> str:
        from openai import OpenAI  # optional dependency

        client = OpenAI(api_key=key, base_url=_openai_base_url(self.provider), timeout=timeout_s)
        completion = client.chat.completions.create(
            model=model_id,
            messages=[{"role": "user", "content": instruction}],
        )
        return completion.choices[0].message.content or ""

    def _google(self, instruction: str, model_id: str, key: str, timeout_s: int) -> str:
        from google import genai  # optional dependency

        client = genai.Client(api_key=key)
        response = client.models.generate_content(model=model_id, contents=instruction)
        return response.text or ""


def _openai_base_url(provider: ProviderInfo) -> str | None:
    if provider.name == "groq":
        return "https://api.groq.com/openai/v1"
    if provider.name == "mistral":
        return "https://api.mistral.ai/v1"
    return None  # default OpenAI endpoint
