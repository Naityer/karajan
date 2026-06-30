from __future__ import annotations

import shutil
import subprocess

from app.env import PROJECT_ROOT
from app import catalog, credentials
from app.models import AuthMethod, CredentialStatus

BASELINE_DIR = PROJECT_ROOT / "data" / "production_baseline"
ACTIVE_CONFIG_PATH = PROJECT_ROOT / "data" / "active_config.json"
ROUTING_LAYOUT_PATH = PROJECT_ROOT / "data" / "routing_layout.json"

REQUIRED_API_PROVIDERS = ("anthropic", "openai")
LOCAL_PROVIDERS = ("ollama-qwen", "ollama-deepseek")


def ollama_required_models() -> list[str]:
    """The exact local model tags the production hierarchy needs (deduplicated, in order)."""
    seen: list[str] = []
    for provider_name in LOCAL_PROVIDERS:
        provider = catalog.get_provider(provider_name)
        if provider is None:
            continue
        for model in provider.tiers.values():
            if model not in seen:
                seen.append(model)
    return seen


def ollama_installed_models() -> set[str]:
    try:
        completed = subprocess.run(
            ["ollama", "list"], capture_output=True, text=True, timeout=10, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return set()
    if completed.returncode != 0:
        return set()
    rows = completed.stdout.splitlines()[1:]  # skip header (NAME / ID / SIZE / MODIFIED)
    return {row.split()[0] for row in rows if row.strip()}


def check_api_key(provider_name: str) -> CredentialStatus:
    provider = catalog.get_provider(provider_name)
    if provider is None:
        return CredentialStatus(
            provider=provider_name,
            available=False,
            ready=False,
            auth_method=AuthMethod.API_KEY,
            detail=f"proveedor desconocido: {provider_name}",
        )
    return credentials.detect(provider)


def reset_config() -> list[str]:
    """Restore active_config.json/routing_layout.json from data/production_baseline/.

    Backs up whatever is currently in place first. Returns the list of backup
    file paths created (empty if there was nothing to back up or no baseline).
    """
    backups: list[str] = []
    if not BASELINE_DIR.exists():
        return backups
    for filename, target in (
        ("active_config.json", ACTIVE_CONFIG_PATH),
        ("routing_layout.json", ROUTING_LAYOUT_PATH),
    ):
        source = BASELINE_DIR / filename
        if not source.exists():
            continue
        if target.exists():
            backup = target.with_suffix(target.suffix + ".pre-production-setup.bak")
            shutil.copy2(target, backup)
            backups.append(str(backup))
        shutil.copy2(source, target)
    return backups
