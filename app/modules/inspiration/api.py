"""API del módulo Inspiration.

Biblioteca de recursos (skills, plantillas, referencias), sus grupos, fuentes de descubrimiento y el mantenimiento periódico del catálogo.

Movida tal cual desde `app/main.py` (nota "Plan de mejora", §17): mismas
rutas, mismos modelos de respuesta, mismas guardas de autenticación. Lo
único que cambia es que el almacén y los servicios ya no son globals del
módulo `main` — se resuelven contra el runtime activo en cada petición.
"""

from __future__ import annotations

import hashlib
import re
import threading
import uuid
from datetime import (
    datetime,
    timezone,
)
from io import BytesIO
from urllib.parse import urlsplit, urlunsplit

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
)
from fastapi.responses import StreamingResponse

from app import events
from app import runtime as runtime_module
from app.atlas_auth import require_atlas_token
from app.auth import require_token
from app.inspiration_feed import (
    DEFAULT_SOURCE_IDS,
    SOURCES,
    source_catalog,
)
from app.models import (
    AnalyzeRequest,
    AnalyzeResult,
    ArtifactReviewDecisionRequest,
    ArtifactValidityPolicy,
    ArtifactValidityPolicyImpactRequest,
    ArtifactValidityPolicyUpdate,
    DiscoverySource,
    DiscoverySourceCreateRequest,
    InspirationSourcePreference,
    ResourceCreateRequest,
    ResourceGroup,
    ResourceGroupAssignmentsRequest,
    ResourceGroupCreateRequest,
    ResourceGroupUpdateRequest,
    ResourceIndexRequest,
    ResourceItem,
    ResourceKind,
    ResourceOperationRequest,
    ResourceOperationResult,
    ResourceRecommendationRequest,
    ResourceRefreshSettingsUpdate,
    ResourceUpdateRequest,
    ResourceVisibilityRequest,
)
from app.resource_intelligence import rank_resources
from app.resource_inventory import create_inventory_snapshot, get_inventory_snapshot
from app.resource_sources import classify_external_url
from app.resource_validity import (
    PolicyResetConfirmationRequired,
    PolicyVersionConflict,
    decide_resource,
    decorate_catalog_resources,
    decorate_resource,
    is_internal_repository_component,
    is_internal_local_reference,
    is_local_repository_alias,
    load_policy,
    policy_impact,
    update_policy,
)
from app.web_references import validate_reference_url


def _github_resource_parts(value: str) -> tuple[str, str, bool] | None:
    """Return (repository root, canonical source path, is_internal_path)."""
    parsed = urlsplit(str(value or "").strip())
    if parsed.scheme != "https" or (parsed.hostname or "").casefold() != "github.com":
        return None
    if parsed.username or parsed.password or parsed.port or parsed.query or parsed.fragment:
        raise ValueError("Las URLs GitHub no pueden incluir credenciales, puertos, consultas ni fragmentos")
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) < 2:
        raise ValueError("La URL debe apuntar a un repositorio GitHub o a un componente interno")
    owner, repository = parts[:2]
    if repository.endswith(".git"):
        repository = repository[:-4]
    root = urlunsplit(("https", "github.com", f"/{owner}/{repository}", "", ""))
    source = urlunsplit(("https", "github.com", "/" + "/".join([owner, repository, *parts[2:]]), "", ""))
    return root, source, len(parts) > 2

router = APIRouter(tags=["inspiration"])


_resource_operation_guard = threading.Lock()
_active_resource_operations: set[str] = set()
_resource_analysis_guard = threading.Lock()
_resource_analysis_tickets: dict[str, tuple[float, ResourceCreateRequest]] = {}


def _resource_or_404(resource_id: str) -> ResourceItem:
    try:
        return runtime_module.current().resources.get(resource_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="resource not found") from exc


def _ensure_resource_groups() -> list[ResourceGroup]:
    return runtime_module.current().resources.ensure_default_groups()


@router.get("/resource-groups", response_model=list[ResourceGroup])
def list_resource_groups() -> list[ResourceGroup]:
    """Return the operator-defined catalog classification in display order."""
    return _ensure_resource_groups()


@router.post("/resource-groups", response_model=ResourceGroup)
def create_resource_group(
    request: ResourceGroupCreateRequest,
    _: None = Depends(require_token),
    __: dict | None = Depends(require_atlas_token),
) -> ResourceGroup:
    _ensure_resource_groups()
    try:
        group = runtime_module.current().resources.create_group(request)
    except KeyError as exc:
        raise HTTPException(status_code=422, detail="parent resource group not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    events.publish("resource_changed", scope="resource_groups", group_id=group.id)
    return group


@router.put("/resource-groups/assignments", response_model=list[ResourceGroup])
def update_resource_group_assignments(
    request: ResourceGroupAssignmentsRequest,
    _: None = Depends(require_token),
    __: dict | None = Depends(require_atlas_token),
) -> list[ResourceGroup]:
    _ensure_resource_groups()
    try:
        groups = runtime_module.current().resources.assign_groups(request.assignments)
    except KeyError as exc:
        raise HTTPException(status_code=422, detail=str(exc).strip("'")) from exc
    events.publish(
        "resource_changed",
        scope="resource_groups",
        resource_ids=sorted(request.assignments),
    )
    return groups


@router.put("/resource-groups/{group_id}", response_model=ResourceGroup)
def update_resource_group(
    group_id: str,
    request: ResourceGroupUpdateRequest,
    _: None = Depends(require_token),
    __: dict | None = Depends(require_atlas_token),
) -> ResourceGroup:
    _ensure_resource_groups()
    if group_id not in {group.id for group in runtime_module.current().resources.list_groups()}:
        raise HTTPException(status_code=404, detail="resource group not found")
    try:
        group = runtime_module.current().resources.update_group(group_id, request)
    except KeyError as exc:
        raise HTTPException(status_code=422, detail="parent resource group not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    events.publish("resource_changed", scope="resource_groups", group_id=group.id)
    return group


@router.delete("/resource-groups/{group_id}")
def delete_resource_group(
    group_id: str,
    confirmed: bool = Query(default=False),
    move_to_id: str | None = Query(default=None, max_length=160),
    _: None = Depends(require_token),
    __: dict | None = Depends(require_atlas_token),
) -> dict:
    _ensure_resource_groups()
    if not confirmed:
        raise HTTPException(status_code=409, detail="confirmed=true is required to delete a resource group")
    if group_id not in {group.id for group in runtime_module.current().resources.list_groups()}:
        raise HTTPException(status_code=404, detail="resource group not found")
    try:
        runtime_module.current().resources.delete_group(group_id, move_to_id=move_to_id)
    except KeyError as exc:
        raise HTTPException(status_code=422, detail="destination resource group not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    events.publish("resource_changed", scope="resource_groups", group_id=group_id)
    return {"deleted": group_id, "move_to_id": move_to_id}


@router.get("/resources", response_model=list[ResourceItem])
def list_resources(
    q: str | None = Query(default=None, max_length=200),
    kind: ResourceKind | None = None,
    status: str | None = Query(default=None, max_length=40),
    runtime: str | None = Query(default=None, max_length=80),
    agent_id: str | None = Query(default=None, max_length=160),
    source: str | None = Query(default=None, max_length=80),
    tags: list[str] | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    accepted_only: bool = Query(default=False),
) -> list[ResourceItem]:
    """Searchable catalog shared by the dashboard and autonomous agents."""
    if q and q.strip():
        ranked = rank_resources(
            q,
            runtime_module.current().resources.recommendation_candidates(runtime_module.current().resource_ranking_engine.expanded_query(q), limit=100),
            runtime=runtime,
            agent_id=agent_id,
        )
        matched_items = [result.resource for result in ranked if result.matched_terms]
        items = matched_items or runtime_module.current().resources.search(q, limit=500)
    else:
        items = runtime_module.current().resources.list_all_resources(kind=kind, source=source)
    requested_tags = {tag.casefold() for tag in (tags or []) if tag.strip()}
    filtered = [
        item
        for item in items
        if (kind is None or item.kind == kind)
        and (source is None or item.source == source)
        and (status is None or item.status == status)
        and (runtime is None or runtime.casefold() in {value.casefold() for value in item.compatible_runtimes})
        and (agent_id is None or not item.visible_agent_ids or agent_id in item.visible_agent_ids)
        and (not requested_tags or requested_tags <= {value.casefold() for value in item.tags})
    ]
    # A repository is one catalog resource even when it was seeded previously
    # by Naityer and later analyzed from GitHub. Keep the richest record.
    unique: dict[str, ResourceItem] = {}
    for item in filtered:
        identity = (item.repo_url or f"id:{item.id}").rstrip("/").casefold()
        current = unique.get(identity)
        if current is None or (len(item.summary), len(item.capabilities), len(item.metadata)) > (len(current.summary), len(current.capabilities), len(current.metadata)):
            unique[identity] = item
    policy = load_policy(runtime_module.current().resources)
    selected = list(unique.values())
    parent_ids = {item.parent_resource_id for item in selected if item.parent_resource_id}
    parents = [runtime_module.current().resources.get(parent_id) for parent_id in parent_ids if parent_id]
    decorated = decorate_catalog_resources(selected, policy, parent_items=parents)
    if accepted_only:
        decorated = [item for item in decorated if not (item.metadata.get("validity") or {}).get("alias_of")]
    if accepted_only:
        decorated = [
            item for item in decorated
            if item.metadata.get("validity", {}).get("state") in {"accepted", "accepted_override"}
        ]
    return decorated[offset : offset + limit]


@router.get("/resources/index")
def resources_agent_index() -> dict:
    """Compact, stable inventory intended for agent discovery and retrieval."""
    items = runtime_module.current().resources.list_all_resources()
    return {
        "version": 2,
        "count": len(items),
        "resources": [
            {
                "id": item.id,
                "slug": item.slug,
                "name": item.name,
                "kind": item.kind.value,
                "summary": item.summary,
                "tags": item.tags,
                "capabilities": item.capabilities,
                "status": item.status,
                "runtimes": item.compatible_runtimes,
                "visible_agent_ids": item.visible_agent_ids,
                "repo_url": item.repo_url,
                "homepage_url": item.metadata.get("homepage_url"),
                "intelligence": item.metadata.get("intelligence", {}),
                "parent_resource_id": item.parent_resource_id,
                "source_url": item.source_url,
                "index_status": item.index_status,
            }
            for item in items
        ],
    }


@router.post("/resources/recommend")
def recommend_resources(request: ResourceRecommendationRequest) -> dict:
    """Return an explainable primary/complementary resource decision for a prompt."""
    candidates = runtime_module.current().resources.recommendation_candidates(
        runtime_module.current().resource_ranking_engine.expanded_query(request.prompt), limit=100
    )
    if request.agent_id:
        candidates = [
            item for item in candidates
            if not item.visible_agent_ids or request.agent_id in item.visible_agent_ids
        ]
    result = runtime_module.current().resource_ranking_engine.recommend(
        request.prompt,
        candidates,
        runtime=request.runtime,
        agent_id=request.agent_id,
        limit=request.limit,
    )
    useful = list(result.recommendations)
    if not request.include_complementary:
        useful = [entry for entry in useful if entry.role == "primary"]
    selected = useful[: request.limit]
    return {
        "version": 2,
        "prompt": request.prompt,
        "count": len(selected),
        "decision": result.decision,
        "confidence": result.confidence,
        "coverage": result.coverage,
        "missing_capabilities": list(result.missing_capabilities),
        "recommendations": [
            {
                "resource": entry.resource.model_dump(mode="json"),
                "score": entry.score,
                "role": entry.role,
                "matched_terms": list(entry.matched_terms),
                "reasons": list(entry.reasons),
                "confidence": entry.confidence,
                "coverage": entry.coverage,
                "direct_matches": list(entry.direct_matches),
                "related_matches": list(entry.related_matches),
                "evidence": list(entry.evidence),
                "parent_resource": (
                    runtime_module.current().resources.get(entry.resource.parent_resource_id).model_dump(mode="json")
                    if entry.resource.parent_resource_id else None
                ),
            }
            for entry in selected
        ],
    }


def _selected_inspiration_sources() -> list[str]:
    stored = runtime_module.current().resources.get_preference("inspiration_source_ids", list(DEFAULT_SOURCE_IDS))
    if not isinstance(stored, list):
        return list(DEFAULT_SOURCE_IDS)
    return [source_id for source_id in stored if source_id in SOURCES]


def _custom_inspiration_sources() -> list[DiscoverySource]:
    return runtime_module.current().resources.list_discovery_sources()


@router.get("/resources/discovery/sources")
def inspiration_sources() -> dict:
    """Allowlisted discovery sources and the operator's current selection."""
    selected = _selected_inspiration_sources()
    custom_sources = _custom_inspiration_sources()
    custom = [source.model_dump(mode="json") | {"homepage": source.url} for source in custom_sources]
    selected_ids = [*selected, *(source.id for source in custom_sources if source.enabled)]
    return {"sources": [*source_catalog(selected), *custom], "selected_source_ids": selected_ids}


@router.post("/resources/discovery/sources", response_model=DiscoverySource)
def create_inspiration_source(
    request: DiscoverySourceCreateRequest,
    _: None = Depends(require_token),
) -> DiscoverySource:
    try:
        classification = classify_external_url(request.url)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if classification.role != "discovery_source":
        raise HTTPException(status_code=422, detail="La URL no parece una cuenta o fuente de seguimiento")
    parsed = urlsplit(classification.canonical_url)
    handle = parsed.path.strip("/").removeprefix("@") or classification.provider
    digest = hashlib.sha256(classification.canonical_url.encode("utf-8")).hexdigest()[:12]
    source = runtime_module.current().resources.upsert_discovery_source(DiscoverySource(
        id=f"custom-{classification.provider}-{digest}",
        name=(request.name or f"{handle} · {classification.provider.title()}").strip(),
        url=classification.canonical_url,
        provider=classification.provider,
        source_type="account",
        enabled=request.enabled,
        available=False,
        requires_credentials=classification.provider in {"threads", "x"},
        setup_hint=("Configura la API de Meta Threads para leer sus publicaciones."
                    if classification.provider == "threads" else "Configura el conector de esta fuente."),
        metadata={"classification_evidence": list(classification.evidence)},
    ))
    events.publish("resource_changed", scope="discovery_sources", source_id=source.id)
    return source


@router.put("/resources/discovery/sources")
def update_inspiration_sources(
    request: InspirationSourcePreference,
    _: None = Depends(require_token),
    __: dict | None = Depends(require_atlas_token),
) -> dict:
    custom_by_id = {source.id: source for source in _custom_inspiration_sources()}
    unknown = sorted(set(request.source_ids) - set(SOURCES) - set(custom_by_id))
    if unknown:
        raise HTTPException(status_code=422, detail=f"unknown discovery sources: {', '.join(unknown)}")
    unavailable = sorted(
        source_id for source_id in request.source_ids
        if ((source_id in SOURCES and not SOURCES[source_id]["available"])
            or (source_id in custom_by_id and not custom_by_id[source_id].available))
    )
    if unavailable:
        raise HTTPException(
            status_code=409,
            detail=f"sources require configuration before enabling: {', '.join(unavailable)}",
        )
    selected = [source_id for source_id in request.source_ids if source_id in SOURCES]
    runtime_module.current().resources.set_preference("inspiration_source_ids", selected)
    events.publish("resource_changed", scope="discovery_sources")
    custom_sources = _custom_inspiration_sources()
    custom = [source.model_dump(mode="json") | {"homepage": source.url} for source in custom_sources]
    selected_ids = [*selected, *(source.id for source in custom_sources if source.enabled)]
    return {"sources": [*source_catalog(selected), *custom], "selected_source_ids": selected_ids}


@router.get("/resources/discovery/feed")
def inspiration_discovery_feed(limit: int = Query(default=18, ge=1, le=50)) -> dict:
    """Latest entries from selected sources; failures remain visible per source."""
    selected = _selected_inspiration_sources()
    result = runtime_module.current().inspiration_feed.fetch(selected, limit=limit)
    custom_errors = {
        source.id: source.setup_hint or "Fuente pendiente de configurar."
        for source in _custom_inspiration_sources()
        if source.enabled and not source.available
    }
    result["errors"] = {**result.get("errors", {}), **custom_errors}
    return {**result, "selected_source_ids": selected}


@router.get("/resources/refresh/settings")
def resource_refresh_settings() -> dict:
    """Persistent maintenance cadence shared by the catalog and Radar UI."""
    return runtime_module.current().resource_refresh.status()


@router.put("/resources/refresh/settings")
def update_resource_refresh_settings(
    request: ResourceRefreshSettingsUpdate,
    _: None = Depends(require_token),
) -> dict:
    runtime_module.current().resource_refresh.update_settings(request)
    events.publish("resource_changed", scope="refresh_settings")
    return runtime_module.current().resource_refresh.status()


@router.post("/resources/refresh/run")
async def run_resource_refresh(
    request: ResourceIndexRequest,
    _: None = Depends(require_token),
) -> dict:
    if not request.confirmed:
        raise HTTPException(status_code=409, detail="explicit confirmation is required")
    try:
        return runtime_module.current().resource_refresh.start_full_refresh(force=True)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/resources/refresh/runs/{run_id}")
def resource_refresh_run_status(run_id: str) -> dict:
    """Return durable progress for a full-catalog analysis job."""
    try:
        result = runtime_module.current().resource_refresh.job_status(run_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="resource refresh run not found") from exc
    if result is None:
        raise HTTPException(status_code=404, detail="resource refresh run not found")
    return result


@router.post("/resources/analyze", response_model=AnalyzeResult)
def analyze_resource(
    request: AnalyzeRequest,
    _: None = Depends(require_token),
) -> AnalyzeResult:
    try:
        classification = classify_external_url(request.repo_url)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if classification.role == "discovery_source":
        parsed = urlsplit(classification.canonical_url)
        handle = parsed.path.strip("/").removeprefix("@") or classification.provider
        return AnalyzeResult(
            valid=True,
            repo_url=classification.canonical_url,
            summary="Fuente de seguimiento para descubrir publicaciones y posibles recursos.",
            preview=ResourceCreateRequest(
                slug=re.sub(r"[^a-z0-9]+", "-", f"{classification.provider}-{handle}".casefold()).strip("-")[:120],
                name=f"{handle} · {classification.provider.title()}",
                kind=ResourceKind.REFERENCE,
                source=classification.provider,
                repo_url=classification.canonical_url,
                summary="Fuente de seguimiento para descubrir publicaciones y posibles recursos.",
                metadata={"source_role": "discovery_source"},
            ),
        )
    try:
        github_parts = _github_resource_parts(request.repo_url)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    result = (
        runtime_module.current().resource_analyzer.analyze(github_parts[0])
        if github_parts
        else runtime_module.current().web_reference_analyzer.analyze(request.repo_url)
    )
    if not result.valid or result.preview is None:
        return result
    if github_parts and github_parts[2]:
        root, source, _ = github_parts
        result = result.model_copy(update={
            "repo_url": root,
            "preview": result.preview.model_copy(update={"repo_url": root, "source_url": source}),
        })
    token = uuid.uuid4().hex
    now = datetime.now(timezone.utc).timestamp()
    with _resource_analysis_guard:
        for expired in [key for key, (created, _) in _resource_analysis_tickets.items() if now - created > 900]:
            _resource_analysis_tickets.pop(expired, None)
        _resource_analysis_tickets[token] = (now, result.preview)
    return result.model_copy(update={"analysis_token": token})


@router.post("/resources", response_model=ResourceItem)
def create_resource(
    request: ResourceCreateRequest,
    _: None = Depends(require_token),
) -> ResourceItem:
    if request.repo_url:
        try:
            classification = classify_external_url(request.repo_url)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        if classification.role == "discovery_source":
            raise HTTPException(
                status_code=409,
                detail="Las cuentas y publicaciones se registran como fuentes de Radar, no como artefactos de Biblioteca",
            )
        try:
            github_parts = _github_resource_parts(request.repo_url)
            canonical = github_parts[0] if github_parts else validate_reference_url(request.repo_url)
            source_canonical = github_parts[1] if github_parts and github_parts[2] else (request.source_url or canonical)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        token = request.analysis_token or ""
        with _resource_analysis_guard:
            ticket = _resource_analysis_tickets.get(token)
        if ticket is None or datetime.now(timezone.utc).timestamp() - ticket[0] > 900:
            raise HTTPException(status_code=409, detail="analiza la referencia antes de guardarla")
        preview = ticket[1]
        if preview.repo_url != canonical:
            raise HTTPException(status_code=409, detail="analysis ticket does not match this repository")
        with _resource_analysis_guard:
            _resource_analysis_tickets.pop(token, None)
        preview_metadata = dict(preview.metadata)
        collection = request.metadata.get("inspiration_collection")
        if collection in {"radar", "catalog"}:
            preview_metadata["inspiration_collection"] = collection
        request = request.model_copy(update={
            "repo_url": canonical,
            "source_url": source_canonical,
            "install_strategy": preview.install_strategy,
            "metadata": preview_metadata,
            "tags": request.tags or preview.tags,
            "requirements": request.requirements or preview.requirements,
            "capabilities": request.capabilities or preview.capabilities,
            "compatible_runtimes": request.compatible_runtimes or preview.compatible_runtimes,
        })
        # A direct blob/tree URL is a component of its repository, never a
        # second repository. Reuse the existing root or materialize it from
        # the already verified analysis preview before saving the child.
        if github_parts and github_parts[2]:
            parent = runtime_module.current().resources.find_by_repo_url(canonical)
            if parent is None:
                parent = runtime_module.current().resources.create(preview.model_copy(update={
                    "repo_url": canonical,
                    "source_url": None,
                    "metadata": {**preview.metadata, "inspiration_collection": "catalog"},
                }))
            request = request.model_copy(update={"parent_resource_id": parent.id})
    else:
        # Installer provenance is server-owned. Manual/reference entries may
        # carry editorial metadata, but cannot opt themselves into a privileged
        # Naityer or filesystem execution path.
        metadata = {
            key: value
            for key, value in request.metadata.items()
            if key not in {"installer_key", "script_path", "launcher_path"}
        }
        request = request.model_copy(update={"install_strategy": "none", "metadata": metadata})
    try:
        existing = runtime_module.current().resources.find_by_repo_url(request.repo_url) if request.repo_url else None
        if existing:
            merged = existing.model_copy(update={
                "name": request.name,
                "slug": request.slug,
                "summary": request.summary or existing.summary,
                "source": request.source,
                "repo_url": request.repo_url,
                "tags": request.tags or existing.tags,
                "requirements": request.requirements or existing.requirements,
                "capabilities": request.capabilities or existing.capabilities,
                "compatible_runtimes": request.compatible_runtimes or existing.compatible_runtimes,
                "install_strategy": request.install_strategy or existing.install_strategy,
                "metadata": {**existing.metadata, **request.metadata},
            })
            item = runtime_module.current().resources.upsert(merged)
        else:
            item = runtime_module.current().resources.create(request)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    events.publish("resource_changed", resource_id=item.id)
    return item


@router.get("/resources/validity-policy", response_model=ArtifactValidityPolicy)
def get_validity_policy() -> ArtifactValidityPolicy:
    return load_policy(runtime_module.current().resources)


@router.post("/resources/validity-policy/impact")
def preview_validity_policy_impact(request: ArtifactValidityPolicyImpactRequest) -> dict:
    policy = ArtifactValidityPolicy(**request.model_dump())
    return policy_impact(runtime_module.current().resources, policy)


@router.put("/resources/validity-policy")
def save_validity_policy(
    request: ArtifactValidityPolicyUpdate,
    _: None = Depends(require_token),
) -> dict:
    store = runtime_module.current().resources
    try:
        policy = update_policy(store, request)
    except PolicyVersionConflict as exc:
        raise HTTPException(status_code=409, detail={"code": "policy_version_conflict", "message": str(exc)}) from exc
    except PolicyResetConfirmationRequired as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "decision_reset_confirmation_required", "manual_decisions_to_reset": exc.decisions},
        ) from exc
    events.publish("resource_changed", scope="validity_policy")
    return {"policy": policy.model_dump(mode="json"), "impact": policy_impact(store, policy)}


@router.post("/resources/validity-policy/revalidate")
def revalidate_validity_policy(_: None = Depends(require_token)) -> dict:
    try:
        return runtime_module.current().resource_refresh.start_full_refresh(force=True)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/resources/review", response_model=list[ResourceItem])
def list_resources_for_review(
    state: str = Query(default="pending_review", pattern="^(pending_review|accepted_override|discarded|all)$"),
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
) -> list[ResourceItem]:
    store = runtime_module.current().resources
    policy = load_policy(store)
    resources = decorate_catalog_resources(store.list_all_resources(include_inactive=True), policy)
    if state == "all":
        return resources[offset : offset + limit]
    matches = [item for item in resources if not is_internal_repository_component(item) and not is_internal_local_reference(item) and not (item.metadata.get("validity") or {}).get("alias_of") and item.metadata.get("validity", {}).get("state") == state]
    return matches[offset : offset + limit]


@router.post("/resources/{resource_id}/review", response_model=ResourceItem)
def review_resource(
    resource_id: str,
    request: ArtifactReviewDecisionRequest,
    _: None = Depends(require_token),
) -> ResourceItem:
    _resource_or_404(resource_id)
    item = decide_resource(runtime_module.current().resources, _resource_or_404(resource_id), request)
    events.publish("resource_changed", resource_id=resource_id, scope="validity_review")
    return item


@router.post("/resources/inventory")
def prepare_resource_inventory(_: None = Depends(require_token)) -> dict:
    snapshot = create_inventory_snapshot(runtime_module.current().resources)
    return {
        "snapshot_id": snapshot.id,
        "filename": snapshot.filename,
        "created_at": snapshot.created_at.isoformat(),
        "total": len(snapshot.rows),
        "rows": snapshot.rows[:50],
        "policy": snapshot.policy,
        "download_url": f"/resources/inventory/{snapshot.id}.xlsx",
    }


@router.get("/resources/inventory/{snapshot_id}.xlsx")
def download_resource_inventory(snapshot_id: str) -> StreamingResponse:
    try:
        snapshot = get_inventory_snapshot(snapshot_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="inventory snapshot not found or expired") from exc
    return StreamingResponse(
        BytesIO(snapshot.content),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="inventario-inspiracion-{snapshot_id[:8]}.xlsx"'},
    )


@router.get("/resources/{resource_id}")
def resource_detail(resource_id: str) -> dict:
    all_items = runtime_module.current().resources.list_all_resources(include_inactive=True)
    by_id = {entry.id: entry for entry in all_items}
    raw_item = _resource_or_404(resource_id)
    item = decorate_resource(raw_item, load_policy(runtime_module.current().resources), parent=by_id.get(raw_item.parent_resource_id))
    return {
        **item.model_dump(mode="json"),
        "operations": [entry.model_dump(mode="json") for entry in runtime_module.current().resources.list_operations(item.id)],
        "children": [child.model_dump(mode="json") for child in runtime_module.current().resources.list_children(item.id)],
    }


@router.patch("/resources/{resource_id}", response_model=ResourceItem)
def update_resource(resource_id: str, request: ResourceUpdateRequest, _: None = Depends(require_token)) -> ResourceItem:
    _resource_or_404(resource_id)
    try:
        item = runtime_module.current().resources.update_resource(resource_id, request)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="resource not found") from exc
    events.publish("resource_changed", resource_id=item.id, scope="editorial")
    return item


@router.post("/resources/{resource_id}/reindex")
def reindex_resource(
    resource_id: str,
    request: ResourceIndexRequest,
    _: None = Depends(require_token),
    __: dict | None = Depends(require_atlas_token),
) -> dict:
    item = _resource_or_404(resource_id)
    if not request.confirmed:
        raise HTTPException(status_code=409, detail="explicit confirmation is required")
    with _resource_operation_guard:
        if resource_id in _active_resource_operations:
            raise HTTPException(status_code=409, detail="another operation is already running for this resource")
        _active_resource_operations.add(resource_id)
    try:
        try:
            result = runtime_module.current().nested_resource_indexer.index(item)
        except Exception as exc:
            operation = runtime_module.current().resources.record_operation(
                resource_id=item.id, action="reindex", status="failed", detail=str(exc)[:1000],
            )
            events.publish("resource_operation_changed", resource_id=item.id, operation_id=operation.operation_id)
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        operation = runtime_module.current().resources.record_operation(
            resource_id=item.id, action="reindex", status="succeeded",
            detail=f"Indexed {result.indexed} nested resources; {result.inactive} marked inactive.",
            metadata={"indexed": result.indexed, "inactive": result.inactive},
        )
        events.publish("resource_operation_changed", resource_id=item.id, operation_id=operation.operation_id)
        events.publish("resource_changed", resource_id=item.id, scope="nested_index")
        return {
            "resource_id": item.id, "indexed": result.indexed, "inactive": result.inactive,
            "warnings": list(result.warnings), "operation_id": operation.operation_id,
        }
    finally:
        with _resource_operation_guard:
            _active_resource_operations.discard(resource_id)


@router.post("/resources/{resource_id}/reanalyze", response_model=ResourceItem)
def reanalyze_resource(
    resource_id: str,
    request: ResourceIndexRequest,
    _: None = Depends(require_token),
) -> ResourceItem:
    """Refresh metadata/summary from the canonical source without reinstalling."""
    item = _resource_or_404(resource_id)
    if not request.confirmed:
        raise HTTPException(status_code=409, detail="explicit confirmation is required")
    if not item.repo_url:
        raise HTTPException(status_code=422, detail="resource has no analyzable repository URL")
    parsed = urlsplit(item.repo_url)
    if parsed.hostname and parsed.hostname.casefold() == "github.com":
        try:
            return runtime_module.current().resource_refresh.refresh_item(item, trigger="manual")
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    result = runtime_module.current().web_reference_analyzer.analyze(item.repo_url)
    if not result.valid or result.preview is None:
        raise HTTPException(status_code=422, detail="source analysis did not produce a valid preview")
    preview = result.preview
    refreshed = item.model_copy(update={
        "name": preview.name,
        "slug": preview.slug,
        "summary": preview.summary,
        "source": preview.source,
        "tags": preview.tags,
        "requirements": preview.requirements,
        "capabilities": preview.capabilities,
        "compatible_runtimes": preview.compatible_runtimes,
        "install_strategy": preview.install_strategy,
        "metadata": {**item.metadata, **preview.metadata, "summary_method": preview.metadata.get("summary_method", "reanalyzed")},
    })
    updated = runtime_module.current().resources.upsert(refreshed)
    events.publish("resource_changed", resource_id=updated.id, scope="reanalyzed")
    return updated


@router.put("/resources/{resource_id}/visibility", response_model=ResourceItem)
def update_resource_visibility(
    resource_id: str,
    request: ResourceVisibilityRequest,
    _: None = Depends(require_token),
    __: dict | None = Depends(require_atlas_token),
) -> ResourceItem:
    item = _resource_or_404(resource_id)
    layout = runtime_module.current().routing.load()
    known_ids = {entity.id for entity in layout.entities}
    unknown = sorted(set(request.agent_ids) - known_ids)
    if unknown:
        raise HTTPException(status_code=422, detail=f"unknown agent ids: {', '.join(unknown)}")

    selected = set(request.agent_ids)
    entities = []
    for entity in layout.entities:
        resource_ids = set(entity.resource_ids)
        projection = set(entity.skills if item.kind == ResourceKind.SKILL else entity.capabilities)
        if entity.id in selected:
            resource_ids.add(item.id)
            projection.add(item.slug)
        else:
            resource_ids.discard(item.id)
            projection.discard(item.slug)
        changes = {"resource_ids": sorted(resource_ids)}
        changes["skills" if item.kind == ResourceKind.SKILL else "capabilities"] = sorted(projection)
        entities.append(entity.model_copy(update=changes))

    previous_agents = item.visible_agent_ids
    updated = runtime_module.current().resources.set_visibility(item.id, request.agent_ids)
    try:
        runtime_module.current().routing.save(layout.model_copy(update={"entities": entities}))
    except Exception:
        runtime_module.current().resources.set_visibility(item.id, previous_agents)
        raise
    events.publish("layout_changed")
    events.publish("resource_changed", resource_id=item.id)
    return updated


@router.post("/resources/{resource_id}/operations", response_model=ResourceOperationResult)
def operate_resource(
    resource_id: str,
    request: ResourceOperationRequest,
    _: None = Depends(require_token),
    __: dict | None = Depends(require_atlas_token),
) -> ResourceOperationResult:
    item = _resource_or_404(resource_id)
    with _resource_operation_guard:
        if resource_id in _active_resource_operations:
            raise HTTPException(status_code=409, detail="another operation is already running for this resource")
        _active_resource_operations.add(resource_id)
    try:
        if item.install_strategy == "github_skill":
            result = runtime_module.current().resource_installer.operate(item, request)
        elif item.install_strategy == "naityer_allowlisted":
            component = str(item.metadata.get("installer_key") or "")
            if request.action == "verify":
                preflight = runtime_module.current().naityer_adapter.preflight(component)
                result = runtime_module.current().resources.record_operation(
                    resource_id=item.id,
                    action="naityer:verify",
                    status="succeeded" if preflight.ready else "failed",
                    detail=preflight.detail,
                    targets=["naityer"],
                    metadata={"checks": preflight.checks},
                )
            else:
                action = "install" if request.action in {"install", "update"} else "uninstall"
                result = runtime_module.current().naityer_adapter.execute(
                    component,
                    action,
                    confirmed=request.confirmed,
                    resource_id=item.id,
                )
                if result.status == "succeeded":
                    runtime_module.current().resources.upsert(item.model_copy(update={
                        "status": "available" if action == "uninstall" else "installed"
                    }))
        else:
            result = runtime_module.current().resources.record_operation(
                resource_id=item.id,
                action=request.action,
                status="denied",
                detail="This resource is catalog-only and has no approved installer.",
                targets=request.targets,
            )
        events.publish("resource_operation_changed", resource_id=item.id, operation_id=result.operation_id)
        events.publish("resource_changed", resource_id=item.id)
        return result
    finally:
        with _resource_operation_guard:
            _active_resource_operations.discard(resource_id)
