"""Contracts retained after retiring the Python terminal interface."""

import tomllib
from pathlib import Path

from app.domain.model_parts.routing import RoutingLayout as RoutingLayoutPart
from app.domain.models import RoutingLayout
from app.persistence.database import TaskStore


def test_python_cli_entry_point_is_compatible() -> None:
    root = Path(__file__).resolve().parents[2]
    metadata = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    assert metadata["project"]["scripts"]["karajan"] == "karajan_cli.main:run"
    assert (root / "karajan_cli" / "main.py").is_file()
    assert (root / "karajan_cli" / "mcp_server.py").is_file()


def test_split_contract_and_memory_store() -> None:
    assert RoutingLayout is RoutingLayoutPart
    assert RoutingLayout.model_validate({}).project_default_profile()
    store = TaskStore(":memory:")
    try:
        assert store.count_tasks() == 0
        assert store.metrics().total_tasks == 0
    finally:
        store.close()
