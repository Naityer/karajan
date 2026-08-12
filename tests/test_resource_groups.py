from __future__ import annotations

from fastapi.testclient import TestClient

from app import main
from app.resource_library import ResourceStore


def _client(monkeypatch, tmp_path) -> TestClient:
    monkeypatch.setenv("KARAJAN_REQUIRE_ATLAS_TOKEN", "0")
    monkeypatch.delenv("KARAJAN_TOKEN", raising=False)
    monkeypatch.setattr(main, "resource_store", ResourceStore(tmp_path / "resources.db"))
    return TestClient(main.app)


def _create_resource(client: TestClient, slug: str, kind: str = "skill") -> dict:
    response = client.post("/resources", json={
        "slug": slug,
        "name": slug.title(),
        "kind": kind,
        "source": "manual",
    })
    assert response.status_code == 200
    return response.json()


def _create_group(
    client: TestClient, name: str, parent_id: str | None = None, sort_order: int = 0
) -> dict:
    response = client.post("/resource-groups", json={
        "name": name,
        "description": f"Grupo {name}",
        "parent_id": parent_id,
        "sort_order": sort_order,
    })
    assert response.status_code == 200, response.text
    return response.json()


def test_defaults_seed_once_and_classify_existing_resources(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)
    skill = _create_resource(client, "demo-skill", "skill")
    capability = _create_resource(client, "demo-capability", "capability")
    reference = _create_resource(client, "demo-reference", "reference")

    groups = client.get("/resource-groups").json()
    by_name = {group["name"]: group for group in groups}
    assert {group["name"] for group in groups if group["parent_id"] is None} == {
        "Desarrollo de software", "Diseño de producto", "Agentes y automatización",
        "Calidad y seguridad", "Conocimiento y contenidos",
    }
    implementation = by_name["Implementación"]
    extensions = by_name["Skills, plugins e integraciones"]
    assert {capability["id"], reference["id"]} <= set(implementation["resource_ids"])
    assert skill["id"] in extensions["resource_ids"]

    custom = _create_group(client, "Personalizadas", by_name["Desarrollo de software"]["id"])
    moved = client.put("/resource-groups/assignments", json={
        "assignments": {skill["id"]: custom["id"]},
    })
    assert moved.status_code == 200
    client.get("/resource-groups")
    latest = {group["id"]: group for group in client.get("/resource-groups").json()}
    assert latest[custom["id"]]["resource_ids"] == [skill["id"]]
    assert skill["id"] not in latest[extensions["id"]]["resource_ids"]


def test_group_hierarchy_rejects_cycles_and_more_than_four_levels(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)
    roots = {group["name"]: group for group in client.get("/resource-groups").json()}
    level_2 = _create_group(client, "Nivel 2", roots["Desarrollo de software"]["id"])
    level_3 = _create_group(client, "Nivel 3", level_2["id"])

    cycle = client.put(f"/resource-groups/{level_2['id']}", json={
        "name": "Nivel 2",
        "description": "",
        "parent_id": level_3["id"],
        "sort_order": 0,
    })
    assert cycle.status_code == 409
    assert "cycles" in cycle.json()["detail"]

    level_4 = _create_group(client, "Nivel 4", level_3["id"])
    too_deep = client.post("/resource-groups", json={
        "name": "Nivel 5",
        "parent_id": level_4["id"],
    })
    assert too_deep.status_code == 409
    assert "4 levels" in too_deep.json()["detail"]


def test_bulk_assignment_is_atomic_and_validates_ids(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)
    resource = _create_resource(client, "assign-me")
    roots = {group["name"]: group for group in client.get("/resource-groups").json()}
    target = _create_group(client, "Target", roots["Desarrollo de software"]["id"])

    rejected = client.put("/resource-groups/assignments", json={
        "assignments": {resource["id"]: target["id"], "res_missing": target["id"]},
    })
    assert rejected.status_code == 422
    latest = {group["id"]: group for group in client.get("/resource-groups").json()}
    assert latest[target["id"]]["resource_ids"] == []
    assert resource["id"] in latest[roots["Implementación"]["id"]]["resource_ids"]

    unassigned = client.put("/resource-groups/assignments", json={
        "assignments": {resource["id"]: None},
    })
    assert unassigned.status_code == 200
    assert all(resource["id"] not in group["resource_ids"] for group in unassigned.json())


def test_delete_requires_confirmation_moves_resources_and_reparents_children(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)
    resource = _create_resource(client, "movable")
    roots = {group["name"]: group for group in client.get("/resource-groups").json()}
    parent = _create_group(client, "Temporal", roots["Desarrollo de software"]["id"])
    child = _create_group(client, "Child", parent["id"])
    client.put("/resource-groups/assignments", json={
        "assignments": {resource["id"]: parent["id"]},
    })

    assert client.delete(f"/resource-groups/{parent['id']}").status_code == 409
    deleted = client.delete(
        f"/resource-groups/{parent['id']}",
        params={"confirmed": "true", "move_to_id": roots["Desarrollo de software"]["id"]},
    )
    assert deleted.status_code == 200
    latest = {group["id"]: group for group in client.get("/resource-groups").json()}
    assert parent["id"] not in latest
    assert latest[child["id"]]["parent_id"] == roots["Desarrollo de software"]["id"]
    assert latest[roots["Implementación"]["id"]]["resource_ids"] == [resource["id"]]


def test_group_mutations_require_shared_token(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)
    monkeypatch.setenv("KARAJAN_TOKEN", "secret")
    assert client.get("/resource-groups").status_code == 200
    denied = client.post("/resource-groups", json={"name": "Private"})
    assert denied.status_code == 401
    allowed = client.post(
        "/resource-groups",
        headers={"X-KARAJAN-Token": "secret"},
        json={"name": "Private"},
    )
    assert allowed.status_code == 200
