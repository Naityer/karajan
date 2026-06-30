from __future__ import annotations

import os
import shlex
import subprocess

from app.models import ProviderInfo, ProviderRunResult

TIMEOUT_S = 20


def run_provider_command(provider: ProviderInfo, slot: str) -> ProviderRunResult:
    """Run a provider's catalog-defined command for real, for the Agentes console.

    `slot` is always `login_command` or `probe_command` (enforced by the
    request model) — both are fixed strings already shipped in `app/catalog.py`,
    never text typed by the client, so this can't become an arbitrary-command
    execution surface.
    """
    command = getattr(provider, slot, None)
    if not command:
        return ProviderRunResult(
            ok=False,
            provider=provider.name,
            slot=slot,
            command="",
            stdout="",
            stderr="",
            returncode=-1,
            detail=f"'{provider.name}' has no {slot} defined.",
        )

    argv = shlex.split(command, posix=os.name != "nt")
    try:
        completed = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=TIMEOUT_S,
            check=False,
        )
    except FileNotFoundError:
        return ProviderRunResult(
            ok=False,
            provider=provider.name,
            slot=slot,
            command=command,
            stdout="",
            stderr=f"`{argv[0]}` was not found in PATH.",
            returncode=127,
            detail=f"`{argv[0]}` was not found in PATH.",
        )
    except subprocess.TimeoutExpired as exc:
        return ProviderRunResult(
            ok=False,
            provider=provider.name,
            slot=slot,
            command=command,
            stdout=_redact(exc.stdout or ""),
            stderr="Command timed out.",
            returncode=124,
            detail="Command timed out.",
        )

    ok = completed.returncode == 0
    stdout = _redact(completed.stdout or "")
    stderr = _redact(completed.stderr or "")
    return ProviderRunResult(
        ok=ok,
        provider=provider.name,
        slot=slot,
        command=command,
        stdout=stdout,
        stderr=stderr,
        returncode=completed.returncode,
        detail="ok" if ok else (stderr.strip() or "command failed"),
    )


def _redact(value: str) -> str:
    redacted = value
    for key, secret in os.environ.items():
        if not secret or len(secret) < 8:
            continue
        upper = key.upper()
        if "TOKEN" in upper or "KEY" in upper or "SECRET" in upper or "PASSWORD" in upper:
            redacted = redacted.replace(secret, "[redacted]")
    return redacted
