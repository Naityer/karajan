from __future__ import annotations

import shlex
import shutil
import subprocess
import time

from app.models import Backend, ProviderInfo
from app.providers.base import ModelProvider, ProviderRun


class CliModelProvider(ModelProvider):
    """Runs a local CLI (ollama, aider, claude, ...) via subprocess.

    The command template comes from the catalog entry. The instruction is fed
    on stdin so prompts with shell metacharacters stay safe.
    """

    backend = Backend.CLI

    def __init__(self, provider: ProviderInfo) -> None:
        self.provider = provider

    def run(self, instruction: str, model_id: str, timeout_s: int) -> ProviderRun:
        template = self.provider.cli_command
        if not template:
            return ProviderRun("", f"{self.provider.name}:{model_id}", 0, error="no cli_command configured")

        command = template.format(model=model_id)
        argv = shlex.split(command, posix=False)
        binary = argv[0] if argv else ""
        if not shutil.which(binary):
            return ProviderRun("", f"{self.provider.name}:{model_id}", 0, error=f"`{binary}` not found in PATH")

        start = time.perf_counter()
        try:
            completed = subprocess.run(
                argv,
                input=instruction,
                capture_output=True,
                text=True,
                timeout=timeout_s,
                check=False,
            )
            output = completed.stdout.strip()
            error = completed.stderr.strip() or None if completed.returncode != 0 else None
        except subprocess.TimeoutExpired:
            output, error = "", f"timeout after {timeout_s}s"
        except OSError as exc:
            output, error = "", f"{type(exc).__name__}: {exc}"
        latency_ms = int((time.perf_counter() - start) * 1000)
        return ProviderRun(output=output, model_used=f"{self.provider.name}:{model_id}", latency_ms=latency_ms, error=error)
