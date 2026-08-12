from __future__ import annotations

from dataclasses import dataclass

from app.models import ResourceItem


@dataclass(frozen=True)
class TaxonomyNode:
    id: str
    name: str
    description: str
    parent_id: str | None
    sort_order: int
    tone: str


TAXONOMY_VERSION = 2
TAXONOMY_NODES = (
    TaxonomyNode("rgrp_domain_development", "Desarrollo de software", "Construir, mantener y operar productos", None, 0, "green"),
    TaxonomyNode("rgrp_domain_design", "Diseño de producto", "Diseñar interfaces y explorar referencias visuales", None, 10, "violet"),
    TaxonomyNode("rgrp_domain_agents", "Agentes y automatización", "Crear, orquestar y extender sistemas de agentes", None, 20, "amber"),
    TaxonomyNode("rgrp_domain_quality", "Calidad y seguridad", "Verificar comportamiento, riesgo y robustez", None, 30, "red"),
    TaxonomyNode("rgrp_domain_knowledge", "Conocimiento y contenidos", "Procesar documentos, datos e investigación", None, 40, "blue"),
    TaxonomyNode("rgrp_dev_implementation", "Implementación", "Código, backend, runtimes y pair programming", "rgrp_domain_development", 0, "green"),
    TaxonomyNode("rgrp_dev_interfaces", "Interfaces y visualización", "Frontend, componentes, mapas y gráficas", "rgrp_domain_development", 10, "green"),
    TaxonomyNode("rgrp_dev_architecture", "Arquitectura y mantenimiento", "Análisis, refactorización, diagnóstico y simplicidad", "rgrp_domain_development", 20, "green"),
    TaxonomyNode("rgrp_design_assisted", "Diseño asistido", "Herramientas y criterios para diseñar con agentes", "rgrp_domain_design", 0, "violet"),
    TaxonomyNode("rgrp_design_inspiration", "Inspiración interactiva", "Productos y experiencias para estudiar patrones visuales", "rgrp_domain_design", 10, "violet"),
    TaxonomyNode("rgrp_agents_orchestration", "Orquestación y contexto", "Routing, workflows, memoria y optimización de agentes", "rgrp_domain_agents", 0, "amber"),
    TaxonomyNode("rgrp_agents_extensions", "Skills, plugins e integraciones", "Empaquetar capacidades, MCP y colecciones de skills", "rgrp_domain_agents", 10, "amber"),
    TaxonomyNode("rgrp_agents_web", "Navegación y acción web", "Interacción web autónoma para agentes", "rgrp_domain_agents", 20, "amber"),
    TaxonomyNode("rgrp_quality_testing", "Pruebas y evaluación", "Evals, regresión y pruebas de aplicaciones", "rgrp_domain_quality", 0, "red"),
    TaxonomyNode("rgrp_quality_security", "Seguridad e inteligencia", "Secretos, permisos, amenazas y acciones críticas", "rgrp_domain_quality", 10, "red"),
    TaxonomyNode("rgrp_knowledge_documents", "Documentos y ofimática", "PDF, Word, presentaciones y hojas de cálculo", "rgrp_domain_knowledge", 0, "blue"),
    TaxonomyNode("rgrp_knowledge_rag", "RAG y grafos de conocimiento", "Ingesta, recuperación y navegación semántica", "rgrp_domain_knowledge", 10, "blue"),
    TaxonomyNode("rgrp_knowledge_research", "Investigación y descubrimiento", "Ciencia y catálogos de recursos", "rgrp_domain_knowledge", 20, "blue"),
)

_SLUG_GROUPS = {
    "aider": "rgrp_dev_implementation", "backend-builder": "rgrp_dev_implementation", "bun": "rgrp_dev_implementation",
    "frontend-builder": "rgrp_dev_interfaces", "web-artifacts-builder": "rgrp_dev_interfaces", "mapcn": "rgrp_dev_interfaces", "tanstack-charts": "rgrp_dev_interfaces",
    "ponytail": "rgrp_dev_architecture", "refactoring-guru": "rgrp_dev_architecture", "repo-analyzer": "rgrp_dev_architecture", "witr": "rgrp_dev_architecture",
    "pencil-pen-dev": "rgrp_design_assisted", "impeccable": "rgrp_design_assisted", "emilkowalski-skills": "rgrp_design_assisted", "taste-skill": "rgrp_design_assisted",
    "circle-project-management": "rgrp_design_inspiration", "anatomy-atelier": "rgrp_design_inspiration",
    "karajan": "rgrp_agents_orchestration", "task-router": "rgrp_agents_orchestration", "dify": "rgrp_agents_orchestration", "dspy": "rgrp_agents_orchestration", "gstack": "rgrp_agents_orchestration", "ecc": "rgrp_agents_orchestration", "headroom": "rgrp_agents_orchestration",
    "skill-creator": "rgrp_agents_extensions", "mcp-builder": "rgrp_agents_extensions", "agent-plugins-spec": "rgrp_agents_extensions", "openai-plugin-examples": "rgrp_agents_extensions", "anthropic-skills": "rgrp_agents_extensions", "addyosmani-agent-skills": "rgrp_agents_extensions", "complementos-ia": "rgrp_agents_extensions",
    "browser-use": "rgrp_agents_web",
    "promptfoo": "rgrp_quality_testing", "webapp-testing": "rgrp_quality_testing",
    "cti-analyst": "rgrp_quality_security", "security-review": "rgrp_quality_security",
    "docx": "rgrp_knowledge_documents", "pdf": "rgrp_knowledge_documents", "pdf-inspector": "rgrp_knowledge_documents", "pptx": "rgrp_knowledge_documents", "xlsx": "rgrp_knowledge_documents",
    "llamaindex": "rgrp_knowledge_rag", "graphify": "rgrp_knowledge_rag",
    "scientific-agent-skills": "rgrp_knowledge_research", "itsfree-dev": "rgrp_knowledge_research",
}


def classify_resource(item: ResourceItem) -> TaxonomyNode:
    target_id = _SLUG_GROUPS.get(item.slug)
    if target_id is None:
        corpus = " ".join((item.name, item.summary, *item.tags, *item.capabilities)).casefold()
        if any(term in corpus for term in ("security", "threat", "malware", "seguridad")):
            target_id = "rgrp_quality_security"
        elif any(term in corpus for term in ("test", "eval", "quality", "prueba")):
            target_id = "rgrp_quality_testing"
        elif any(term in corpus for term in ("pdf", "document", "spreadsheet", "presentation")):
            target_id = "rgrp_knowledge_documents"
        elif any(term in corpus for term in ("agent", "skill", "mcp", "plugin")):
            target_id = "rgrp_agents_extensions"
        elif any(term in corpus for term in ("design", "ui", "frontend", "chart", "map")):
            target_id = "rgrp_dev_interfaces"
        else:
            target_id = "rgrp_dev_implementation"
    return next(node for node in TAXONOMY_NODES if node.id == target_id)


def taxonomy_path(item: ResourceItem) -> tuple[TaxonomyNode, TaxonomyNode]:
    leaf = classify_resource(item)
    root = next(node for node in TAXONOMY_NODES if node.id == leaf.parent_id)
    return root, leaf


__all__ = ["TAXONOMY_NODES", "TAXONOMY_VERSION", "TaxonomyNode", "classify_resource", "taxonomy_path"]
