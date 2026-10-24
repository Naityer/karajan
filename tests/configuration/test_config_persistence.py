"""Runtime config override: roundtrip, startup precedence, and PUT persistence."""

from pathlib import Path

from fastapi.testclient import TestClient

from app import config as config_module
from app import main
from app.database import TaskStore
from app.models import Backend, KarajanConfig, Profile
from app.runtime import build_standalone_runtime


def test_save_and_load_runtime_config_roundtrip(tmp_path: Path) -> None:
    path = tmp_path / "active_config.json"
    saved = KarajanConfig(backend=Backend.API, profile=Profile.PRO, prefer_free=False)
    config_module.save_runtime_config(saved, path)

    loaded = config_module.load_runtime_config(path)
    assert loaded is not None
    assert loaded.backend == Backend.API
    assert loaded.profile == Profile.PRO
    assert loaded.prefer_free is False


def test_load_runtime_config_missing_returns_none(tmp_path: Path) -> None:
    assert config_module.load_runtime_config(tmp_path / "nope.json") is None


def test_load_config_prefers_runtime_override(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "active_config.json"
    monkeypatch.setattr(config_module, "RUNTIME_CONFIG_PATH", path)
    config_module.save_runtime_config(KarajanConfig(backend=Backend.API, profile=Profile.PRO))

    # No explicit path → load_config should honor the saved override, not auto-detect.
    resolved = config_module.load_config()
    assert resolved.backend == Backend.API
    assert resolved.profile == Profile.PRO


def test_put_config_persists_to_disk(karajan_install, monkeypatch) -> None:
    # `PUT /config` vive ahora en `app/modules/configuration/api.py` y resuelve
    # el runtime activo con `runtime.current()` (el runtime de proceso que
    # `karajan_install` activa), no con el global `main.runtime` de antes — de
    # ahí que la instalación aislada tenga que venir de la fixture.
    monkeypatch.delenv("KARAJAN_TOKEN", raising=False)
    karajan_install.set_config(KarajanConfig(backend=Backend.CLI))
    client = karajan_install.client

    new_config = KarajanConfig(backend=Backend.CLI, prefer_free=False).model_dump(mode="json")
    res = client.put("/config", json=new_config)
    assert res.status_code == 200
    assert res.json()["prefer_free"] is False

    # Persisted and reloadable for the next process start.
    path = karajan_install.runtime.data_dir / "active_config.json"
    assert path.exists()
    assert config_module.load_runtime_config(path).prefer_free is False
