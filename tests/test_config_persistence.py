"""Runtime config override: roundtrip, startup precedence, and PUT persistence."""

from pathlib import Path

from fastapi.testclient import TestClient

from app import config as config_module
from app import main
from app.database import TaskStore
from app.models import Backend, KarajanConfig, Profile


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


def test_put_config_persists_to_disk(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "active_config.json"
    monkeypatch.setattr(config_module, "RUNTIME_CONFIG_PATH", path)
    monkeypatch.delenv("KARAJAN_TOKEN", raising=False)
    main.store = TaskStore(tmp_path / "cfg.db")
    main.active_config = KarajanConfig(backend=Backend.SIMULATED)
    client = TestClient(main.app)

    new_config = KarajanConfig(backend=Backend.SIMULATED, prefer_free=False).model_dump(mode="json")
    res = client.put("/config", json=new_config)
    assert res.status_code == 200
    assert res.json()["prefer_free"] is False

    # Persisted and reloadable for the next process start.
    assert path.exists()
    assert config_module.load_runtime_config(path).prefer_free is False
