from __future__ import annotations

import json
import os
from pathlib import Path

from app.models import Backend, KarajanConfig, Profile

CONFIG_ENV_VAR = "KARAJAN_CONFIG"
DEFAULT_CONFIG_PATHS = (Path("karajan.yaml"), Path("karajan.yml"), Path("karajan.json"))


def load_config(path: Path | str | None = None) -> KarajanConfig:
    """Resolve the active config.

    - `pro`/explicit file: load YAML/JSON and override the defaults.
    - `simple` (default, no file): start from defaults and auto-detect backends.
    - `offline`: defaults only, simulated backend.
    """
    resolved = _resolve_path(path)
    if resolved is not None:
        config = _from_file(resolved)
    else:
        config = KarajanConfig()

    if config.profile == Profile.SIMPLE:
        config = auto_detect(config)
    elif config.profile == Profile.OFFLINE:
        config.backend = Backend.SIMULATED
    return config


def auto_detect(config: KarajanConfig) -> KarajanConfig:
    """Pick a backend and tier→provider mapping from what is actually ready.

    Only providers that are *ready* (key set, or local model pulled + server up)
    are eligible — never one that would stall or trigger a multi-GB auto-pull.
    Order: prefer free (local CLI) first when `prefer_free`, then API keys; if
    nothing is ready, fall back to the simulated backend so the app always works.
    """
    from app import catalog, credentials  # local import to avoid cycles

    statuses = {s.provider: s for s in credentials.detect_all()}
    ready = [p for p in catalog.all_providers() if statuses.get(p.name) and statuses[p.name].ready]

    if config.prefer_free:
        ready.sort(key=lambda p: (not p.is_free, p.backend != Backend.CLI))

    if not ready:
        config.backend = Backend.SIMULATED
        return config

    # Map each logical tier to the first ready provider that supports it.
    preferences: dict[str, str] = {}
    chosen_backend: Backend | None = None
    for tier in config.level_to_model.values():
        for provider in ready:
            if any(t.value == tier for t in provider.tiers):
                preferences.setdefault(tier, provider.name)
                chosen_backend = chosen_backend or provider.backend
                break

    config.provider_preferences = preferences
    config.backend = chosen_backend or Backend.SIMULATED
    return config


def _resolve_path(path: Path | str | None) -> Path | None:
    if path is not None:
        candidate = Path(path)
        return candidate if candidate.exists() else None
    env_path = os.environ.get(CONFIG_ENV_VAR)
    if env_path and Path(env_path).exists():
        return Path(env_path)
    for candidate in DEFAULT_CONFIG_PATHS:
        if candidate.exists():
            return candidate
    return None


def _from_file(path: Path) -> KarajanConfig:
    raw = path.read_text(encoding="utf-8")
    if path.suffix in (".yaml", ".yml"):
        data = _load_yaml(raw)
    else:
        data = json.loads(raw)
    return KarajanConfig.model_validate(data)


def _load_yaml(raw: str) -> dict:
    try:
        import yaml  # optional dependency
    except ModuleNotFoundError as exc:  # pragma: no cover - depends on env
        raise RuntimeError(
            "Reading a YAML config requires PyYAML. Install it or use a .json config."
        ) from exc
    return yaml.safe_load(raw) or {}
