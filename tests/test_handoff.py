"""Documentation handoff: local agent selects → pack → web chat → back to Atlas."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import handoff, main
from app.agent_tools.workspace import Workspace
from app.database import TaskStore
from app.handoff import pack as pack_module
from app.models import AgentToolsConfig, Backend, KarajanConfig
from app.routing_layout import RoutingLayoutStore


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    (root / "src").mkdir(parents=True)
    (root / "src" / "app.py").write_text("def foo():\n    return 1\n", encoding="utf-8")
    (root / "README.md").write_text("# Demo\n", encoding="utf-8")
    (root / ".env").write_text("SECRET=abc123\n", encoding="utf-8")
    return root


def test_pack_includes_the_selected_files_with_language_fences(repo: Path) -> None:
    ws = Workspace.open(repo)
    pack = pack_module.build(ws, "tsk_1", "Documenta el modulo", ["src/app.py", "README.md"])

    markdown = pack.markdown()
    assert "### `src/app.py`" in markdown
    assert "```python" in markdown and "def foo():" in markdown
    assert "```markdown" in markdown
    assert pack.total_chars > 0


def test_pack_refuses_secret_files_on_the_way_out(repo: Path) -> None:
    """The containment rules hold outbound too: this is about to be pasted into
    a third-party chat."""
    ws = Workspace.open(repo)
    pack = pack_module.build(ws, "tsk_1", "documenta", ["src/app.py", ".env"])

    skipped = {item.path: item.skipped_reason for item in pack.files if item.skipped_reason}
    assert ".env" in skipped
    assert "SECRET=abc123" not in pack.markdown()
    assert "credenciales" in skipped[".env"]


def test_pack_refuses_paths_outside_the_workspace(repo: Path) -> None:
    ws = Workspace.open(repo)
    pack = pack_module.build(ws, "tsk_1", "documenta", ["../fuera.py"])
    assert all(item.skipped_reason for item in pack.files)


def test_pack_reports_missing_and_binary_files(repo: Path) -> None:
    (repo / "blob.bin").write_bytes(b"\x00\x01binario")
    ws = Workspace.open(repo)
    pack = pack_module.build(ws, "tsk_1", "documenta", ["no-existe.py", "blob.bin"])

    reasons = {item.path: item.skipped_reason for item in pack.files}
    assert "no existe" in reasons["no-existe.py"]
    assert reasons["blob.bin"] == "binario"


def test_pack_respects_its_char_budget(repo: Path) -> None:
    (repo / "grande.py").write_text("x = 1\n" * 5000, encoding="utf-8")
    ws = Workspace.open(repo)
    pack = pack_module.build(ws, "tsk_1", "documenta", ["grande.py", "README.md"], max_chars=200)

    assert pack.total_chars <= 200
    assert any(item.truncated or item.skipped_reason for item in pack.files)


def test_pack_instructions_ask_for_a_paste_ready_answer(repo: Path) -> None:
    """The point of the flow: the answer must come back ready for Atlas, not
    wrapped in a preamble and a code fence."""
    ws = Workspace.open(repo)
    markdown = pack_module.build(ws, "tsk_1", "Documenta", ["README.md"]).markdown()

    assert "listo para pegar" in markdown
    assert "sin envolverlo en un bloque de codigo" in markdown
    assert "en vez de inventarlo" in markdown


def test_pack_round_trips_through_the_store(repo: Path, tmp_path: Path) -> None:
    base = tmp_path / "handoff"
    ws = Workspace.open(repo)
    pack = pack_module.build(ws, "tsk_1", "documenta", ["README.md"])

    handoff.save_pack(pack, None, base=base)
    loaded = handoff.load_pack(pack.id, base=base)

    assert loaded is not None and loaded.id == pack.id
    assert "# Demo" in (handoff.read_markdown(pack.id, base=base) or "")
    assert handoff.list_packs(base=base)[0]["status"] == "pending"

    handoff.save_result(pack.id, "tsk_1", "# Documento final\n", None, base=base)
    assert handoff.read_result(pack.id, base=base) == "# Documento final\n"
    assert handoff.list_packs(base=base)[0]["status"] == "ready"


def test_pack_and_result_are_registered_as_artifacts(repo: Path, tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "runs.db")
    ws = Workspace.open(repo)
    pack = pack_module.build(ws, "tsk_1", "documenta", ["README.md"])

    handoff.save_pack(pack, store, base=tmp_path / "h")
    handoff.save_result(pack.id, "tsk_1", "# Doc\n", store, base=tmp_path / "h")

    kinds = [item["kind"] for item in store.list_artifacts("tsk_1")]
    assert kinds == ["context_pack", "doc_result"]


# ── HTTP surface ────────────────────────────────────────────────────────────
def _client(repo: Path, tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(handoff.store, "HANDOFF_DIR", tmp_path / "handoff")
    main.store = TaskStore(tmp_path / "api.db")
    main.layout_store = RoutingLayoutStore(tmp_path / "layout.json")
    main.active_config = KarajanConfig(
        backend=Backend.CLI,
        agent_tools=AgentToolsConfig(default_workspace_root=str(repo)),
    )
    return TestClient(main.app)


def test_full_handoff_cycle_over_http(repo: Path, tmp_path: Path, monkeypatch) -> None:
    client = _client(repo, tmp_path, monkeypatch)

    created = client.post(
        "/handoff/packs",
        json={
            "task_id": "tsk_doc",
            "prompt": "Documenta el modulo src",
            "paths": ["src/app.py", ".env"],
            "rationale": "es el unico modulo",
        },
    )
    assert created.status_code == 200
    pack = created.json()
    assert pack["files"] == 1  # .env was refused
    assert pack["status"] == "pending"
    assert any(".env" in item for item in pack["skipped"])
    assert "def foo():" in pack["markdown"]

    listed = client.get("/handoff/packs?status=pending").json()
    assert [item["id"] for item in listed] == [pack["id"]]

    result = client.post(
        f"/handoff/packs/{pack['id']}/result", json={"markdown": "# Modulo src\n\nHace foo.\n"}
    )
    assert result.status_code == 200
    assert result.json()["status"] == "ready"
    assert result.json()["result_markdown"].startswith("# Modulo src")

    # This is what Atlas polls for documents to accept.
    ready = client.get("/handoff/packs?status=ready").json()
    assert [item["id"] for item in ready] == [pack["id"]]
    assert client.get("/handoff/packs?status=pending").json() == []


def test_pack_creation_fails_when_nothing_could_be_included(repo: Path, tmp_path: Path, monkeypatch) -> None:
    client = _client(repo, tmp_path, monkeypatch)
    response = client.post(
        "/handoff/packs", json={"task_id": "t", "prompt": "p", "paths": [".env", "no-existe.py"]}
    )
    assert response.status_code == 422
    assert ".env" in response.json()["detail"]


def test_pack_creation_needs_a_workspace(repo: Path, tmp_path: Path, monkeypatch) -> None:
    client = _client(repo, tmp_path, monkeypatch)
    main.active_config = KarajanConfig(backend=Backend.CLI, agent_tools=AgentToolsConfig())
    monkeypatch.setattr("app.agent_tools.policy.resolve_workspace_root", lambda settings, requested=None: None)

    response = client.post("/handoff/packs", json={"task_id": "t", "prompt": "p", "paths": ["a.py"]})
    assert response.status_code == 422
    assert "raiz de trabajo" in response.json()["detail"]


def test_unknown_pack_is_404(repo: Path, tmp_path: Path, monkeypatch) -> None:
    client = _client(repo, tmp_path, monkeypatch)
    assert client.get("/handoff/packs/pack_nope").status_code == 404
    assert client.post("/handoff/packs/pack_nope/result", json={"markdown": "x"}).status_code == 404
