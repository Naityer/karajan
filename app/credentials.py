from __future__ import annotations

import os
import shlex
import shutil
import subprocess

from app import catalog
from app.models import AuthMethod, CredentialStatus, ProviderInfo, ProviderSetup

PROBE_TIMEOUT_S = 5


def detect(provider: ProviderInfo) -> CredentialStatus:
    """Detect whether a provider is configured (`available`) and usable now (`ready`).

    `available` = credential present / binary in PATH. `ready` additionally
    verifies the provider can actually serve a request (model pulled, server up)
    so auto-detection never picks a local backend that would stall or auto-pull.
    """
    if provider.auth_method == AuthMethod.API_KEY:
        env_names = _env_names(provider)
        available = any(bool(os.environ.get(name)) for name in env_names)
        ready = available  # key present ⇒ ready instantly
        joined = " or ".join(env_names)
        detail = f"{joined} is set" if available else f"set {joined} to enable"
    else:  # LOCAL / CLI_LOGIN both need the CLI binary present
        binary = _cli_binary(provider)
        available = bool(binary and shutil.which(binary))
        if not available:
            ready = False
            detail = f"install `{binary}`"
        elif provider.probe_command:
            ready = _probe_ready(provider)
            detail = f"`{binary}` ready" if ready else f"`{binary}` installed but no model/server ready"
        else:  # CLI_LOGIN / no probe: binary presence is the best we can verify cheaply
            ready = available
            detail = f"`{binary}` found in PATH"

    return CredentialStatus(
        provider=provider.name,
        available=available,
        ready=ready,
        auth_method=provider.auth_method,
        detail=detail,
    )


def _probe_ready(provider: ProviderInfo) -> bool:
    """Run the provider's cheap readiness probe; True only if it lists >=1 model."""
    if not provider.probe_command:
        return False
    argv = shlex.split(provider.probe_command, posix=False)
    try:
        completed = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if completed.returncode != 0:
        return False
    # `ollama list` prints a header row plus one line per installed model.
    rows = [line for line in completed.stdout.splitlines() if line.strip()]
    return len(rows) > 1


def detect_all() -> list[CredentialStatus]:
    return [detect(provider) for provider in catalog.all_providers()]


def guided_setup(name: str) -> ProviderSetup | None:
    """Actionable, non-automated steps to authenticate a provider."""
    provider = catalog.get_provider(name)
    if provider is None:
        return None

    status = detect(provider)
    steps: list[str] = []
    if provider.auth_method == AuthMethod.API_KEY:
        if provider.signup_url:
            steps.append(f"Create an account / API key at {provider.signup_url}")
        for env_var in _env_names(provider):
            steps.append(f"Export the key:  setx {env_var} <your-key>  (new shell)")
            steps.append(f"Or for this session:  $env:{env_var}='<your-key>'")
    elif provider.auth_method == AuthMethod.CLI_LOGIN:
        binary = _cli_binary(provider)
        steps.append(f"Install `{binary}` ({provider.signup_url or 'see docs'})")
        if provider.login_command:
            steps.append(f"Authenticate:  {provider.login_command}")
    else:  # LOCAL
        binary = _cli_binary(provider)
        steps.append(f"Install `{binary}` from {provider.signup_url or 'the project site'}")
        if provider.login_command:
            steps.append(f"Start the local service:  {provider.login_command}")
        if status.available and not status.ready:
            sample_model = next(iter(provider.tiers.values()), "<model>")
            steps.append(f"Pull at least one model:  {binary} pull {sample_model}")

    return ProviderSetup(
        provider=provider.name,
        available=status.available,
        steps=steps,
        signup_url=provider.signup_url,
    )


def _cli_binary(provider: ProviderInfo) -> str | None:
    if not provider.cli_command and not provider.login_command:
        return None
    template = provider.cli_command or provider.login_command or ""
    return template.split()[0] if template else None


def _env_names(provider: ProviderInfo) -> list[str]:
    names = [provider.env_var] if provider.env_var else []
    if provider.name == "google":
        names.append("GEMINI_API_KEY")
    return [name for name in names if name]
