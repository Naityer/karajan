from __future__ import annotations

import httpx
from fastapi.testclient import TestClient

from app import main
from app.models import ResourceCreateRequest, ResourceKind
from app.nested_resources import RefactoringGuruAdapter, TooolsDesignAdapter
from app.resource_library import ResourceStore
from app.resource_sources import classify_external_url, normalize_external_url
from app.routing_layout import RoutingLayoutStore


def _client(monkeypatch, tmp_path) -> TestClient:
    monkeypatch.setenv("KARAJAN_REQUIRE_ATLAS_TOKEN", "0")
    monkeypatch.delenv("KARAJAN_TOKEN", raising=False)
    monkeypatch.setattr(main, "resource_store", ResourceStore(tmp_path / "resources.db"))
    monkeypatch.setattr(main, "layout_store", RoutingLayoutStore(tmp_path / "routing.json"))
    main._resource_analysis_tickets.clear()
    return TestClient(main.app)


def test_url_roles_distinguish_sources_artifacts_and_collections() -> None:
    assert normalize_external_url("www.threads.com/@midu.dev") == "https://www.threads.com/@midu.dev"
    assert classify_external_url("https://www.threads.com/@midu.dev").role == "discovery_source"
    assert classify_external_url("https://github.com/affaan-m/ecc").role == "artifact"
    assert classify_external_url("https://itsfree.dev/es/").role == "collection"
    assert classify_external_url("https://refactoring.guru/design-patterns/catalog").role == "collection"


def test_radar_source_is_persisted_outside_library_and_is_idempotent(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)
    payload = {"url": "www.threads.com/@midu.dev", "name": "midudev", "enabled": True}
    first = client.post("/resources/discovery/sources", json=payload)
    second = client.post("/resources/discovery/sources", json=payload)
    assert first.status_code == second.status_code == 200
    assert first.json()["id"] == second.json()["id"]
    assert first.json()["provider"] == "threads"
    assert first.json()["requires_credentials"] is True
    assert client.get("/resources").json() == []
    sources = client.get("/resources/discovery/sources").json()["sources"]
    assert sum(source["url"] == "https://www.threads.com/@midu.dev" for source in sources if "url" in source) == 1


def test_social_profile_cannot_be_created_as_library_artifact(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)
    analyzed = client.post("/resources/analyze", json={"repo_url": "https://www.threads.com/@midu.dev"})
    assert analyzed.status_code == 200
    payload = {**analyzed.json()["preview"], "analysis_token": analyzed.json().get("analysis_token")}
    response = client.post("/resources", json=payload)
    assert response.status_code == 409
    assert "fuentes de Radar" in response.json()["detail"]


def test_legacy_radar_profile_is_migrated_without_deletion(tmp_path) -> None:
    store = ResourceStore(tmp_path / "resources.db")
    item = store.create(ResourceCreateRequest(
        slug="midudev", name="midudev", kind=ResourceKind.REFERENCE, source="threads",
        repo_url="https://www.threads.com/@midu.dev", summary="Fuente de herramientas",
        metadata={"inspiration_collection": "radar"},
    ))
    migrated = store.migrate_radar_profiles()
    assert len(migrated) == 1
    assert store.get(item.id).index_status == "inactive"
    assert store.list_resources() == []
    assert store.migrate_radar_profiles() == []
    assert len(store.list_discovery_sources()) == 1


def test_refactoring_guru_adapter_materializes_pattern_children(tmp_path) -> None:
    pages = {
        "https://refactoring.guru/design-patterns/catalog": '<a href="/design-patterns/factory-method">Factory Method</a>',
        "https://refactoring.guru/design-patterns/factory-method": '<title>Factory Method</title><meta name="description" content="Patron creacional para fabricar objetos"><h1>Factory Method</h1>',
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=pages[str(request.url)], request=request)

    store = ResourceStore(tmp_path / "resources.db")
    parent = store.create(ResourceCreateRequest(
        slug="patterns", name="Patrones", kind=ResourceKind.REFERENCE,
        source="refactoring.guru", source_url="https://refactoring.guru/design-patterns/catalog",
    ))
    children = RefactoringGuruAdapter(httpx.Client(transport=httpx.MockTransport(handler))).discover(parent)
    assert [child.name for child in children] == ["Factory Method"]
    assert children[0].parent_resource_id == parent.id
    assert children[0].metadata["provenance"]["method"] == "generic-html"


def test_toools_adapter_indexes_external_tools_without_fetching_them(tmp_path) -> None:
    html = '<a href="https://penpot.app/">Penpot</a><a href="https://figma.com/">Figma</a><a href="/about">About</a>'

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://toools.design/"
        return httpx.Response(200, text=html, request=request)

    store = ResourceStore(tmp_path / "resources.db")
    parent = store.create(ResourceCreateRequest(
        slug="toools", name="Toools", kind=ResourceKind.REFERENCE,
        source="toools.design", source_url="https://toools.design/",
    ))
    children = TooolsDesignAdapter(httpx.Client(transport=httpx.MockTransport(handler))).discover(parent)
    assert [child.name for child in children] == ["Penpot", "Figma"]
    assert all(child.metadata["agent_resource"]["access_mode"] == "reference" for child in children)
