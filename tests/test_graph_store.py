from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main
from app.graph_store import GraphStore, safe_resolve
from app.models import RepoConfig


# --- GraphStore unit tests ---------------------------------------------------


def test_add_list_get_delete_repo(tmp_path: Path) -> None:
    store = GraphStore(tmp_path / "graph.db")

    created = store.add_repo(RepoConfig(name="Karajan", root_path=str(tmp_path)))
    assert created.id.startswith("repo_")
    assert created.name == "Karajan"

    listed = store.list_repos()
    assert [r.id for r in listed] == [created.id]

    fetched = store.get_repo(created.id)
    assert fetched is not None
    assert fetched.root_path == str(tmp_path)
    assert fetched.exclude_globs == []

    assert store.get_repo("repo_missing") is None
    assert store.delete_repo(created.id) is True
    assert store.list_repos() == []
    assert store.delete_repo(created.id) is False


def test_duplicate_root_path_rejected(tmp_path: Path) -> None:
    store = GraphStore(tmp_path / "graph.db")
    store.add_repo(RepoConfig(name="A", root_path=str(tmp_path)))
    with pytest.raises(Exception):  # sqlite3.IntegrityError on UNIQUE(root_path)
        store.add_repo(RepoConfig(name="B", root_path=str(tmp_path)))


def test_exclude_globs_roundtrip(tmp_path: Path) -> None:
    store = GraphStore(tmp_path / "graph.db")
    created = store.add_repo(
        RepoConfig(name="A", root_path=str(tmp_path), exclude_globs=["*.log", "build/**"])
    )
    assert store.get_repo(created.id).exclude_globs == ["*.log", "build/**"]


# --- safe_resolve security primitive -----------------------------------------


def test_safe_resolve_accepts_in_tree_path(tmp_path: Path) -> None:
    resolved = safe_resolve(tmp_path, "sub/file.py")
    assert resolved == (tmp_path / "sub" / "file.py").resolve()


def test_safe_resolve_rejects_traversal(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        safe_resolve(tmp_path, "../../etc/passwd")


def test_safe_resolve_rejects_absolute_outside(tmp_path: Path) -> None:
    outside = tmp_path.parent / "elsewhere"
    with pytest.raises(ValueError):
        safe_resolve(tmp_path, str(outside))


# --- Route-level tests -------------------------------------------------------


def _client(tmp_path: Path) -> TestClient:
    main.graph_store = GraphStore(tmp_path / "graph.db")
    return TestClient(main.app)


def test_repos_routes_crud(tmp_path: Path) -> None:
    client = _client(tmp_path)

    assert client.get("/repos").json() == []

    repo_dir = tmp_path / "project"
    repo_dir.mkdir()
    resp = client.post("/repos", json={"name": "Proj", "root_path": str(repo_dir)})
    assert resp.status_code == 200, resp.text
    created = resp.json()
    assert created["root_path"] == str(repo_dir.resolve())

    listing = client.get("/repos").json()
    assert len(listing) == 1

    got = client.get(f"/repos/{created['id']}")
    assert got.status_code == 200
    assert got.json()["id"] == created["id"]

    # duplicate path -> 409
    dup = client.post("/repos", json={"name": "Proj2", "root_path": str(repo_dir)})
    assert dup.status_code == 409

    # delete + confirm gone
    deleted = client.delete(f"/repos/{created['id']}")
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True}
    assert client.get("/repos").json() == []
    assert client.get(f"/repos/{created['id']}").status_code == 404
    assert client.delete(f"/repos/{created['id']}").status_code == 404


def test_create_repo_nonexistent_path(tmp_path: Path) -> None:
    client = _client(tmp_path)
    resp = client.post("/repos", json={"name": "Ghost", "root_path": str(tmp_path / "nope")})
    assert resp.status_code == 400


def test_repo_file_routes_read_and_save_inside_repo(tmp_path: Path) -> None:
    client = _client(tmp_path)
    repo_dir = tmp_path / "project"
    repo_dir.mkdir()
    source = repo_dir / "app.py"
    source.write_text("print('hola')\n", encoding="utf-8")
    repo = client.post("/repos", json={"name": "Proj", "root_path": str(repo_dir)}).json()

    got = client.get(f"/repos/{repo['id']}/file", params={"path": "app.py"})
    assert got.status_code == 200, got.text
    assert got.json()["content"] == "print('hola')\n"

    saved = client.put(
        f"/repos/{repo['id']}/file",
        json={"path": "app.py", "content": "print('adios')\n"},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["saved"] is True
    assert source.read_text(encoding="utf-8") == "print('adios')\n"


def test_repo_file_routes_reject_path_traversal(tmp_path: Path) -> None:
    client = _client(tmp_path)
    repo_dir = tmp_path / "project"
    repo_dir.mkdir()
    outside = tmp_path / "outside.py"
    outside.write_text("secret\n", encoding="utf-8")
    repo = client.post("/repos", json={"name": "Proj", "root_path": str(repo_dir)}).json()

    got = client.get(f"/repos/{repo['id']}/file", params={"path": "../outside.py"})
    assert got.status_code == 400

    saved = client.put(
        f"/repos/{repo['id']}/file",
        json={"path": "../outside.py", "content": "changed\n"},
    )
    assert saved.status_code == 400
    assert outside.read_text(encoding="utf-8") == "secret\n"
