from __future__ import annotations

import statistics
import time

from app.models import ResourceItem, ResourceKind
from app.resource_intelligence import ResourceRankingEngine
from app.resource_library import ResourceStore


def test_fts_rerank_pipeline_meets_10k_latency_budget(tmp_path) -> None:
    store = ResourceStore(tmp_path / "benchmark.db")
    capabilities = (
        "anatomy-visualization", "interactive-3d", "geospatial-ui", "map-markers",
        "repository-audit", "dependency-analysis", "data-visualization", "spreadsheet-analysis",
    )
    items = [
        ResourceItem(
            slug=f"synthetic-{index}", name=f"Synthetic resource {index}",
            kind=ResourceKind.CAPABILITY, source="benchmark",
            summary=f"Deterministic benchmark item for {capabilities[index % len(capabilities)]}",
            capabilities=[capabilities[index % len(capabilities)]],
        )
        for index in range(10_000)
    ]
    insert_sql = """
        INSERT INTO resources (
            id, slug, name, kind, source, repo_url, summary, tags_json,
            requirements_json, capabilities_json, compatible_runtimes_json,
            install_strategy, status, installations_json, visible_agent_ids_json,
            metadata_json, created_at, updated_at, parent_resource_id, source_url,
            indexed_at, index_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    with store._connect() as conn:
        conn.executemany(insert_sql, [store._to_values(item) for item in items])
        conn.executemany(
            "INSERT INTO resource_fts_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [(item.id, item.name, item.summary, "", " ".join(item.capabilities), "", "", "") for item in items],
        )

    engine = ResourceRankingEngine()
    prompts = (
        "interactive anatomy organs in 3d", "mapa de comercios con marcadores",
        "auditoria de un repositorio y dependencias", "graficas y hojas de calculo",
    )

    def measured(prompt: str) -> float:
        start = time.perf_counter()
        candidates = store.recommendation_candidates(engine.expanded_query(prompt), limit=100)
        engine.recommend(prompt, candidates, limit=12)
        return (time.perf_counter() - start) * 1000

    cold_ms = measured(prompts[0])
    for index in range(20):
        measured(prompts[index % len(prompts)])
    samples = [measured(prompts[index % len(prompts)]) for index in range(200)]
    ordered = sorted(samples)
    p95 = ordered[int(len(ordered) * 0.95) - 1]
    p99 = ordered[int(len(ordered) * 0.99) - 1]
    assert cold_ms <= 300, cold_ms
    assert p95 <= 150, {"p50": statistics.median(samples), "p95": p95, "p99": p99}
    assert p99 <= 250, {"p95": p95, "p99": p99}
