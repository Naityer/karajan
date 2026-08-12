from __future__ import annotations

from app.resource_intelligence import (
    ResourceRankingEngine,
    ResourceSignalExtractor,
    extract_resource_signals,
    normalize_term,
)


def test_extracts_deterministic_repository_signals_with_evidence() -> None:
    metadata = {
        "name": "Research Agent",
        "description": "Multi-agent literature review with a REST API",
        "topics": ["AI Agents", "Research"],
        "language": "Python",
    }
    paths = ["src/api.py", "package.json", "skills/research/SKILL.md", "ui/App.tsx"]
    manifests = {"package.json": {"dependencies": {"react": "^19.0.0"}}}
    readme = "Use FastAPI for scientific research and web search. Includes a CLI and pytest tests."

    first = ResourceSignalExtractor().extract(metadata, paths, readme, manifests)
    second = extract_resource_signals(metadata, reversed(paths), readme, manifests)

    assert first == second
    assert first.primary_taxonomy == "research"
    assert "agents" in first.secondary_taxonomies
    assert {"agent-orchestration", "api-integration", "scientific-research", "web-search", "testing"} <= set(first.capabilities)
    assert {"python", "typescript"} <= set(first.languages)
    assert {"fastapi", "react", "pytest"} <= set(first.frameworks)
    assert {"api", "cli"} <= set(first.interfaces)
    assert "ai-agents" in first.tags
    assert any(item.source == "manifest:package.json" and item.value == "react" for item in first.evidence)


def test_extraction_uses_token_boundaries_and_safe_manifest_serialization() -> None:
    class Unsafe:
        def __str__(self) -> str:  # pragma: no cover - must never be called
            raise AssertionError("untrusted object stringified")

    result = ResourceSignalExtractor().extract(
        {"description": "A reactive UI for capillary measurements"},
        ["notes.txt"],
        manifests={"custom": Unsafe()},
    )

    assert "react" not in result.frameworks
    assert "api" not in result.interfaces  # neither capillary nor reactive contains token "api"


def test_normalization_handles_spanish_accents_and_deduplicates_topics() -> None:
    result = extract_resource_signals(
        {"topics": ["Generación de Imágenes", "generación-de-imágenes"]},
        readme="Generación de imágenes para creación de contenido.",
    )
    assert normalize_term("  Revisión de Código ") == "revision-de-codigo"
    assert result.tags.count("generacion-de-imagenes") == 1
    assert "image-generation" in result.capabilities
    assert "content-creation" in result.use_cases


def test_ranker_is_bilingual_explainable_and_honors_runtime_status_visibility() -> None:
    resources = [
        {
            "id": "best", "name": "Auditor Python", "summary": "Audita aplicaciones",
            "capabilities": ["security-audit", "code-review"], "tags": ["security"],
            "compatible_runtimes": ["codex"], "status": "installed", "visible_agent_ids": [],
            "metadata": {"intelligence": {"primary_taxonomy": "security", "interfaces": ["cli"]}},
        },
        {
            "id": "hidden", "name": "Security helper", "summary": "Security audit",
            "capabilities": ["security-audit"], "tags": ["security"],
            "compatible_runtimes": ["claude"], "status": "available", "visible_agent_ids": ["other"],
            "metadata": {"intelligence": {"primary_taxonomy": "security"}},
        },
        {
            "id": "docs", "name": "PDF Reader", "summary": "Read documents",
            "capabilities": ["document-processing"], "status": "installed", "visible_agent_ids": [],
        },
    ]

    ranked = ResourceRankingEngine().rank(
        "Necesito una auditoría de seguridad y revisión de código con CLI en Codex",
        resources,
        runtime="codex",
        agent_id="agent-1",
    )

    assert [item.resource_id for item in ranked] == ["best", "hidden", "docs"]
    assert ranked[0].role == "primary"
    assert {"security-audit", "code-review", "cli"} <= set(ranked[0].matched_terms)
    assert any("Runtime compatible" in reason for reason in ranked[0].reasons)
    assert any("No visible" in reason for reason in ranked[1].reasons)
    assert ranked[0].score > ranked[1].score > ranked[2].score


def test_ranker_avoids_substring_false_positives_and_has_stable_ties() -> None:
    resources = [
        {"id": "b", "name": "Capillary reactive guide", "summary": "A general guide", "status": "available"},
        {"id": "a", "name": "A general guide", "summary": "Reference", "status": "available"},
    ]
    ranked = ResourceRankingEngine().rank("Necesito API con React", resources)

    assert all("api" not in item.matched_terms and "react" not in item.matched_terms for item in ranked)
    assert [item.resource_id for item in ranked] == ["a", "b"]


def test_ranker_limit_and_resource_object_support() -> None:
    class Resource:
        id = "object"
        name = "Web Search"
        summary = "Search the internet"
        capabilities = ["web-search"]
        tags = ["web"]
        compatible_runtimes = ["codex"]
        status = "available"
        visible_agent_ids: list[str] = []
        metadata = {}

    ranked = ResourceRankingEngine().rank("buscar en internet", [Resource()], limit=1)
    assert len(ranked) == 1
    assert ranked[0].resource is not None
    assert ranked[0].role == "primary"
