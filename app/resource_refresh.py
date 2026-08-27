from __future__ import annotations

import os
import re
import threading
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Callable
from urllib.parse import quote, urlsplit
from uuid import uuid4

from app.models import (
    AnalyzeResult,
    ResourceItem,
    ResourceKind,
    ResourceRefreshSettingsUpdate,
)
from app.resource_library import ResourceStore

SETTINGS_KEY = "resource_refresh_settings_v1"
STATUS_KEY = "resource_refresh_status_v1"
RUN_KEY = "resource_refresh_run_v1"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _parse_datetime(value: object) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


class ResourceRefreshCoordinator:
    """Run safe, resumable catalog analysis independently from the UI."""

    def __init__(
        self,
        store: ResourceStore,
        analyzer,
        *,
        web_analyzer=None,
        local_analyzer=None,
        nested_indexer=None,
        publish: Callable[..., None] | None = None,
        max_workers: int = 4,
    ) -> None:
        self._store = store
        self._analyzer = analyzer
        self._web_analyzer = web_analyzer
        self._local_analyzer = local_analyzer
        self._nested_indexer = nested_indexer
        self._publish = publish
        self._max_workers = max(1, min(int(max_workers), 4))
        self._lock = threading.Lock()
        self._job_guard = threading.Lock()
        self._job_thread: threading.Thread | None = None
        self._analysis_cache_guard = threading.Lock()
        self._analysis_cache: dict[tuple[str, str], Future] = {}

    def settings(self) -> ResourceRefreshSettingsUpdate:
        raw = self._store.get_preference(SETTINGS_KEY, {})
        try:
            return ResourceRefreshSettingsUpdate.model_validate(raw if isinstance(raw, dict) else {})
        except ValueError:
            return ResourceRefreshSettingsUpdate()

    def update_settings(self, value: ResourceRefreshSettingsUpdate) -> ResourceRefreshSettingsUpdate:
        self._store.set_preference(SETTINGS_KEY, value.model_dump())
        return value

    def status(self) -> dict:
        settings = self.settings()
        raw = self._store.get_preference(STATUS_KEY, {})
        status = raw if isinstance(raw, dict) else {}
        return {
            **settings.model_dump(),
            "running": self._lock.locked(),
            "last_run_at": status.get("last_run_at"),
            "last_analyzed": int(status.get("last_analyzed") or 0),
            "last_updated": int(status.get("last_updated") or 0),
            "last_failed": int(status.get("last_failed") or 0),
            "current_run": self.job_status(),
        }

    def job_status(self, run_id: str | None = None) -> dict | None:
        raw = self._store.get_preference(RUN_KEY, None)
        if not isinstance(raw, dict):
            return None
        if run_id is not None and raw.get("run_id") != run_id:
            raise KeyError(run_id)
        return raw

    def start_full_refresh(self, *, force: bool = True) -> dict:
        with self._job_guard:
            if self._lock.locked() or (self._job_thread and self._job_thread.is_alive()):
                raise RuntimeError("another catalog analysis is already running")
            persisted = self.job_status()
            if (
                persisted
                and persisted.get("status") in {"queued", "running"}
                and _process_exists(persisted.get("owner_pid"))
            ):
                raise RuntimeError("another catalog analysis is already running")
            candidates = self._candidate_items(force=force, limit=None)
            with self._analysis_cache_guard:
                self._analysis_cache.clear()
            run = {
                "run_id": f"rrun_{uuid4().hex[:12]}",
                "owner_pid": os.getpid(),
                "status": "queued",
                "force": force,
                "total": len(candidates),
                "pending": len(candidates),
                "processed": 0,
                "updated": 0,
                "unchanged": 0,
                "failed": 0,
                "skipped": 0,
                "children_indexed": 0,
                "failures": [],
                "started_at": _utcnow().isoformat(),
                "finished_at": None,
            }
            self._save_run(run)
            self._job_thread = threading.Thread(
                target=self._execute_full_refresh,
                args=(run, candidates),
                name=f"resource-refresh-{run['run_id']}",
                daemon=True,
            )
            self._job_thread.start()
            return dict(run)

    def refresh_item(self, item: ResourceItem, *, trigger: str) -> ResourceItem:
        """Backward-compatible GitHub refresh used by the single-resource API."""
        result: AnalyzeResult = self._analyzer.analyze(item.repo_url or "")
        return self._apply_analysis(item, result, trigger=trigger, method="github")

    def refresh_catalog_item(self, item: ResourceItem, *, trigger: str) -> tuple[ResourceItem, int]:
        if not self._lock.locked():
            with self._analysis_cache_guard:
                self._analysis_cache.clear()
        method, source_url = self._analysis_source(item)
        key = (method, source_url or item.id)
        with self._analysis_cache_guard:
            future = self._analysis_cache.get(key)
            owner = future is None
            if future is None:
                future = Future()
                self._analysis_cache[key] = future
        if owner:
            try:
                if method == "github":
                    result = self._analyzer.analyze(source_url)
                elif method == "web" and self._web_analyzer is not None:
                    result = self._web_analyzer.analyze(source_url)
                elif method == "local" and self._local_analyzer is not None:
                    result = self._local_analyzer.analyze(item)
                else:
                    raise LookupError(f"no analyzer is configured for {method}")
                future.set_result(result)
            except Exception as exc:
                future.set_exception(exc)
        result = future.result()
        updated = self._apply_analysis(item, result, trigger=trigger, method=method, source_url=source_url or None)
        children = 0 if updated.parent_resource_id else self._refresh_children(updated, result, method)
        return self._store.get(updated.id), children

    def _apply_analysis(
        self,
        item: ResourceItem,
        result: AnalyzeResult,
        *,
        trigger: str,
        method: str,
        source_url: str | None = None,
    ) -> ResourceItem:
        if not result.valid or result.preview is None:
            detail = "; ".join(result.warnings) or "source analysis did not produce a valid preview"
            raise ValueError(detail)
        preview = result.preview
        existing_metadata = dict(item.metadata or {})
        existing_metadata.pop("source_analysis_error", None)
        existing_metadata.pop("source_verification_state", None)
        source_metadata = dict(preview.metadata or {})
        source_metadata.update({
            "source_analyzed_at": _utcnow().isoformat(),
            "source_analysis_trigger": trigger,
            "source_analysis_method": source_metadata.get("source_analysis_method", method),
            "source_analysis_warnings": list(result.warnings),
        })
        summary = item.summary if existing_metadata.get("summary_edited") else preview.summary
        refreshed = item.model_copy(update={
            "name": item.name if existing_metadata.get("name_edited") else preview.name,
            "summary": summary,
            "tags": preview.tags or item.tags,
            "requirements": preview.requirements or item.requirements,
            "capabilities": preview.capabilities or item.capabilities,
            "compatible_runtimes": preview.compatible_runtimes or item.compatible_runtimes,
            "install_strategy": preview.install_strategy if preview.install_strategy != "none" else item.install_strategy,
            "source_url": item.source_url or (source_url if method == "web" and not item.repo_url else None),
            "metadata": {**existing_metadata, **source_metadata},
        })
        updated = self._store.upsert(refreshed)
        self._store.record_operation(
            resource_id=updated.id,
            action="reanalyze",
            status="succeeded",
            detail=f"Source metadata refreshed with {method} analyzer.",
            metadata={"trigger": trigger, "method": method, "components": len(result.skill_paths or source_metadata.get("skill_paths") or [])},
        )
        if self._publish:
            self._publish("resource_changed", resource_id=updated.id, scope="reanalyzed")
        return updated

    def _mark_analysis_failure(self, item: ResourceItem, detail: str, *, trigger: str) -> None:
        rate_limited = "rate limit" in detail.casefold() or "status/403" in detail.casefold()
        metadata = {
            **(item.metadata or {}),
            "source_analysis_error": detail[:1000],
            "source_analyzed_at": _utcnow().isoformat(),
            "source_analysis_trigger": trigger,
            "source_verification_state": "rate_limited" if rate_limited else "failed",
        }
        # A GitHub quota response says nothing about repository accessibility. Keep
        # prior verified facts intact; only a genuine analysis failure invalidates them.
        if not rate_limited:
            metadata.update({"source_accessible": False, "detection_succeeded": False})
        self._store.upsert(item.model_copy(update={"index_status": "active", "metadata": metadata}))
        if self._publish:
            self._publish("resource_changed", resource_id=item.id, scope="analysis_failed")

    def _refresh_children(self, item: ResourceItem, result: AnalyzeResult, method: str) -> int:
        if (item.metadata or {}).get("nested_indexer") and self._nested_indexer is not None:
            return int(self._nested_indexer.index(item).indexed)
        if method == "github":
            paths = list(result.skill_paths or (item.metadata or {}).get("skill_paths") or [])
            if not paths:
                return 0
            now = _utcnow()
            branch = str((item.metadata or {}).get("default_branch") or "main")
            children: list[ResourceItem] = []
            for position, path in enumerate(paths[:200]):
                stem = path.rsplit("/", 2)[-2] if "/" in path else path.rsplit(".", 1)[0]
                name = re.sub(r"[-_]+", " ", stem).strip().title() or f"Skill {position + 1}"
                slug_part = re.sub(r"[^a-z0-9._-]+", "-", stem.casefold()).strip("-") or str(position + 1)
                source_url = f"{str(item.repo_url).rstrip('/')}/blob/{quote(branch, safe='')}/{quote(path, safe='/')}"
                children.append(ResourceItem(
                    slug=f"{item.slug}--{slug_part}"[:120],
                    name=name[:160],
                    kind=ResourceKind.SKILL,
                    source="github-skill",
                    parent_resource_id=item.id,
                    source_url=source_url,
                    indexed_at=now,
                    summary=f"Skill incluida en {item.name}: {path}.",
                    tags=sorted({*item.tags, "skill", "nested"}),
                    capabilities=item.capabilities,
                    compatible_runtimes=item.compatible_runtimes or ["claude", "codex"],
                    install_strategy="none",
                    metadata={
                        "skill_path": path,
                        "skill_paths": [path],
                        "github_stars": (item.metadata or {}).get("github_stars"),
                        "source_accessible": (item.metadata or {}).get("source_accessible") is True,
                        "detection_succeeded": True,
                        "source_analyzed_at": (item.metadata or {}).get("source_analyzed_at"),
                        "provenance": {"parent_resource_id": item.id, "canonical_url": source_url, "method": "github-tree-skill-path"},
                    },
                ))
            indexed, _ = self._store.replace_children(item.id, children)
            return indexed
        if method == "web" and self._nested_indexer is not None:
            try:
                return int(self._nested_indexer.index(item).indexed)
            except ValueError as exc:
                if "no approved nested-resource adapter" in str(exc):
                    return 0
                raise
        return 0

    def _analysis_source(self, item: ResourceItem) -> tuple[str, str]:
        metadata = item.metadata or {}
        url = item.repo_url or item.source_url or metadata.get("homepage_url") or metadata.get("html_url")
        if url:
            host = (urlsplit(str(url)).hostname or "").casefold()
            if host == "github.com":
                parsed = urlsplit(str(url))
                parts = [part for part in parsed.path.split("/") if part]
                if len(parts) >= 2:
                    return "github", f"https://github.com/{parts[0]}/{parts[1]}"
            return "web", str(url)
        return "local", ""

    def _candidate_items(self, *, force: bool, limit: int | None) -> list[ResourceItem]:
        cutoff = _utcnow() - timedelta(days=self.settings().repository_interval_days)
        candidates: list[ResourceItem] = []
        offset = 0
        while limit is None or len(candidates) < limit:
            page = self._store.list_resources(limit=500, offset=offset, include_inactive=False)
            if not page:
                break
            for item in page:
                provenance = (item.metadata or {}).get("provenance") or {}
                collection_child = provenance.get("method") == "claude-skills-collection-readme"
                if item.parent_resource_id is not None and not collection_child:
                    continue
                last = _parse_datetime((item.metadata or {}).get("source_analyzed_at"))
                if last is None:
                    last = _parse_datetime((item.metadata or {}).get("summarized_at"))
                retry_pending = bool((item.metadata or {}).get("source_analysis_error"))
                if force or retry_pending or last is None or last <= cutoff:
                    candidates.append(item)
                    if limit is not None and len(candidates) >= limit:
                        break
            if len(page) < 500 or (limit is not None and len(candidates) >= limit):
                break
            offset += len(page)
        return candidates

    def _execute_full_refresh(self, run: dict, candidates: list[ResourceItem]) -> None:
        if not self._lock.acquire(blocking=False):
            run.update({"status": "failed", "finished_at": _utcnow().isoformat(), "failed": run["total"], "pending": 0})
            run["failures"] = [{"resource_id": None, "name": "Catalog", "detail": "another analysis is running"}]
            self._save_run(run)
            return
        try:
            run["status"] = "running"
            self._save_run(run)
            with ThreadPoolExecutor(max_workers=self._max_workers, thread_name_prefix="resource-analysis") as pool:
                batch = candidates
                processed_ids: set[str] = set()
                while batch:
                    futures = {pool.submit(self._analyze_one, item, "manual"): item for item in batch}
                    for future in as_completed(futures):
                        item = futures[future]
                        processed_ids.add(item.id)
                        try:
                            outcome, children = future.result()
                            run[outcome] += 1
                            run["children_indexed"] += children
                        except LookupError as exc:
                            run["skipped"] += 1
                            run["failures"].append({"resource_id": item.id, "name": item.name, "detail": str(exc), "status": "skipped"})
                        except Exception as exc:
                            run["failed"] += 1
                            detail = str(exc)[:1000]
                            self._mark_analysis_failure(item, detail, trigger="manual")
                            run["failures"].append({"resource_id": item.id, "name": item.name, "detail": detail, "status": "failed"})
                            self._store.record_operation(resource_id=item.id, action="reanalyze", status="failed", detail=detail, metadata={"trigger": "manual"})
                        run["processed"] += 1
                        run["pending"] = max(0, run["total"] - run["processed"])
                        run["failures"] = run["failures"][-100:]
                        self._save_run(run)
                    batch = [
                        item for item in self._store.list_all_resources(include_inactive=False)
                        if item.id not in processed_ids
                        and ((item.metadata or {}).get("provenance") or {}).get("method") == "claude-skills-collection-readme"
                    ]
                    if batch:
                        run["total"] += len(batch)
                        run["pending"] += len(batch)
                        self._save_run(run)
            self._store.apply_resource_taxonomy()
            run["status"] = "completed" if run["failed"] == 0 else "completed_with_errors"
            run["finished_at"] = _utcnow().isoformat()
            status = {
                "last_run_at": run["finished_at"],
                "last_analyzed": run["processed"],
                "last_updated": run["updated"],
                "last_failed": run["failed"],
            }
            self._store.set_preference(STATUS_KEY, status)
            self._save_run(run)
        finally:
            self._lock.release()

    def _analyze_one(self, item: ResourceItem, trigger: str) -> tuple[str, int]:
        previous = (item.metadata or {}).get("source_revision")
        current, children = self.refresh_catalog_item(item, trigger=trigger)
        revision = (current.metadata or {}).get("source_revision")
        return ("updated" if not previous or previous != revision else "unchanged"), children

    def _save_run(self, run: dict) -> None:
        self._store.set_preference(RUN_KEY, run)
        if self._publish:
            self._publish(
                "resource_refresh_progress",
                run_id=run.get("run_id"),
                status=run.get("status"),
                processed=run.get("processed", 0),
                total=run.get("total", 0),
            )

    def run_due(self, *, force: bool = False, limit: int | None = 25) -> dict:
        if not self._lock.acquire(blocking=False):
            return {"running": True, "analyzed": 0, "updated": 0, "failed": 0}
        analyzed = updated = failed = 0
        try:
            settings = self.settings()
            if not settings.repository_enabled and not force:
                return {"running": False, "analyzed": 0, "updated": 0, "failed": 0, "disabled": True}
            candidates = self._candidate_items(force=force, limit=limit)
            for item in candidates:
                analyzed += 1
                try:
                    outcome, _ = self._analyze_one(item, "manual" if force else "scheduled")
                    updated += outcome == "updated"
                except Exception as exc:
                    failed += 1
                    self._mark_analysis_failure(item, str(exc), trigger="manual" if force else "scheduled")
                    self._store.record_operation(
                        resource_id=item.id, action="reanalyze", status="failed", detail=str(exc)[:1000],
                        metadata={"trigger": "manual" if force else "scheduled"},
                    )
            status = {
                "last_run_at": _utcnow().isoformat(), "last_analyzed": analyzed,
                "last_updated": updated, "last_failed": failed,
            }
            self._store.set_preference(STATUS_KEY, status)
            if candidates:
                self._store.apply_resource_taxonomy()
            return {"running": False, "analyzed": analyzed, "updated": updated, "failed": failed}
        finally:
            self._lock.release()


def _process_exists(value: object) -> bool:
    try:
        process_id = int(value)
        if process_id <= 0:
            return False
        os.kill(process_id, 0)
        return True
    except (OSError, TypeError, ValueError):
        return False
