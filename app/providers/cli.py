from __future__ import annotations

import re
import shlex
import shutil
import subprocess
import time
import os
from pathlib import Path

# `ollama run` (and other CLIs) draw a spinner and reposition the cursor while
# streaming, so stdout arrives peppered with escape sequences like `\x1b[7D`.
# Left in, they end up inside the model's own answer, inside the agent trace and
# inside anything built from it.
_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\r\x0b\x0c]")

from app.models import Backend, ProviderInfo
from app.providers.base import ModelProvider, ProviderRun


def _strip_ansi(text: str | None) -> str:
    return _ANSI.sub("", text or "").strip()


class CliModelProvider(ModelProvider):
    """Runs a local CLI (ollama, aider, claude, ...) via subprocess.

    The command template comes from the catalog entry. The instruction is fed
    on stdin so prompts with shell metacharacters stay safe.
    """

    backend = Backend.CLI

    def __init__(self, provider: ProviderInfo) -> None:
        self.provider = provider

    def _resolve_binary(self, binary: str) -> str | None:
        found = shutil.which(binary)
        if found:
            return found

        # GUI-launched servers on Windows often miss the user's npm global bin
        # even though the same command works in an interactive terminal.
        candidate_dirs = []
        appdata = os.environ.get("APPDATA")
        if appdata:
            candidate_dirs.append(Path(appdata) / "npm")
        localappdata = os.environ.get("LOCALAPPDATA")
        if localappdata:
            candidate_dirs.append(Path(localappdata) / "npm")

        suffixes = ("", ".cmd", ".exe", ".bat") if os.name == "nt" else ("",)
        for directory in candidate_dirs:
            for suffix in suffixes:
                candidate = directory / f"{binary}{suffix}"
                if candidate.exists():
                    return str(candidate)
        return None

    def run(self, instruction: str, model_id: str, timeout_s: int) -> ProviderRun:
        template = self.provider.cli_command
        if not template:
            return ProviderRun("", f"{self.provider.name}:{model_id}", 0, error="no cli_command configured")

        command = template.format(model=model_id)
        argv = shlex.split(command, posix=False)
        binary = argv[0] if argv else ""
        resolved_binary = self._resolve_binary(binary)
        if not resolved_binary:
            return ProviderRun("", f"{self.provider.name}:{model_id}", 0, error=f"`{binary}` not found in PATH")
        argv[0] = resolved_binary

        start = time.perf_counter()
        try:
            completed = subprocess.run(
                argv,
                input=instruction,
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='replace',
                timeout=timeout_s,
                check=False,
            )
            output = _strip_ansi(completed.stdout)
            error = _strip_ansi(completed.stderr) or None if completed.returncode != 0 else None
        except subprocess.TimeoutExpired:
            output, error = "", f"timeout after {timeout_s}s"
        except OSError as exc:
            output, error = "", f"{type(exc).__name__}: {exc}"
        latency_ms = int((time.perf_counter() - start) * 1000)
        return ProviderRun(output=output, model_used=f"{self.provider.name}:{model_id}", latency_ms=latency_ms, error=error)
