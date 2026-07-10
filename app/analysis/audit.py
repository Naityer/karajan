"""Facade de auditoria: detectores deterministas en `code_graph`, narrativa LLM en Karajan.

Los detectores se re-exportan desde `code_graph.analysis.audit`. La narrativa
opcional en lenguaje natural (que SI depende de los proveedores de Karajan) se
implementa aqui como un `AuditNarrator` y se inyecta en el `run_audit` puro del
paquete, conservando la firma publica que Karajan ya usa (`include_llm`/`config`).
"""

from __future__ import annotations

import logging

from code_graph.analysis.audit import (  # noqa: F401  (re-exportados para compatibilidad)
    _SEVERITY_ORDER,
    detect_circular_imports,
    detect_file_text_issues,
    detect_god_class,
    detect_high_complexity,
    detect_large_file,
    detect_long_function,
    run_audit as _run_audit_core,
    scan_secrets_in_text,
)
from code_graph.models import AuditResult, Finding, GraphNode
from code_graph.store import GraphStore, safe_resolve  # noqa: F401
from app.models import KarajanConfig, RecommendedModel

logger = logging.getLogger("karajan.audit")


def run_audit(
    repo_id: str,
    store: GraphStore,
    *,
    include_llm: bool = False,
    config: KarajanConfig | None = None,
) -> AuditResult:
    """Firma publica historica de Karajan. Delega en el run_audit puro de
    `code_graph`, inyectando el narrador LLM de Karajan cuando `include_llm`."""
    narrator = _KarajanNarrator(repo_id, config) if include_llm else None
    return _run_audit_core(repo_id, store, narrator=narrator)


class _KarajanNarrator:
    """Adapta la narrativa LLM de Karajan al contrato `AuditNarrator`."""

    def __init__(self, repo_id: str, config: KarajanConfig | None) -> None:
        self._repo_id = repo_id
        self._config = config

    def narrate(self, findings, nodes, repo):
        return _llm_narrative(self._repo_id, findings, nodes, repo, self._config)


def _llm_narrative(
    repo_id: str,
    findings: list[Finding],
    nodes: list[GraphNode],
    repo,
    config: KarajanConfig | None,
) -> tuple[str | None, bool]:
    """Best-effort Spanish audit narrative. Returns (summary_or_None, truncated)."""
    resolution = resolve_graph_provider(repo, config)
    if resolution is None:
        return None, False

    name_by_id = {n.id: (n.qualified_name or n.name or n.id) for n in nodes}
    # Rank findings by severity, then group into a bounded prompt (~20 files).
    ranked = sorted(
        findings, key=lambda f: _SEVERITY_ORDER.get(f.severity, 0), reverse=True
    )
    files_seen: list[str] = []
    lines: list[str] = []
    truncated = False
    for f in ranked:
        loc = name_by_id.get(f.node_id, f.node_id or "?")
        if loc not in files_seen:
            if len(files_seen) >= 20:
                truncated = True
                continue
            files_seen.append(loc)
        lines.append(f"- [{f.severity}] {f.detector} @ {loc}: {f.message}")
    if len(lines) > 60:
        truncated = True
        lines = lines[:60]

    instruction = (
        "Eres un auditor de código senior. A partir de estos hallazgos "
        "deterministas de un repositorio, redacta un resumen breve y priorizado "
        "en español (máximo ~200 palabras) sobre patrones de diseño, "
        "responsabilidad única (SRP), seguridad y optimización. Indica qué "
        "arreglar primero.\n\nHallazgos:\n" + "\n".join(lines)
    )
    try:
        run = resolution.provider.run(instruction, resolution.model_id, timeout_s=120)
    except Exception as exc:  # provider blew up — never fail the audit
        logger.warning("audit LLM narrative failed for %s: %s", repo_id, exc)
        return None, truncated
    if run.error or not (run.output or "").strip():
        logger.info("audit LLM narrative empty/error for %s: %s", repo_id, run.error)
        return None, truncated
    return run.output.strip(), truncated


def resolve_graph_provider(
    repo,
    config: KarajanConfig | None,
    tier: RecommendedModel = RecommendedModel.MEDIUM_MODEL,
):
    """Resolve the provider for Grafo explain/audit under the documented order:
    repo.provider_override -> config.graph_agent_provider ->
    config.provider_preferences['medium_model'] -> first ready provider.

    Only providers currently `ready` (credential/binary present, model/server up)
    are returned, so callers can surface a clean "no provider" state instead of
    invoking something that will stall. Returns a `Resolution` or None.
    """
    from app import catalog, credentials
    from app.providers import registry

    ready = {s.provider for s in credentials.detect_all() if s.ready}

    candidates: list[str] = []
    if repo is not None and getattr(repo, "provider_override", None):
        candidates.append(repo.provider_override)
    if config is not None and config.graph_agent_provider:
        candidates.append(config.graph_agent_provider)
    if config is not None:
        pref = config.provider_preferences.get(RecommendedModel.MEDIUM_MODEL.value)
        if pref:
            candidates.append(pref)

    for name in candidates:
        if name in ready:
            res = registry.resolve_by_name(name, tier)
            if res is not None:
                return res

    for info in catalog.all_providers():
        if info.name in ready:
            res = registry.resolve_by_name(info.name, tier)
            if res is not None:
                return res
    return None
