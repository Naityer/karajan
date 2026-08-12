from __future__ import annotations

from fastapi.testclient import TestClient

from app import main
from app.models import AnalyzeResult, ResourceCreateRequest, ResourceKind
from app.resource_library import ResourceStore
from app.routing_layout import RoutingLayoutStore


class _Analyzer:
    def analyze(self, repo_url: str) -> AnalyzeResult:
        return AnalyzeResult(
            valid=True,
            repo_url=repo_url,
            summary="Resumen del README.",
            preview=ResourceCreateRequest(
                slug="demo",
                name="Demo",
                kind=ResourceKind.SKILL,
                source="github",
                repo_url=repo_url,
                summary="Resumen del README.",
                compatible_runtimes=["claude", "codex"],
                install_strategy="github_skill",
            ),
        )


def _client(monkeypatch, tmp_path) -> TestClient:
    monkeypatch.setenv("KARAJAN_REQUIRE_ATLAS_TOKEN", "0")
    monkeypatch.delenv("KARAJAN_TOKEN", raising=False)
    monkeypatch.setattr(main, "resource_store", ResourceStore(tmp_path / "resources.db"))
    monkeypatch.setattr(main, "layout_store", RoutingLayoutStore(tmp_path / "routing.json"))
    monkeypatch.setattr(main, "resource_analyzer", _Analyzer())
    main._resource_analysis_tickets.clear()
    return TestClient(main.app)


class _Feed:
    def fetch(self, source_ids: list[str], *, limit: int = 18) -> dict:
        return {
            "items": [{
                "id": "github:demo",
                "source_id": "github",
                "source_name": "GitHub",
                "title": "Demo agent toolkit",
                "summary": "Repositorio descubierto.",
                "url": "https://github.com/acme/demo",
                "published_at": "2026-01-01T00:00:00Z",
                "tags": ["repositorio"],
            }][:limit],
            "errors": {},
            "fetched_at": "2026-01-01T00:00:00Z",
        }


class _NestedIndexer:
    class Result:
        indexed = 2
        inactive = 1
        warnings = ()

    def index(self, item):
        assert item.source_url == "https://itsfree.dev/es/"
        return self.Result()


def test_resource_crud_search_index_and_analysis(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)
    analyzed = client.post("/resources/analyze", json={"repo_url": "https://github.com/acme/demo"})
    assert analyzed.status_code == 200
    assert analyzed.json()["preview"]["kind"] == "skill"

    create_payload = {**analyzed.json()["preview"], "analysis_token": analyzed.json()["analysis_token"]}
    created = client.post("/resources", json=create_payload)
    assert created.status_code == 200
    resource_id = created.json()["id"]
    assert client.get("/resources", params={"q": "README", "runtime": "codex"}).json()[0]["id"] == resource_id
    index = client.get("/resources/index").json()
    assert index["version"] == 2
    assert index["resources"][0]["slug"] == "demo"
    detail = client.get(f"/resources/{resource_id}").json()
    assert detail["operations"] == []


def test_github_resource_requires_matching_analysis_ticket(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)
    response = client.post("/resources", json={
        "slug": "unsafe",
        "name": "Unsafe",
        "kind": "skill",
        "source": "github",
        "repo_url": "https://github.com/acme/unsafe",
        "install_strategy": "github_skill",
    })
    assert response.status_code == 409


def test_recommend_resources_returns_explainable_primary_and_complementary(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)
    client.post("/resources", json={
        "slug": "pdf-parser", "name": "PDF Parser", "kind": "capability", "source": "manual",
        "summary": "Convierte documentos PDF a Markdown", "tags": ["pdf", "markdown"],
        "capabilities": ["document-processing"],
    })
    client.post("/resources", json={
        "slug": "code-review", "name": "Code Review", "kind": "skill", "source": "manual",
        "summary": "Revisa código", "capabilities": ["code-review"],
    })

    response = client.post("/resources/recommend", json={
        "prompt": "Necesito convertir un PDF a Markdown para que el agente analice el documento",
        "limit": 5,
    })

    assert response.status_code == 200
    payload = response.json()
    assert payload["version"] == 2
    assert payload["decision"] == "matched"
    assert payload["confidence"] > 0
    assert payload["missing_capabilities"] == []
    result = payload["recommendations"]
    assert result[0]["resource"]["slug"] == "pdf-parser"
    assert result[0]["role"] == "primary"
    assert "document-processing" in result[0]["matched_terms"]
    assert result[0]["reasons"]
    assert result[0]["coverage"] > 0


def test_nested_reindex_requires_confirmation_and_is_explicit(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)
    monkeypatch.setattr(main, "nested_resource_indexer", _NestedIndexer())
    created = client.post("/resources", json={
        "slug": "itsfree", "name": "it's free*", "kind": "reference", "source": "manual",
        "source_url": "https://itsfree.dev/es/", "summary": "Directorio de recursos",
    }).json()
    denied = client.post(f"/resources/{created['id']}/reindex", json={"confirmed": False})
    assert denied.status_code == 409
    indexed = client.post(f"/resources/{created['id']}/reindex", json={"confirmed": True})
    assert indexed.status_code == 200
    assert indexed.json()["resource_id"] == created["id"]
    assert indexed.json()["indexed"] == 2
    assert indexed.json()["inactive"] == 1
    assert indexed.json()["operation_id"].startswith("rop_")


def test_discovery_sources_are_persisted_and_feed_uses_selection(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)
    monkeypatch.setattr(main, "inspiration_feed", _Feed())

    catalog = client.get("/resources/discovery/sources")
    assert catalog.status_code == 200
    assert "github" in catalog.json()["selected_source_ids"]
    assert any(source["id"] == "threads" and not source["available"] for source in catalog.json()["sources"])

    updated = client.put(
        "/resources/discovery/sources",
        json={"source_ids": ["github"]},
    )
    assert updated.status_code == 200
    assert updated.json()["selected_source_ids"] == ["github"]
    assert client.get("/resources/discovery/sources").json()["selected_source_ids"] == ["github"]

    feed = client.get("/resources/discovery/feed", params={"limit": 3})
    assert feed.status_code == 200
    assert feed.json()["selected_source_ids"] == ["github"]
    assert feed.json()["items"][0]["title"] == "Demo agent toolkit"


def test_discovery_rejects_unknown_or_unconfigured_sources(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)
    assert client.put(
        "/resources/discovery/sources", json={"source_ids": ["invented"]}
    ).status_code == 422
    response = client.put(
        "/resources/discovery/sources", json={"source_ids": ["threads"]}
    )
    assert response.status_code == 409
    assert "require configuration" in response.json()["detail"]


def test_visibility_updates_catalog_and_routing_projection(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)
    assert client.put(
        "/routing-layout",
        json={"entities": [{"id": "worker-1", "name": "Worker", "role": "child"}]},
    ).status_code == 200
    created = client.post("/resources", json={
        "slug": "demo",
        "name": "Demo",
        "kind": "skill",
        "source": "manual",
        "summary": "Skill demo",
    }).json()

    response = client.put(
        f"/resources/{created['id']}/visibility",
        json={"agent_ids": ["worker-1"]},
    )
    assert response.status_code == 200
    assert response.json()["visible_agent_ids"] == ["worker-1"]
    entity = client.get("/routing-layout").json()["entities"][0]
    assert entity["resource_ids"] == [created["id"]]
    assert entity["skills"] == ["demo"]


def test_catalog_only_operation_is_denied_and_audited(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)
    created = client.post("/resources", json={
        "slug": "inspiration",
        "name": "Inspiration",
        "kind": "reference",
        "source": "manual",
        "summary": "Reference only",
    }).json()
    result = client.post(
        f"/resources/{created['id']}/operations",
        json={"action": "install", "targets": ["codex"], "confirmed": True},
    )
    assert result.status_code == 200
    assert result.json()["status"] == "denied"
    detail = client.get(f"/resources/{created['id']}").json()
    assert detail["operations"][0]["action"] == "install"


def test_manual_resource_cannot_claim_naityer_installer(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)
    created = client.post("/resources", json={
        "slug": "fake-installer",
        "name": "Fake installer",
        "kind": "capability",
        "source": "manual",
        "install_strategy": "naityer_allowlisted",
        "metadata": {"installer_key": "dify", "note": "editorial"},
    })
    assert created.status_code == 200
    assert created.json()["install_strategy"] == "none"
    assert "installer_key" not in created.json()["metadata"]
    assert created.json()["metadata"]["note"] == "editorial"


def test_visibility_rejects_unknown_agent(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)
    created = client.post("/resources", json={
        "slug": "demo",
        "name": "Demo",
        "kind": "capability",
        "source": "manual",
    }).json()
    response = client.put(
        f"/resources/{created['id']}/visibility",
        json={"agent_ids": ["missing"]},
    )
    assert response.status_code == 422


def test_full_refresh_api_returns_run_id_and_exposes_progress(monkeypatch, tmp_path) -> None:
    client = _client(monkeypatch, tmp_path)

    class RefreshStub:
        run = {
            "run_id": "rrun_test",
            "status": "running",
            "total": 42,
            "pending": 32,
            "processed": 10,
            "updated": 8,
            "unchanged": 2,
            "failed": 0,
            "skipped": 0,
            "children_indexed": 5,
            "failures": [],
        }

        def start_full_refresh(self, *, force: bool = True):
            assert force is True
            return dict(self.run)

        def job_status(self, run_id=None):
            if run_id != self.run["run_id"]:
                raise KeyError(run_id)
            return dict(self.run)

    monkeypatch.setattr(main, "resource_refresh", RefreshStub())

    denied = client.post("/resources/refresh/run", json={"confirmed": False})
    started = client.post("/resources/refresh/run", json={"confirmed": True})
    progress = client.get("/resources/refresh/runs/rrun_test")
    missing = client.get("/resources/refresh/runs/missing")

    assert denied.status_code == 409
    assert started.status_code == 200
    assert started.json()["run_id"] == "rrun_test"
    assert started.json()["total"] == 42
    assert progress.status_code == 200
    assert progress.json()["processed"] == 10
    assert missing.status_code == 404
