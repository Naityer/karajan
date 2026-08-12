from __future__ import annotations

import json
import math
from pathlib import Path

import httpx

from app.models import ResourceItem, ResourceKind
from app.nested_resources import ItsFreeAdapter, NestedResourceIndexer
from app.resource_intelligence import ResourceRankingEngine
from app.resource_library import ResourceStore


FIXTURES = Path(__file__).parent / "fixtures"


def _resource(slug: str, *, name: str, summary: str, capabilities: list[str], tags: list[str] | None = None) -> ResourceItem:
    return ResourceItem(
        slug=slug,
        name=name,
        kind=ResourceKind.CAPABILITY,
        source="eval",
        summary=summary,
        capabilities=capabilities,
        tags=tags or [],
    )


def _critical_resources() -> list[ResourceItem]:
    return [
        _resource(
            "anatomy-atelier", name="Anatomy Atelier",
            summary="Experiencia educativa de anatomia humana y organos en Three.js.",
            capabilities=["anatomy-visualization", "interactive-3d"], tags=["anatomy", "threejs"],
        ),
        _resource(
            "mapcn", name="mapcn", summary="Mapas interactivos con marcadores y rutas.",
            capabilities=["geospatial-ui", "map-markers", "map-routes"], tags=["maplibre", "maps"],
        ),
        _resource(
            "repo-analyzer", name="repo-analyzer", summary="Audita repositorios, codigo y dependencias.",
            capabilities=["repository-audit", "code-review", "dependency-analysis"],
        ),
        _resource(
            "security-review", name="security-review", summary="Revisa secretos, permisos y vulnerabilidades.",
            capabilities=["security-audit"],
        ),
        _resource(
            "tanstack-charts", name="TanStack Charts", summary="Graficas para visualizar datos.",
            capabilities=["data-visualization"],
        ),
        _resource(
            "xlsx", name="xlsx", summary="Analiza hojas de calculo.",
            capabilities=["spreadsheet-analysis"],
        ),
        _resource(
            "gradientsaas-blogspot-com", name="Gradient Studio", summary="Referencia web de gradientes.",
            capabilities=["web-reference"], tags=["web"],
        ),
        _resource(
            "www-threads-com-midu-dev", name="midudev Threads", summary="Perfil social de tecnologia.",
            capabilities=["web-reference"], tags=["web"],
        ),
    ]


def test_gold_corpus_has_correct_primary_abstention_and_complements() -> None:
    cases = json.loads((FIXTURES / "resource_retrieval_cases.json").read_text(encoding="utf-8"))
    engine = ResourceRankingEngine()
    resources = _critical_resources()

    for case in cases:
        result = engine.recommend(case["prompt"], resources, limit=5)
        slugs = [entry.resource.slug for entry in result.recommendations]
        if expected := case.get("expected_primary"):
            assert result.decision == "matched", case["id"]
            assert slugs and slugs[0] == expected, (case["id"], slugs)
        if expected := case.get("expected_decision"):
            assert result.decision == expected, (case["id"], result.decision)
        assert set(case.get("expected_missing", ())) <= set(result.missing_capabilities)
        assert not set(case.get("forbidden_top3", ())) & set(slugs[:3])
        complementary = {entry.resource.slug for entry in result.recommendations if entry.role == "complementary"}
        assert set(case.get("expected_complementary", ())) <= complementary


def test_gold_corpus_relevance_metrics_meet_release_thresholds() -> None:
    cases = json.loads((FIXTURES / "resource_retrieval_cases.json").read_text(encoding="utf-8"))
    engine = ResourceRankingEngine()
    resources = _critical_resources()
    ranked_cases = [case for case in cases if case.get("expected_primary")]
    ranks: list[int] = []
    false_primaries = 0
    for case in ranked_cases:
        result = engine.recommend(case["prompt"], resources, limit=5)
        slugs = [entry.resource.slug for entry in result.recommendations]
        rank = slugs.index(case["expected_primary"]) + 1 if case["expected_primary"] in slugs else 999
        ranks.append(rank)
        false_primaries += int(bool(slugs) and slugs[0] != case["expected_primary"])
    hit_at_3 = sum(rank <= 3 for rank in ranks) / len(ranks)
    mrr = sum(1 / rank for rank in ranks) / len(ranks)
    ndcg_at_5 = sum((1 / math.log2(rank + 1)) if rank <= 5 else 0 for rank in ranks) / len(ranks)
    assert hit_at_3 >= 0.95
    assert mrr >= 0.90
    assert ndcg_at_5 >= 0.90
    assert false_primaries / len(ranks) < 0.02


def test_every_resource_is_retrievable_by_name_and_canonical_capability() -> None:
    engine = ResourceRankingEngine()
    resources = _critical_resources()
    for resource in resources:
        by_name = engine.recommend(resource.name, resources, limit=3)
        assert by_name.recommendations[0].resource.id == resource.id
        for capability in resource.capabilities:
            if capability == "web-reference":
                continue
            ranked = engine.recommend(capability.replace("-", " "), resources, limit=3)
            assert resource.id in {entry.resource.id for entry in ranked.recommendations[:3]}


def test_recommendation_order_is_deterministic_across_three_runs() -> None:
    engine = ResourceRankingEngine()
    resources = _critical_resources()
    prompt = "Revisa el repositorio, sus dependencias y posibles problemas de seguridad"
    snapshots = []
    for _ in range(3):
        result = engine.recommend(prompt, resources, limit=5)
        snapshots.append((
            result.decision,
            tuple((entry.resource.slug, entry.role, entry.score) for entry in result.recommendations),
        ))
    assert snapshots[0] == snapshots[1] == snapshots[2]


def test_nested_indexer_creates_idempotent_children_and_marks_missing_inactive(tmp_path) -> None:
    pages = {
        "https://itsfree.dev/es/": (FIXTURES / "itsfree_directory.html").read_text(encoding="utf-8"),
        "https://itsfree.dev/es/tools/supabase": (FIXTURES / "itsfree_supabase.html").read_text(encoding="utf-8"),
        "https://itsfree.dev/es/tools/open-meteo": (FIXTURES / "itsfree_open_meteo.html").read_text(encoding="utf-8"),
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=pages[str(request.url)])

    store = ResourceStore(tmp_path / "resources.db")
    parent = store.upsert(ResourceItem(
        slug="itsfree-dev", name="it's free*", kind=ResourceKind.REFERENCE,
        source="curated", source_url="https://itsfree.dev/es/", summary="Directorio de herramientas.",
    ))
    adapter = ItsFreeAdapter(httpx.Client(transport=httpx.MockTransport(handler)))
    indexer = NestedResourceIndexer(store, adapters=[adapter])

    first = indexer.index(parent)
    second = indexer.index(parent)
    assert first.indexed == second.indexed == 2
    assert {item.slug for item in store.list_children(parent.id)} == {
        "itsfree-dev--open-meteo", "itsfree-dev--supabase",
    }
    assert all(item.parent_resource_id == parent.id for item in store.list_children(parent.id))
    assert all(item.metadata["intelligence"]["evidence"] for item in store.list_children(parent.id))
    assert store.recommendation_candidates("postgres auth storage", limit=3)[0].slug == "itsfree-dev--supabase"
    assert store.recommendation_candidates("weather forecast map", limit=3)[0].slug == "itsfree-dev--open-meteo"

    pages["https://itsfree.dev/es/"] = '<a href="/es/tools/supabase">Supabase</a>'
    indexer.index(parent)
    children = {item.slug: item for item in store.list_children(parent.id, include_inactive=True)}
    assert children["itsfree-dev--open-meteo"].index_status == "inactive"


def test_store_migration_preserves_existing_rows_and_indexes_child_context(tmp_path) -> None:
    store = ResourceStore(tmp_path / "resources.db")
    parent = store.upsert(ResourceItem(
        slug="directory", name="Directory", kind=ResourceKind.REFERENCE,
        source="test", source_url="https://example.test/", summary="Developer directory",
    ))
    child = store.upsert(ResourceItem(
        slug="directory--maps", name="Maps", kind=ResourceKind.CAPABILITY,
        source="test", source_url="https://example.test/maps", parent_resource_id=parent.id,
        summary="Map components", capabilities=["geospatial-ui"],
    ))
    assert store.get(child.id).parent_resource_id == parent.id
    assert store.recommendation_candidates("interactive geospatial map", limit=10)[0].id == child.id

    store._fts_available = False
    assert store.recommendation_candidates("geospatial map", limit=10)[0].id == child.id
    # Reopening performs the additive migration/backfill again without changing ids.
    reopened = ResourceStore(tmp_path / "resources.db")
    assert reopened.get(child.id).parent_resource_id == parent.id
