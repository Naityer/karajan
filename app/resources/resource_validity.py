"""Configurable, explainable acceptance policy for Inspiration resources."""

from __future__ import annotations

from datetime import datetime, timezone
from copy import deepcopy
from threading import RLock
from urllib.parse import urlsplit

from app.models import (
    ArtifactReviewDecisionRequest,
    ArtifactValidityPolicy,
    ArtifactValidityPolicyImpactRequest,
    ArtifactValidityPolicyUpdate,
    ResourceItem,
    ResourceKind,
)

POLICY_KEY = "artifact_validity_policy_v1"
INTERNAL_COMPONENT_METHODS = {
    "github-tree-skill-path",
    "claude-skills-collection-readme",
    "itsfree-html",
    "generic-html",
    "toools-directory",
}
_LOCK = RLock()


class PolicyVersionConflict(RuntimeError):
    pass


class PolicyResetConfirmationRequired(RuntimeError):
    def __init__(self, decisions: int) -> None:
        self.decisions = decisions
        super().__init__(f"confirmation required to reset {decisions} manual decisions")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def load_policy(store) -> ArtifactValidityPolicy:
    raw = store.get_preference(POLICY_KEY, {})
    try:
        return ArtifactValidityPolicy.model_validate(raw if isinstance(raw, dict) else {})
    except ValueError:
        return ArtifactValidityPolicy()


def _source_url(item: ResourceItem) -> str:
    metadata = item.metadata or {}
    return str(item.repo_url or item.source_url or metadata.get("homepage_url") or metadata.get("html_url") or "")


def _https_url(value: str) -> bool:
    try:
        parsed = urlsplit(value)
        return parsed.scheme == "https" and bool(parsed.hostname)
    except ValueError:
        return False


def _stars(item: ResourceItem) -> int | None:
    metadata = item.metadata or {}
    for key in ("github_stars", "stargazers_count", "stars"):
        value = metadata.get(key)
        if isinstance(value, bool):
            continue
        try:
            return max(0, int(value)) if value is not None else None
        except (TypeError, ValueError):
            continue
    return None


def _is_github_repository(item: ResourceItem, source_url: str) -> bool:
    """Return whether the resource points at a GitHub repository or one of its files."""
    candidates = [item.repo_url, source_url]
    for candidate in candidates:
        if not candidate:
            continue
        try:
            parsed = urlsplit(str(candidate))
        except ValueError:
            continue
        parts = [part for part in parsed.path.split("/") if part]
        if parsed.scheme == "https" and (parsed.hostname or "").casefold() == "github.com" and len(parts) >= 2:
            return True
    return False


def evaluate_resource(item: ResourceItem, policy: ArtifactValidityPolicy) -> dict:
    metadata = item.metadata or {}
    url = _source_url(item)
    stars = _stars(item)
    github_repository = _is_github_repository(item, url)
    stars_applicable = policy.stars_enabled and github_repository
    skill_paths = [str(path) for path in metadata.get("skill_paths", []) if path]
    detected = bool(metadata.get("detection_succeeded") or metadata.get("source_revision"))
    if item.kind == ResourceKind.SKILL:
        detected = detected and bool(skill_paths or metadata.get("local_skill_verified"))
    runtimes = {value.casefold() for value in item.compatible_runtimes}
    # Curated web directories are explicitly published for both supported
    # agents even when an older seed row predates the runtime field.
    if not runtimes and metadata.get("source_role") == "collection" and not github_repository:
        runtimes = {"claude", "codex"}
    checks = {
        "stars": {
            "enabled": stars_applicable,
            "applicable": github_repository,
            "passed": (stars is not None and stars > policy.min_github_stars) if stars_applicable else True,
            "actual": stars,
            "required": f"> {policy.min_github_stars} (solo repositorios GitHub)",
        },
        "source": {
            "enabled": policy.require_source_url,
            "passed": (_https_url(url) and (metadata.get("source_accessible") is True or metadata.get("verified_source") is True)) if policy.require_source_url else True,
            "actual": url or None,
            "required": "HTTPS",
        },
        "detection": {
            "enabled": policy.require_detection_success,
            "passed": detected if policy.require_detection_success else True,
            "actual": detected,
            "required": "successful analysis" + (" + SKILL.md" if item.kind == ResourceKind.SKILL else ""),
        },
        "runtimes": {
            "enabled": bool(policy.required_runtimes),
            "passed": set(policy.required_runtimes) <= runtimes if policy.required_runtimes else True,
            "actual": sorted(runtimes),
            "required": list(policy.required_runtimes),
        },
        "web_reference": {
            "enabled": policy.require_web_reference,
            "passed": _https_url(url) if policy.require_web_reference else True,
            "actual": url or None,
            "required": "public web reference",
        },
    }
    failed = [name for name, check in checks.items() if check["enabled"] and not check["passed"]]
    reason_by_check = {
        "stars": "No supera el umbral de estrellas de GitHub." if stars is not None else "Estrellas de GitHub pendientes de verificar.",
        "source": "No tiene una fuente HTTPS accesible.",
        "detection": "La detección inicial no se completó correctamente.",
        "runtimes": "No declara compatibilidad con todos los runtimes requeridos.",
        "web_reference": "No dispone de una referencia web válida.",
    }
    stored_validity = metadata.get("validity") or {}
    decision = str(stored_validity.get("decision") or "automatic")
    exempt = bool(metadata.get("policy_exempt"))
    if exempt:
        state = "accepted"
    elif decision == "accept":
        state = "accepted_override"
    elif decision == "discard":
        state = "discarded"
    else:
        state = "accepted" if not failed else "pending_review"
    return {
        "state": state,
        "decision": decision,
        "checks": checks,
        "failed_checks": failed,
        "reasons": [reason_by_check[name] for name in failed],
        "github_stars": stars,
        "github_repository": github_repository,
        "source_url": url or None,
        "evaluated_at": _utcnow().isoformat(),
        "policy_version": policy.version,
        "policy_exempt": exempt,
        "history": list(stored_validity.get("history") or []),
        "decided_at": stored_validity.get("decided_at"),
    }


def is_internal_repository_component(item: ResourceItem) -> bool:
    provenance = (item.metadata or {}).get("provenance") or {}
    return provenance.get("method") in INTERNAL_COMPONENT_METHODS


def is_internal_local_reference(item: ResourceItem) -> bool:
    """Seeded local capabilities belong to Karajan itself, not the external review queue."""
    return not (item.repo_url or item.source_url) and str(item.source or "").casefold() in {"local", "skills_catalog"}


def _is_github_root(item: ResourceItem) -> bool:
    if not item.repo_url:
        return False
    try:
        parsed = urlsplit(item.repo_url)
    except ValueError:
        return False
    return parsed.scheme == "https" and (parsed.hostname or "").casefold() == "github.com" and len([part for part in parsed.path.split("/") if part]) >= 2


def is_local_repository_alias(item: ResourceItem, candidates: list[ResourceItem]) -> ResourceItem | None:
    """Resolve a seeded local skill to its canonical GitHub resource by exact name."""
    if item.repo_url or item.source_url or item.source not in {"skills_catalog", "local"}:
        return None
    if (item.metadata or {}).get("source_analysis_method") != "local-files":
        return None
    name = item.name.casefold().strip()
    matches = [candidate for candidate in candidates if candidate.id != item.id and _is_github_root(candidate) and candidate.name.casefold().strip() == name]
    return matches[0] if len(matches) == 1 else None


def decorate_resource(
    item: ResourceItem,
    policy: ArtifactValidityPolicy,
    *,
    parent: ResourceItem | None = None,
) -> ResourceItem:
    validity = evaluate_resource(item, policy)
    if parent is not None and is_internal_repository_component(item):
        # A nested page/component is not another catalog resource. Its
        # acceptance state and source checks are owned by the parent.
        parent_validity = evaluate_resource(parent, policy)
        validity["state"] = parent_validity["state"]
        validity["failed_checks"] = list(parent_validity["failed_checks"])
        validity["reasons"] = list(parent_validity["reasons"])
        validity["github_stars"] = parent_validity["github_stars"]
        validity["github_repository"] = parent_validity["github_repository"]
        validity["analysis_owner_id"] = parent.id
        for name in ("stars", "source", "detection", "runtimes"):
            validity["checks"][name] = deepcopy(parent_validity["checks"][name])
    return item.model_copy(update={"metadata": {**item.metadata, "validity": validity}})


def decorate_catalog_resources(
    items: list[ResourceItem],
    policy: ArtifactValidityPolicy,
    *,
    parent_items: list[ResourceItem] | None = None,
) -> list[ResourceItem]:
    by_id = {item.id: item for item in [*(parent_items or []), *items]}
    decorated: list[ResourceItem] = []
    for item in items:
        parent = by_id.get(item.parent_resource_id)
        result = decorate_resource(item, policy, parent=parent)
        alias = is_local_repository_alias(item, items)
        if alias:
            canonical = evaluate_resource(alias, policy)
            validity = dict(result.metadata.get("validity") or {})
            validity.update({
                "state": canonical["state"],
                "failed_checks": list(canonical["failed_checks"]),
                "reasons": list(canonical["reasons"]),
                "checks": deepcopy(canonical["checks"]),
                "github_stars": canonical["github_stars"],
                "github_repository": canonical["github_repository"],
                "source_url": canonical["source_url"],
                "analysis_owner_id": alias.id,
                "alias_of": alias.id,
            })
            result = result.model_copy(update={"metadata": {**result.metadata, "validity": validity}})
        decorated.append(result)
    return decorated


def policy_impact(store, candidate: ArtifactValidityPolicyImpactRequest | ArtifactValidityPolicy) -> dict:
    current = load_policy(store)
    payload = candidate.model_dump(exclude={"expected_version", "confirm_reset", "version", "updated_at"})
    policy = ArtifactValidityPolicy(**payload, version=current.version)
    items = store.list_all_resources(include_inactive=True)
    decorated_items = decorate_catalog_resources(items, policy)
    aliases = {item.id for item in decorated_items if (item.metadata.get("validity") or {}).get("alias_of")}
    states: dict[str, int] = {}
    manual = 0
    for item in items:
        if item.id in aliases:
            continue
        if is_internal_repository_component(item):
            continue
        if is_internal_local_reference(item):
            # Karajan's own seeded skills (source=skills_catalog, no repo_url)
            # never show up in /resources/review (see list_resources_for_review)
            # — counting them here just inflates the badge with a queue that
            # never actually contains them.
            continue
        decision = str(((item.metadata or {}).get("validity") or {}).get("decision") or "automatic")
        manual += int(decision in {"accept", "discard"})
        state = evaluate_resource(item, policy)["state"]
        states[state] = states.get(state, 0) + 1
    return {"total": len(items), "states": states, "manual_decisions_to_reset": manual, "policy": policy.model_dump(mode="json")}


def update_policy(store, request: ArtifactValidityPolicyUpdate) -> ArtifactValidityPolicy:
    with _LOCK:
        current = load_policy(store)
        if request.expected_version != current.version:
            raise PolicyVersionConflict("artifact validity policy changed; reload before saving")
        items = store.list_all_resources(include_inactive=True)
        manual = sum(
            int(str(((item.metadata or {}).get("validity") or {}).get("decision") or "automatic") in {"accept", "discard"})
            for item in items
        )
        if manual and not request.confirm_reset:
            raise PolicyResetConfirmationRequired(manual)
        now = _utcnow().isoformat()
        updated_items = []
        for item in items:
            validity = dict((item.metadata or {}).get("validity") or {})
            decision = str(validity.get("decision") or "automatic")
            history = list(validity.get("history") or [])
            if decision in {"accept", "discard"}:
                history.append({"decision": decision, "decided_at": validity.get("decided_at"), "reset_at": now, "reason": "policy_changed"})
            validity.update({"decision": "automatic", "decided_at": None, "history": history[-100:]})
            updated_items.append(item.model_copy(update={"index_status": "active", "metadata": {**item.metadata, "validity": validity}}))
        policy = ArtifactValidityPolicy(
            **request.model_dump(exclude={"expected_version", "confirm_reset"}),
            version=current.version + 1,
            updated_at=_utcnow(),
        )
        store.apply_validity_policy_transition(POLICY_KEY, policy.model_dump(mode="json"), updated_items)
        return policy


def decide_resource(store, item: ResourceItem, request: ArtifactReviewDecisionRequest) -> ResourceItem:
    with _LOCK:
        validity = dict((item.metadata or {}).get("validity") or {})
        history = list(validity.get("history") or [])
        previous = str(validity.get("decision") or "automatic")
        if previous != "automatic":
            history.append({"decision": previous, "decided_at": validity.get("decided_at"), "reset_at": _utcnow().isoformat(), "reason": "decision_replaced"})
        decision = {"accept": "accept", "discard": "discard", "automatic": "automatic"}[request.decision]
        validity.update({"decision": decision, "decided_at": _utcnow().isoformat() if decision != "automatic" else None, "history": history[-100:]})
        updated = store.upsert(item.model_copy(update={
            "index_status": "inactive" if decision == "discard" else "active",
            "metadata": {**item.metadata, "validity": validity},
        }))
        return decorate_resource(updated, load_policy(store))


__all__ = [
    "PolicyResetConfirmationRequired", "PolicyVersionConflict", "decide_resource",
    "decorate_catalog_resources", "decorate_resource", "evaluate_resource", "is_internal_repository_component", "is_internal_local_reference", "is_local_repository_alias", "load_policy", "policy_impact", "update_policy",
]
