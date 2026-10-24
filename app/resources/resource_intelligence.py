"""Deterministic repository intelligence and explainable resource ranking.

The module is deliberately pure: callers provide metadata and file contents that
they have already read.  It performs no I/O, network access, imports, or code
execution, making it safe to use on untrusted repository descriptions.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import asdict, dataclass
from pathlib import PurePosixPath
from typing import Any, Iterable, Mapping, Sequence


# Punctuation is accepted only inside technology names (``next.js``, ``c++``)
# or as C#'s final marker; sentence-ending dots never become part of a token.
_TOKEN_RE = re.compile(r"[a-z0-9]+(?:[.+][a-z0-9+#]+)*#?")
_MAX_README_CHARS = 80_000
_MAX_MANIFEST_CHARS = 40_000


def normalize_term(value: str) -> str:
    """Return a stable, ASCII, kebab-case term suitable for catalog fields."""
    folded = unicodedata.normalize("NFKD", str(value).casefold())
    ascii_value = "".join(char for char in folded if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9+#.]+", "-", ascii_value).strip("-.")


def _tokens(value: str) -> tuple[str, ...]:
    normalized = unicodedata.normalize("NFKD", value.casefold())
    normalized = "".join(char for char in normalized if not unicodedata.combining(char))
    return tuple(_TOKEN_RE.findall(normalized))


def _contains_phrase(tokens: Sequence[str], phrase: str) -> bool:
    """Match complete tokens, preventing matches such as ``react`` in ``reactive``."""
    wanted = _tokens(phrase)
    if not wanted or len(wanted) > len(tokens):
        return False
    width = len(wanted)
    return any(tuple(tokens[index : index + width]) == wanted for index in range(len(tokens) - width + 1))


@dataclass(frozen=True)
class SignalEvidence:
    field: str
    value: str
    source: str
    matched: str


@dataclass(frozen=True)
class ResourceIntelligence:
    primary_taxonomy: str
    secondary_taxonomies: tuple[str, ...]
    tags: tuple[str, ...]
    capabilities: tuple[str, ...]
    languages: tuple[str, ...]
    frameworks: tuple[str, ...]
    interfaces: tuple[str, ...]
    use_cases: tuple[str, ...]
    evidence: tuple[SignalEvidence, ...]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class RankedResource:
    resource: Any
    score: float
    matched_terms: tuple[str, ...]
    reasons: tuple[str, ...]
    role: str
    confidence: float = 0.0
    coverage: float = 0.0
    direct_matches: tuple[str, ...] = ()
    related_matches: tuple[str, ...] = ()
    evidence: tuple[dict[str, Any], ...] = ()

    @property
    def resource_id(self) -> str:
        return str(_get(self.resource, "id", _get(self.resource, "slug", "")))

    def to_dict(self) -> dict[str, Any]:
        return {
            "resource": self.resource,
            "score": self.score,
            "matched_terms": list(self.matched_terms),
            "reasons": list(self.reasons),
            "role": self.role,
            "confidence": self.confidence,
            "coverage": self.coverage,
            "direct_matches": list(self.direct_matches),
            "related_matches": list(self.related_matches),
            "evidence": list(self.evidence),
        }


@dataclass(frozen=True)
class RecommendationResult:
    decision: str
    confidence: float
    coverage: float
    missing_capabilities: tuple[str, ...]
    recommendations: tuple[RankedResource, ...]


# Canonical value -> aliases in English and Spanish.  Keeping this vocabulary
# explicit makes classifications predictable and reviewable.
_CAPABILITIES: dict[str, tuple[str, ...]] = {
    "agent-orchestration": ("agent orchestration", "multi agent", "multi-agent", "orquestacion de agentes", "subagentes"),
    "api-integration": ("api integration", "rest api", "graphql", "integracion api", "endpoint", "webhook"),
    "browser-automation": ("browser automation", "playwright", "selenium", "automatizacion del navegador", "web scraping"),
    "code-generation": ("code generation", "generate code", "generar codigo", "coding assistant"),
    "code-review": ("code review", "pull request review", "revision de codigo", "revisar codigo"),
    "data-analysis": ("data analysis", "analytics", "analisis de datos", "dataframe"),
    "database-access": ("database", "postgres", "sqlite", "base de datos", "sql"),
    "deployment": ("deployment", "deploy", "despliegue", "kubernetes", "terraform"),
    "document-processing": ("document processing", "pdf", "docx", "procesamiento de documentos", "ocr"),
    "data-visualization": ("data visualization", "charts", "graphs", "visualizacion de datos", "graficas", "dashboard"),
    "design-patterns": ("design patterns", "software patterns", "patrones de diseno", "solid", "refactoring"),
    "design-to-code": ("design to code", "design-to-code", "diseno a codigo", "figma", "design canvas"),
    "developer-diagnostics": ("port diagnostics", "process inspection", "occupied port", "puerto ocupado", "inspeccionar procesos"),
    "geospatial-ui": ("web maps", "map components", "geospatial ui", "mapas web", "mapa", "mapas", "marcadores"),
    "image-generation": ("image generation", "generate images", "generacion de imagenes", "text to image"),
    "interactive-3d": ("interactive 3d", "three.js", "threejs", "3d interactivo", "webgl"),
    "plugin-packaging": ("plugin packaging", "agent plugins", "plugin manifest", "empaquetar plugins", "plugin.json"),
    "project-management": ("project management", "timeline view", "gestion de proyectos", "linea de tiempo", "kanban"),
    "rag": ("retrieval augmented generation", "rag", "vector search", "busqueda vectorial"),
    "scientific-research": ("scientific research", "literature review", "investigacion cientifica", "revision bibliografica"),
    "security-audit": ("security audit", "vulnerability scanning", "auditoria de seguridad", "cve", "sast"),
    "testing": ("testing", "unit tests", "pytest", "tdd", "test driven development", "pruebas", "test automation"),
    "web-search": ("web search", "internet search", "busqueda web", "buscar en internet"),
    "tool-discovery": ("tool discovery", "developer resource directory", "free tools", "buscar herramientas", "directorio de recursos"),
    "workflow-automation": ("workflow automation", "automation workflow", "automatizacion de flujos", "pipeline"),
    "anatomy-visualization": ("human anatomy", "anatomy", "organs of the body", "anatomia", "organos del cuerpo", "cuerpo humano"),
    "repository-audit": ("repository audit", "audit repository", "source code repository", "auditoria de repositorio", "auditoria de un repositorio", "auditar repositorio", "analizar repositorio", "revisa el repositorio"),
    "dependency-analysis": ("dependency analysis", "inspect dependencies", "dependencies", "analisis de dependencias", "dependencias"),
    "financial-analysis": ("financial analysis", "stock market", "portfolio risk", "market data", "analisis financiero", "bolsa", "cotizaciones bursatiles", "acciones bursatiles", "mercado de acciones"),
    "spreadsheet-analysis": ("spreadsheet analysis", "spreadsheet", "excel analysis", "analisis de hojas de calculo", "hoja de calculo"),
    "frontend-development": ("frontend development", "frontend", "user interface development", "desarrollo frontend"),
    "map-markers": ("map markers", "markers", "marcadores"),
    "map-routes": ("map routes", "routes on a map", "rutas", "rutas en mapa"),
}

_TAXONOMY_BY_CAPABILITY: dict[str, str] = {
    "agent-orchestration": "agents",
    "api-integration": "software-development",
    "browser-automation": "web",
    "code-generation": "software-development",
    "code-review": "software-development",
    "data-analysis": "data",
    "database-access": "data",
    "deployment": "devops",
    "document-processing": "documents",
    "data-visualization": "data",
    "design-patterns": "software-development",
    "design-to-code": "design",
    "developer-diagnostics": "devops",
    "geospatial-ui": "web",
    "image-generation": "media",
    "interactive-3d": "media",
    "plugin-packaging": "agents",
    "project-management": "productivity",
    "rag": "ai-ml",
    "scientific-research": "research",
    "security-audit": "security",
    "testing": "software-development",
    "web-search": "web",
    "tool-discovery": "research",
    "workflow-automation": "automation",
    "anatomy-visualization": "education",
    "repository-audit": "software-development",
    "dependency-analysis": "software-development",
    "financial-analysis": "finance",
    "spreadsheet-analysis": "data",
    "frontend-development": "software-development",
    "map-markers": "web",
    "map-routes": "web",
}
_TAXONOMY_CAPABILITY_WEIGHT = {
    "agent-orchestration": 2,
    "data-analysis": 2,
    "document-processing": 2,
    "image-generation": 2,
    "rag": 2,
    "scientific-research": 3,
    "security-audit": 3,
}

_LANGUAGE_EXTENSIONS = {
    ".py": "python", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".jsx": "javascript", ".rs": "rust",
    ".go": "go", ".java": "java", ".rb": "ruby", ".php": "php", ".cs": "csharp",
    ".cpp": "cpp", ".cc": "cpp", ".c": "c", ".swift": "swift", ".kt": "kotlin",
    ".scala": "scala", ".r": "r", ".jl": "julia", ".sh": "shell", ".ps1": "powershell",
}
_LANGUAGE_ALIASES = {
    "python": ("python", "pyproject.toml", "requirements.txt"),
    "javascript": ("javascript", "node.js", "nodejs"),
    "typescript": ("typescript",), "rust": ("rust", "cargo.toml"), "go": ("golang", "go.mod"),
    "java": ("java",), "ruby": ("ruby",), "powershell": ("powershell",),
}
_FRAMEWORKS = {
    "django": ("django",), "fastapi": ("fastapi",), "flask": ("flask",),
    "react": ("react", "reactjs"), "nextjs": ("next.js", "nextjs"), "vue": ("vue", "vue.js"),
    "angular": ("angular",), "svelte": ("svelte",), "express": ("express", "expressjs"),
    "nestjs": ("nestjs", "nest.js"), "pytorch": ("pytorch",), "tensorflow": ("tensorflow",),
    "langchain": ("langchain",), "llamaindex": ("llamaindex", "llama index"),
    "playwright": ("playwright",), "pytest": ("pytest",),
}
_INTERFACES = {
    "api": ("api", "endpoint", "webhook"), "cli": ("cli", "command line", "linea de comandos"),
    "mcp": ("mcp", "model context protocol"), "sdk": ("sdk", "client library"),
    "web-ui": ("web ui", "dashboard", "interfaz web"), "library": ("python library", "package", "biblioteca"),
}
_USE_CASES = {
    "developer-tools": ("developer tool", "devtool", "herramienta para desarrolladores"),
    "research": ("research", "investigacion", "literature review"),
    "content-creation": ("content creation", "crear contenido", "creacion de contenido", "marketing content"),
    "operations": ("operations", "observability", "monitoring", "operaciones", "monitorizacion"),
    "education": ("education", "tutorial", "learning", "educacion", "aprendizaje"),
}

_MANIFEST_NAMES = {
    "pyproject.toml", "requirements.txt", "package.json", "cargo.toml", "go.mod",
    "pom.xml", "build.gradle", "dockerfile", "docker-compose.yml", "compose.yaml",
}


class ResourceSignalExtractor:
    """Extract bounded, deterministic signals from already-fetched repository data."""

    def extract(
        self,
        metadata: Mapping[str, Any] | None,
        paths: Iterable[str] = (),
        readme: str = "",
        manifests: Mapping[str, Any] | None = None,
    ) -> ResourceIntelligence:
        metadata = metadata or {}
        safe_paths = tuple(sorted({str(path).replace("\\", "/")[:500] for path in paths if path}))[:10_000]
        sources: list[tuple[str, str]] = []
        for key in ("name", "description", "language"):
            value = metadata.get(key)
            if isinstance(value, str):
                sources.append((f"github.{key}", value[:8_000]))
        topics = metadata.get("topics", ())
        if isinstance(topics, Sequence) and not isinstance(topics, (str, bytes)):
            sources.append(("github.topics", " ".join(str(item) for item in topics[:100] if isinstance(item, str))))
        sources.append(("paths", " ".join(safe_paths)))
        if isinstance(readme, str):
            sources.append(("readme", readme[:_MAX_README_CHARS]))
        for name, content in sorted((manifests or {}).items(), key=lambda item: str(item[0]).casefold())[:100]:
            sources.append((f"manifest:{str(name)[:300]}", _safe_manifest_text(content)))

        evidence: list[SignalEvidence] = []
        capabilities = self._detect(_CAPABILITIES, sources, "capability", evidence)
        languages = set(self._detect(_LANGUAGE_ALIASES, sources, "language", evidence))
        for path in safe_paths:
            suffix = PurePosixPath(path.casefold()).suffix
            language = _LANGUAGE_EXTENSIONS.get(suffix)
            if language:
                languages.add(language)
                evidence.append(SignalEvidence("language", language, "path", suffix))
        language = metadata.get("language")
        if isinstance(language, str) and normalize_term(language):
            languages.add(normalize_term(language))
            evidence.append(SignalEvidence("language", normalize_term(language), "github.language", language[:80]))

        frameworks = self._detect(_FRAMEWORKS, sources, "framework", evidence)
        interfaces = self._detect(_INTERFACES, sources, "interface", evidence)
        use_cases = self._detect(_USE_CASES, sources, "use_case", evidence)

        taxonomy_scores: dict[str, int] = {}
        for capability in capabilities:
            taxonomy = _TAXONOMY_BY_CAPABILITY[capability]
            taxonomy_scores[taxonomy] = taxonomy_scores.get(taxonomy, 0) + _TAXONOMY_CAPABILITY_WEIGHT.get(capability, 1)
        primary = sorted(taxonomy_scores, key=lambda item: (-taxonomy_scores[item], item))[0] if taxonomy_scores else "general"
        secondary = tuple(sorted((item for item in taxonomy_scores if item != primary), key=lambda item: (-taxonomy_scores[item], item)))

        raw_tags = topics if isinstance(topics, Sequence) and not isinstance(topics, (str, bytes)) else ()
        tags = {normalize_term(item) for item in raw_tags if isinstance(item, str) and normalize_term(item)}
        tags.update(capabilities)
        tags.update(frameworks)
        tags.update(interfaces)
        if primary != "general":
            tags.add(primary)
        # De-duplicate evidence emitted by multiple equal path suffixes while retaining provenance.
        unique_evidence = {(item.field, item.value, item.source, item.matched): item for item in evidence}
        return ResourceIntelligence(
            primary_taxonomy=primary,
            secondary_taxonomies=secondary,
            tags=tuple(sorted(tags)),
            capabilities=tuple(sorted(capabilities)),
            languages=tuple(sorted(languages)),
            frameworks=tuple(sorted(frameworks)),
            interfaces=tuple(sorted(interfaces)),
            use_cases=tuple(sorted(use_cases)),
            evidence=tuple(unique_evidence[key] for key in sorted(unique_evidence)),
        )

    @staticmethod
    def _detect(
        vocabulary: Mapping[str, Sequence[str]],
        sources: Sequence[tuple[str, str]],
        field: str,
        evidence: list[SignalEvidence],
    ) -> set[str]:
        found: set[str] = set()
        tokenized = [(source, _tokens(text)) for source, text in sources if text]
        for canonical, aliases in vocabulary.items():
            candidates = (canonical, *aliases)
            for source, tokens in tokenized:
                match = next((alias for alias in candidates if _contains_phrase(tokens, alias)), None)
                if match is not None:
                    found.add(canonical)
                    evidence.append(SignalEvidence(field, canonical, source, match))
                    break
        return found


def _safe_manifest_text(content: Any) -> str:
    if isinstance(content, str):
        return content[:_MAX_MANIFEST_CHARS]
    try:
        # JSON serialization is data-only; default=str is intentionally avoided
        # so arbitrary objects cannot execute custom string conversion.
        return json.dumps(content, ensure_ascii=True, sort_keys=True)[:_MAX_MANIFEST_CHARS]
    except (TypeError, ValueError, RecursionError):
        return ""


def extract_resource_signals(
    metadata: Mapping[str, Any] | None,
    paths: Iterable[str] = (),
    readme: str = "",
    manifests: Mapping[str, Any] | None = None,
) -> ResourceIntelligence:
    return ResourceSignalExtractor().extract(metadata, paths, readme, manifests)


_STOPWORDS = {
    "a", "al", "an", "and", "build", "con", "create", "crear", "de", "del", "el", "en", "for", "from", "i", "la", "las",
    "lo", "los", "me", "necesito", "of", "para", "por", "que", "quiero", "the", "to", "un", "una",
    "use", "using", "want", "with", "y",
}


_RELATED_CAPABILITIES: dict[str, tuple[str, ...]] = {
    "anatomy-visualization": ("interactive-3d", "frontend-development"),
    "geospatial-ui": ("map-markers", "map-routes", "frontend-development", "database-access"),
    "financial-analysis": ("data-analysis", "data-visualization", "spreadsheet-analysis"),
    "repository-audit": ("code-review", "dependency-analysis", "security-audit", "testing"),
}


class ResourceRankingEngine:
    """Rank up to hundreds of resource-like mappings/objects with explanations."""

    def rank(
        self,
        prompt: str,
        resources: Iterable[Any],
        *,
        runtime: str | None = None,
        agent_id: str | None = None,
        limit: int | None = None,
    ) -> list[RankedResource]:
        query_tokens = _tokens(prompt[:20_000])
        query_terms = self._query_concepts(query_tokens)
        related_terms = {value for term in query_terms for value in _RELATED_CAPABILITIES.get(term, ())} - query_terms
        lexical_terms = {token for token in query_tokens if len(token) >= 3 and token not in _STOPWORDS}
        requested_runtime = normalize_term(runtime or "") or self._runtime_from_query(query_tokens)
        ranked = [
            self._score(item, query_terms, related_terms, lexical_terms, requested_runtime, agent_id, prompt)
            for item in resources
        ]
        ranked.sort(key=lambda item: (-item.score, _resource_name(item.resource), item.resource_id))
        if limit is not None:
            return ranked[: max(0, limit)]
        return ranked

    def expanded_query(self, prompt: str) -> str:
        tokens = _tokens(prompt[:20_000])
        direct = self._query_concepts(tokens)
        related = {value for concept in direct for value in _RELATED_CAPABILITIES.get(concept, ())}
        return " ".join(dict.fromkeys((*tokens, *sorted(direct), *sorted(related))))

    def recommend(
        self,
        prompt: str,
        resources: Iterable[Any],
        *,
        runtime: str | None = None,
        agent_id: str | None = None,
        limit: int = 12,
    ) -> RecommendationResult:
        required = self._query_concepts(_tokens(prompt[:20_000]))
        ranked = self.rank(prompt, resources, runtime=runtime, agent_id=agent_id)
        useful = [entry for entry in ranked if entry.direct_matches or entry.related_matches or entry.score >= 45]
        child_parent_ids = {
            str(_get(entry.resource, "parent_resource_id", ""))
            for entry in useful if _get(entry.resource, "parent_resource_id", None)
        }
        prompt_name = normalize_term(prompt)
        useful = [
            entry for entry in useful
            # Exact artifact lookup remains addressable after child indexing.
            if entry.resource_id not in child_parent_ids or prompt_name == _resource_name(entry.resource)
        ]
        primaries = [entry for entry in useful if entry.role == "primary"]
        covered = set().union(*(set(entry.direct_matches) for entry in primaries)) if primaries else set()
        missing = tuple(sorted(required - covered))
        coverage = len(covered) / len(required) if required else (1.0 if primaries else 0.0)
        decision = "matched" if primaries and coverage >= 0.5 else ("partial" if primaries else "no_match")
        return RecommendationResult(
            decision=decision,
            confidence=primaries[0].confidence if primaries else 0.0,
            coverage=round(coverage, 4),
            missing_capabilities=missing,
            recommendations=tuple(useful[: max(0, limit)]),
        )

    @staticmethod
    def _query_concepts(query_tokens: Sequence[str]) -> set[str]:
        vocabularies = (_CAPABILITIES, _FRAMEWORKS, _INTERFACES, _USE_CASES, _LANGUAGE_ALIASES)
        found: set[str] = set()
        for vocabulary in vocabularies:
            for canonical, aliases in vocabulary.items():
                if any(_contains_phrase(query_tokens, alias) for alias in (canonical, *aliases)):
                    found.add(canonical)
        # Editorial families (web, data, software...) are intentionally not
        # query capabilities: generic words must not manufacture a primary.
        return found

    @staticmethod
    def _runtime_from_query(tokens: Sequence[str]) -> str:
        for runtime, aliases in {
            "codex": ("codex",), "claude": ("claude",), "windows": ("windows",),
            "linux": ("linux",), "macos": ("macos", "mac os"), "docker": ("docker",),
        }.items():
            if any(_contains_phrase(tokens, alias) for alias in aliases):
                return runtime
        return ""

    def _score(
        self,
        resource: Any,
        query_terms: set[str],
        related_terms: set[str],
        lexical_terms: set[str],
        runtime: str,
        agent_id: str | None,
        prompt: str,
    ) -> RankedResource:
        fields = _resource_fields(resource)
        concept_union = set().union(*fields.values())
        matched = query_terms & concept_union
        related = related_terms & concept_union
        lexical_corpus = set(_tokens(" ".join(_resource_text_values(resource))))
        lexical_matches = lexical_terms & lexical_corpus
        reasons: list[str] = []
        score = 0.0
        coverage = len(matched) / len(query_terms) if query_terms else 0.0
        if query_terms:
            score += 62 * coverage
            if matched:
                reasons.append(f"Cubre {len(matched)}/{len(query_terms)} intenciones: {', '.join(sorted(matched))}")
        if matched & fields["capabilities"]:
            score += 15
            reasons.append("Coincidencia directa de capacidad")
        if matched & fields["tags"]:
            score += 8
            reasons.append("Etiquetas alineadas")
        if matched & fields["taxonomy"]:
            score += 8
            reasons.append("Taxonomía alineada")
        if matched & (fields["frameworks"] | fields["interfaces"] | fields["languages"] | fields["use_cases"]):
            score += 8
            reasons.append("Tecnología o caso de uso compatible")
        if lexical_matches:
            lexical_score = min(8.0, 2.0 * len(lexical_matches))
            score += lexical_score
            reasons.append(f"Términos textuales: {', '.join(sorted(lexical_matches)[:6])}")

        if related:
            score += min(22.0, 9.0 * len(related))
            reasons.append("Complementary capabilities: " + ", ".join(sorted(related)))

        exact_name = normalize_term(prompt) == _resource_name(resource)
        if exact_name:
            score += 75
            reasons.append("Exact resource name")

        runtimes = _normalized_values(_get(resource, "compatible_runtimes", ()))
        if runtime:
            if runtime in runtimes:
                score += 6
                reasons.append(f"Runtime compatible: {runtime}")
            elif runtimes:
                score -= 6
                reasons.append(f"Runtime solicitado no declarado: {runtime}")

        status = normalize_term(str(_get(resource, "status", "available")))
        status_points = {"installed": 5, "available": 3, "partial": 1, "error": -8}.get(status, 0)
        score += status_points
        reasons.append(f"Estado: {status or 'desconocido'}")

        visible_to = _normalized_values(_get(resource, "visible_agent_ids", ()))
        if not visible_to:
            score += 3
            reasons.append("Visibilidad pública")
        elif agent_id and normalize_term(agent_id) in visible_to:
            score += 3
            reasons.append("Visible para el agente solicitado")
        elif agent_id:
            score -= 12
            reasons.append("No visible para el agente solicitado")

        functional_match = matched & (fields["capabilities"] | fields["use_cases"])
        role = "primary" if exact_name or (functional_match and coverage >= 0.34 and score >= 55) else "complementary"
        matched_terms = tuple(sorted(matched | lexical_matches))
        confidence = min(1.0, (0.72 * coverage) + (0.18 if functional_match else 0) + (0.1 if exact_name else 0))
        evidence = tuple(
            item for item in _intelligence_mapping(resource).get("evidence", ()) if isinstance(item, dict)
        )[:12]
        return RankedResource(
            resource=resource,
            score=round(max(0.0, min(100.0, score)), 2),
            matched_terms=matched_terms,
            reasons=tuple(reasons),
            role=role,
            confidence=round(confidence, 4),
            coverage=round(coverage, 4),
            direct_matches=tuple(sorted(matched)),
            related_matches=tuple(sorted(related)),
            evidence=evidence,
        )


def _get(resource: Any, name: str, default: Any = None) -> Any:
    if isinstance(resource, Mapping):
        return resource.get(name, default)
    return getattr(resource, name, default)


def _normalized_values(value: Any) -> set[str]:
    if isinstance(value, str):
        values = (value,)
    elif isinstance(value, Iterable) and not isinstance(value, (bytes, Mapping)):
        values = value
    else:
        values = ()
    return {normalized for item in values if (normalized := normalize_term(str(item)))}


def _intelligence_mapping(resource: Any) -> Mapping[str, Any]:
    intelligence = _get(resource, "intelligence")
    if isinstance(intelligence, ResourceIntelligence):
        return intelligence.to_dict()
    if isinstance(intelligence, Mapping):
        return intelligence
    metadata = _get(resource, "metadata", {})
    if isinstance(metadata, Mapping):
        nested = metadata.get("intelligence", metadata.get("resource_intelligence", {}))
        if isinstance(nested, ResourceIntelligence):
            return nested.to_dict()
        if isinstance(nested, Mapping):
            return nested
    return {}


def _resource_fields(resource: Any) -> dict[str, set[str]]:
    intel = _intelligence_mapping(resource)
    primary = intel.get("primary_taxonomy", _get(resource, "primary_taxonomy", ""))
    secondary = intel.get("secondary_taxonomies", _get(resource, "secondary_taxonomies", ()))
    return {
        "capabilities": _normalized_values(intel.get("capabilities", _get(resource, "capabilities", ()))),
        "tags": _normalized_values(intel.get("tags", _get(resource, "tags", ()))),
        "taxonomy": _normalized_values((primary,)) | _normalized_values(secondary),
        "languages": _normalized_values(intel.get("languages", ())),
        "frameworks": _normalized_values(intel.get("frameworks", ())),
        "interfaces": _normalized_values(intel.get("interfaces", ())),
        "use_cases": _normalized_values(intel.get("use_cases", ())),
    }


def _resource_text_values(resource: Any) -> tuple[str, ...]:
    intel = _intelligence_mapping(resource)
    values: list[str] = []
    for name in ("name", "summary"):
        value = _get(resource, name, "")
        if isinstance(value, str):
            values.append(value[:8_000])
    for name in ("tags", "capabilities", "languages", "frameworks", "interfaces", "use_cases"):
        value = intel.get(name, _get(resource, name, ()))
        if isinstance(value, Iterable) and not isinstance(value, (str, bytes, Mapping)):
            values.extend(str(item)[:200] for item in value)
    return tuple(values)


def _resource_name(resource: Any) -> str:
    return normalize_term(str(_get(resource, "name", _get(resource, "slug", ""))))


def rank_resources(
    prompt: str,
    resources: Iterable[Any],
    *,
    runtime: str | None = None,
    agent_id: str | None = None,
    limit: int | None = None,
) -> list[RankedResource]:
    return ResourceRankingEngine().rank(prompt, resources, runtime=runtime, agent_id=agent_id, limit=limit)


# Concise compatibility aliases for callers that prefer domain nouns.
RepositoryIntelligenceExtractor = ResourceSignalExtractor
ExplainableResourceRanker = ResourceRankingEngine


__all__ = [
    "ExplainableResourceRanker", "RankedResource", "RecommendationResult", "RepositoryIntelligenceExtractor",
    "ResourceIntelligence", "ResourceRankingEngine", "ResourceSignalExtractor", "SignalEvidence",
    "extract_resource_signals", "normalize_term", "rank_resources",
]
