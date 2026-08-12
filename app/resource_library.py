from __future__ import annotations

import json
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator
from uuid import uuid4

from app.models import (
    DiscoverySource,
    ResourceCreateRequest,
    ResourceGroup,
    ResourceGroupCreateRequest,
    ResourceGroupUpdateRequest,
    ResourceInstallation,
    ResourceItem,
    ResourceKind,
    ResourceOperationResult,
    ResourceUpdateRequest,
)


DEFAULT_RESOURCES_DB_PATH = Path("data/resources.db")
_REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_NAITYER_ROOT = Path(
    os.environ.get("KARAJAN_NAITYER_ROOT", str(_REPO_ROOT.parent / "naityer_setup"))
)
DEFAULT_NAITYER_INSTALLERS = DEFAULT_NAITYER_ROOT / "scripts" / "installers" / "complementos_ia"
_WORD_RE = re.compile(r"[\w.-]+", re.UNICODE)
MAX_RESOURCE_GROUP_DEPTH = 4


def _now() -> datetime:
    return datetime.now(timezone.utc)


def deterministic_summary(name: str, description: str = "", capabilities: Iterable[str] = ()) -> str:
    """Return stable, bounded copy without relying on an LLM."""
    cleaned = re.sub(r"<[^>]+>", " ", str(description or ""))
    cleaned = " ".join(cleaned.split()).strip(" .")
    if cleaned:
        return (cleaned[:3997].rstrip() + "...") if len(cleaned) > 4000 else cleaned
    listed = sorted({item.strip() for item in capabilities if item.strip()}, key=str.casefold)
    suffix = f": {', '.join(listed[:6])}" if listed else ""
    return f"Recurso {name.strip()} disponible en la biblioteca{suffix}."


class ResourceStore:
    """SQLite-backed resource inventory with an FTS5/LIKE search path."""

    def __init__(self, db_path: Path | str = DEFAULT_RESOURCES_DB_PATH) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._fts_available = False
        self._init_schema()

    @property
    def fts_available(self) -> bool:
        return self._fts_available

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS resources (
                    id TEXT PRIMARY KEY,
                    slug TEXT NOT NULL,
                    name TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('skill', 'capability', 'reference')),
                    source TEXT NOT NULL,
                    repo_url TEXT,
                    summary TEXT NOT NULL,
                    tags_json TEXT NOT NULL,
                    requirements_json TEXT NOT NULL,
                    capabilities_json TEXT NOT NULL,
                    compatible_runtimes_json TEXT NOT NULL,
                    install_strategy TEXT NOT NULL,
                    status TEXT NOT NULL,
                    installations_json TEXT NOT NULL,
                    visible_agent_ids_json TEXT NOT NULL,
                    metadata_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(kind, slug)
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_resources_kind ON resources(kind)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_resources_source ON resources(source)")
            # Additive migration: old catalogs remain readable and are enriched
            # in place.  SQLite has no portable IF NOT EXISTS for columns.
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(resources)")}
            for name, declaration in {
                "parent_resource_id": "TEXT",
                "source_url": "TEXT",
                "indexed_at": "TEXT",
                "index_status": "TEXT NOT NULL DEFAULT 'active'",
            }.items():
                if name not in columns:
                    conn.execute(f"ALTER TABLE resources ADD COLUMN {name} {declaration}")
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_resources_parent "
                "ON resources(parent_resource_id, index_status, name)"
            )
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_child_url "
                "ON resources(parent_resource_id, source_url) "
                "WHERE parent_resource_id IS NOT NULL AND source_url IS NOT NULL"
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS resource_operations (
                    operation_id TEXT PRIMARY KEY,
                    resource_id TEXT,
                    action TEXT NOT NULL,
                    status TEXT NOT NULL,
                    detail TEXT NOT NULL,
                    targets_json TEXT NOT NULL,
                    metadata_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_resource_operations_resource "
                "ON resource_operations(resource_id, created_at)"
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS resource_preferences (
                    preference_key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS discovery_sources (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    url TEXT NOT NULL UNIQUE,
                    provider TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    description TEXT NOT NULL,
                    enabled INTEGER NOT NULL,
                    available INTEGER NOT NULL,
                    requires_credentials INTEGER NOT NULL,
                    setup_hint TEXT,
                    metadata_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS resource_groups (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL COLLATE NOCASE,
                    description TEXT NOT NULL DEFAULT '',
                    parent_id TEXT REFERENCES resource_groups(id) ON DELETE RESTRICT,
                    sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order >= 0),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(parent_id, name)
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_resource_groups_parent "
                "ON resource_groups(parent_id, sort_order, name)"
            )
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_groups_unique_name "
                "ON resource_groups(COALESCE(parent_id, ''), name COLLATE NOCASE)"
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS resource_group_assignments (
                    resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
                    group_id TEXT NOT NULL REFERENCES resource_groups(id) ON DELETE CASCADE
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_resource_group_assignments_group "
                "ON resource_group_assignments(group_id, resource_id)"
            )
            try:
                conn.execute(
                    "CREATE VIRTUAL TABLE IF NOT EXISTS resource_fts USING fts5("
                    "resource_id UNINDEXED, name, summary, tags, capabilities)"
                )
                self._fts_available = True
                conn.execute(
                    "CREATE VIRTUAL TABLE IF NOT EXISTS resource_fts_v2 USING fts5("
                    "resource_id UNINDEXED, name, summary, tags, capabilities, "
                    "aliases, use_cases, parent_context)"
                )
                indexed = conn.execute("SELECT count(*) FROM resource_fts_v2").fetchone()[0]
                total = conn.execute("SELECT count(*) FROM resources").fetchone()[0]
                if indexed != total:
                    conn.execute("DELETE FROM resource_fts_v2")
                    for row in conn.execute("SELECT * FROM resources").fetchall():
                        item = self._row_to_item(row)
                        document = self._search_document(item, conn)
                        conn.execute(
                            "INSERT INTO resource_fts_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                            document,
                        )
            except sqlite3.DatabaseError:
                self._fts_available = False
            self._deduplicate_repository_urls(conn)

    @staticmethod
    def _summary_is_editorial(summary: object) -> bool:
        text = str(summary or "").strip()
        return bool(text) and not re.search(r"<\/?[a-z][^>]*>", text, re.IGNORECASE)

    @classmethod
    def _duplicate_quality(cls, row: sqlite3.Row) -> tuple[int, int, int]:
        summary = str(row["summary"] or "")
        metadata = str(row["metadata_json"] or "")
        # Prefer human-readable summaries, then records carrying the richer
        # analysis payload, then the most complete summary.
        return (
            1 if cls._summary_is_editorial(summary) else 0,
            len(metadata),
            len(summary),
        )

    @staticmethod
    def _merge_json_values(first: str, second: str) -> str:
        try:
            left = json.loads(first or "[]")
        except (TypeError, json.JSONDecodeError):
            left = []
        try:
            right = json.loads(second or "[]")
        except (TypeError, json.JSONDecodeError):
            right = []
        if isinstance(left, dict) and isinstance(right, dict):
            merged = dict(right)
            merged.update(left)
            return json.dumps(merged, ensure_ascii=False, sort_keys=True)
        values: list[object] = []
        for value in [*(left if isinstance(left, list) else []), *(right if isinstance(right, list) else [])]:
            if value not in values:
                values.append(value)
        return json.dumps(values, ensure_ascii=False, sort_keys=True)

    def _deduplicate_repository_urls(self, conn: sqlite3.Connection) -> None:
        """Merge exact repository duplicates from legacy and analyzed catalogs.

        This migration is deliberately narrow: only equal canonical URLs are
        merged.  It never guesses from names alone, so unrelated resources
        such as two tools called ``ecc`` remain independent unless they point
        at the same repository.  The best editorial summary survives while
        metadata, tags, installations and assignments are unioned.
        """
        groups = conn.execute(
            "SELECT lower(rtrim(repo_url, '/')) AS canonical, COUNT(*) AS total "
            "FROM resources WHERE repo_url IS NOT NULL AND trim(repo_url) <> '' "
            "GROUP BY lower(rtrim(repo_url, '/')) HAVING COUNT(*) > 1"
        ).fetchall()
        for group in groups:
            rows = conn.execute(
                "SELECT * FROM resources WHERE lower(rtrim(repo_url, '/')) = ? "
                "ORDER BY id",
                (group["canonical"],),
            ).fetchall()
            if len(rows) < 2:
                continue
            keeper = max(rows, key=self._duplicate_quality)
            for duplicate in rows:
                if duplicate["id"] == keeper["id"]:
                    continue
                try:
                    # Keep referential data before deleting the duplicate.
                    conn.execute(
                        "INSERT OR IGNORE INTO resource_group_assignments(resource_id, group_id) "
                        "SELECT ?, group_id FROM resource_group_assignments WHERE resource_id = ?",
                        (keeper["id"], duplicate["id"]),
                    )
                    conn.execute(
                        "UPDATE resource_operations SET resource_id = ? WHERE resource_id = ?",
                        (keeper["id"], duplicate["id"]),
                    )
                    conn.execute(
                        "UPDATE resources SET parent_resource_id = ? "
                        "WHERE parent_resource_id = ?",
                        (keeper["id"], duplicate["id"]),
                    )
                    summary = str(keeper["summary"] or "")
                    duplicate_summary = str(duplicate["summary"] or "")
                    if (not self._summary_is_editorial(summary) and self._summary_is_editorial(duplicate_summary)) or (
                        self._summary_is_editorial(summary)
                        and self._summary_is_editorial(duplicate_summary)
                        and len(duplicate_summary) > len(summary)
                    ):
                        summary = duplicate_summary
                    metadata = self._merge_json_values(keeper["metadata_json"], duplicate["metadata_json"])
                    try:
                        metadata_obj = json.loads(metadata)
                    except (TypeError, json.JSONDecodeError):
                        metadata_obj = {}
                    if isinstance(metadata_obj, dict):
                        merged_ids = list(metadata_obj.get("deduplicated_resource_ids") or [])
                        if duplicate["id"] not in merged_ids:
                            merged_ids.append(duplicate["id"])
                        metadata_obj["deduplicated_resource_ids"] = merged_ids
                        metadata = json.dumps(metadata_obj, ensure_ascii=False, sort_keys=True)
                    installations = self._merge_json_values(keeper["installations_json"], duplicate["installations_json"])
                    status = "installed" if "installed" in {keeper["status"], duplicate["status"]} else keeper["status"]
                    conn.execute(
                        "UPDATE resources SET summary = ?, tags_json = ?, requirements_json = ?, "
                        "capabilities_json = ?, compatible_runtimes_json = ?, installations_json = ?, "
                        "metadata_json = ?, status = ?, updated_at = ? WHERE id = ?",
                        (
                            summary,
                            self._merge_json_values(keeper["tags_json"], duplicate["tags_json"]),
                            self._merge_json_values(keeper["requirements_json"], duplicate["requirements_json"]),
                            self._merge_json_values(keeper["capabilities_json"], duplicate["capabilities_json"]),
                            self._merge_json_values(keeper["compatible_runtimes_json"], duplicate["compatible_runtimes_json"]),
                            installations,
                            metadata,
                            status,
                            _now().isoformat(),
                            keeper["id"],
                        ),
                    )
                    if self._fts_available:
                        conn.execute("DELETE FROM resource_fts WHERE resource_id = ?", (duplicate["id"],))
                        conn.execute("DELETE FROM resource_fts_v2 WHERE resource_id = ?", (duplicate["id"],))
                    conn.execute("DELETE FROM resource_group_assignments WHERE resource_id = ?", (duplicate["id"],))
                    conn.execute("DELETE FROM resources WHERE id = ?", (duplicate["id"],))
                    keeper = conn.execute("SELECT * FROM resources WHERE id = ?", (keeper["id"],)).fetchone()
                except sqlite3.IntegrityError:
                    # A conflicting child URL or external legacy constraint
                    # must not prevent the rest of the catalog from starting.
                    continue
            if self._fts_available and keeper:
                item = self._row_to_item(keeper)
                conn.execute("DELETE FROM resource_fts WHERE resource_id = ?", (item.id,))
                conn.execute(
                    "INSERT INTO resource_fts(resource_id, name, summary, tags, capabilities) VALUES (?, ?, ?, ?, ?)",
                    (item.id, item.name, item.summary, " ".join(item.tags), " ".join(item.capabilities)),
                )
                conn.execute("DELETE FROM resource_fts_v2 WHERE resource_id = ?", (item.id,))
                conn.execute("INSERT INTO resource_fts_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?)", self._search_document(item, conn))

    def upsert(self, item: ResourceItem) -> ResourceItem:
        now = _now()
        with self._connect() as conn:
            existing = conn.execute(
                "SELECT * FROM resources WHERE kind = ? AND slug = ?",
                (item.kind.value, item.slug),
            ).fetchone()
            if existing is None and item.repo_url:
                canonical = str(item.repo_url).strip().rstrip("/").casefold()
                if canonical:
                    existing = conn.execute(
                        "SELECT * FROM resources WHERE lower(rtrim(repo_url, '/')) = ? "
                        "ORDER BY length(summary) DESC LIMIT 1",
                        (canonical,),
                    ).fetchone()
            prior = self._row_to_item(existing) if existing is not None else None
            if (
                prior is not None
                and (prior.metadata.get("source_analyzed_at") or prior.metadata.get("summarized_at"))
                and not (item.metadata.get("source_analyzed_at") or item.metadata.get("summarized_at"))
            ):
                # Startup seeds are intentionally lightweight.  Once a source
                # has been inspected, a later idempotent seed must never erase
                # its detected components, revision or functional metadata.
                item = item.model_copy(update={
                    "name": prior.name,
                    "summary": prior.summary,
                    "tags": prior.tags,
                    "requirements": prior.requirements,
                    "capabilities": prior.capabilities,
                    "compatible_runtimes": prior.compatible_runtimes,
                    "install_strategy": prior.install_strategy,
                    # Keep analyzed/operator-owned values authoritative while
                    # still allowing later seed schema additions (for example
                    # source_role and acceptance_example) to reach old rows.
                    "metadata": {**item.metadata, **prior.metadata},
                })
            if existing is not None and (
                existing["kind"] != item.kind.value or existing["slug"] != item.slug
            ):
                # A legacy Naityer capability and a later GitHub skill may
                # describe the same repository.  Keep the established id,
                # kind and slug so seed refreshes cannot recreate a duplicate;
                # preserve operator-owned installation and visibility state.
                prior = prior or self._row_to_item(existing)
                item = item.model_copy(update={
                    "id": prior.id,
                    "slug": prior.slug,
                    "kind": prior.kind,
                    "created_at": prior.created_at,
                    "installations": prior.installations,
                    "visible_agent_ids": prior.visible_agent_ids,
                    "status": prior.status if prior.installations else item.status,
                })
            payload = item.model_copy(
                update={
                    "id": existing["id"] if existing else item.id,
                    "created_at": datetime.fromisoformat(existing["created_at"]) if existing else item.created_at,
                    "updated_at": now,
                }
            )
            values = self._to_values(payload)
            conn.execute(
                """
                INSERT INTO resources (
                    id, slug, name, kind, source, repo_url, summary, tags_json,
                    requirements_json, capabilities_json, compatible_runtimes_json,
                    install_strategy, status, installations_json,
                    visible_agent_ids_json, metadata_json, created_at, updated_at,
                    parent_resource_id, source_url, indexed_at, index_status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(kind, slug) DO UPDATE SET
                    name=excluded.name, source=excluded.source, repo_url=excluded.repo_url,
                    summary=excluded.summary, tags_json=excluded.tags_json,
                    requirements_json=excluded.requirements_json,
                    capabilities_json=excluded.capabilities_json,
                    compatible_runtimes_json=excluded.compatible_runtimes_json,
                    install_strategy=excluded.install_strategy, status=excluded.status,
                    installations_json=excluded.installations_json,
                    visible_agent_ids_json=excluded.visible_agent_ids_json,
                    metadata_json=excluded.metadata_json, updated_at=excluded.updated_at,
                    parent_resource_id=excluded.parent_resource_id,
                    source_url=excluded.source_url, indexed_at=excluded.indexed_at,
                    index_status=excluded.index_status
                """,
                values,
            )
            if self._fts_available:
                try:
                    conn.execute("DELETE FROM resource_fts WHERE resource_id = ?", (payload.id,))
                    conn.execute(
                        "INSERT INTO resource_fts(resource_id, name, summary, tags, capabilities) VALUES (?, ?, ?, ?, ?)",
                        (payload.id, payload.name, payload.summary, " ".join(payload.tags), " ".join(payload.capabilities)),
                    )
                    conn.execute("DELETE FROM resource_fts_v2 WHERE resource_id = ?", (payload.id,))
                    conn.execute(
                        "INSERT INTO resource_fts_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        self._search_document(payload, conn),
                    )
                except sqlite3.DatabaseError:
                    self._fts_available = False
        return payload

    def create(self, request: ResourceCreateRequest) -> ResourceItem:
        with self._connect() as conn:
            if conn.execute(
                "SELECT 1 FROM resources WHERE kind = ? AND slug = ?",
                (request.kind.value, request.slug),
            ).fetchone():
                raise ValueError(f"Resource already exists: {request.kind.value}/{request.slug}")
        created = self.upsert(ResourceItem(**request.model_dump()))
        self.apply_resource_taxonomy()
        return self.get(created.id)

    def get(self, resource_id: str) -> ResourceItem:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM resources WHERE id = ?", (resource_id,)).fetchone()
        if row is None:
            raise KeyError(resource_id)
        return self._row_to_item(row)

    def find_by_repo_url(self, repo_url: str) -> ResourceItem | None:
        canonical = str(repo_url or "").strip().rstrip("/").casefold()
        if not canonical:
            return None
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM resources WHERE lower(rtrim(repo_url, '/')) = ? ORDER BY length(summary) DESC LIMIT 1",
                (canonical,),
            ).fetchone()
        return self._row_to_item(row) if row else None

    def update_resource(self, resource_id: str, request: ResourceUpdateRequest) -> ResourceItem:
        item = self.get(resource_id)
        changes = request.model_dump(exclude_unset=True)
        if "summary" in changes:
            changes["summary"] = " ".join(str(changes["summary"] or "").split()).strip()
            changes["metadata"] = {**item.metadata, "summary_edited": True}
        updated = item.model_copy(update=changes)
        return self.upsert(updated)

    def get_by_slug(self, slug: str, kind: ResourceKind | str | None = None) -> ResourceItem:
        query = "SELECT * FROM resources WHERE slug = ?"
        params: list[str] = [slug]
        if kind is not None:
            query += " AND kind = ?"
            params.append(kind.value if isinstance(kind, ResourceKind) else kind)
        query += " ORDER BY kind LIMIT 1"
        with self._connect() as conn:
            row = conn.execute(query, params).fetchone()
        if row is None:
            raise KeyError(slug)
        return self._row_to_item(row)

    def list_resources(
        self,
        *,
        kind: ResourceKind | str | None = None,
        source: str | None = None,
        limit: int = 100,
        offset: int = 0,
        include_inactive: bool = False,
    ) -> list[ResourceItem]:
        clauses: list[str] = []
        params: list[object] = []
        if not include_inactive:
            clauses.append("index_status != 'inactive'")
        if kind is not None:
            clauses.append("kind = ?")
            params.append(kind.value if isinstance(kind, ResourceKind) else kind)
        if source:
            clauses.append("source = ?")
            params.append(source)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        params.extend((max(1, min(limit, 500)), max(0, offset)))
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM resources{where} ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?",
                params,
            ).fetchall()
        return [self._row_to_item(row) for row in rows]

    def list_all_resources(
        self,
        *,
        kind: ResourceKind | str | None = None,
        source: str | None = None,
        include_inactive: bool = False,
    ) -> list[ResourceItem]:
        """Return the complete catalog through bounded SQLite pages.

        Components may outnumber top-level artifacts, so callers must not use
        a single 500-row page as if it represented the whole Composite tree.
        """
        items: list[ResourceItem] = []
        offset = 0
        while True:
            page = self.list_resources(
                kind=kind, source=source, limit=500, offset=offset,
                include_inactive=include_inactive,
            )
            items.extend(page)
            if len(page) < 500:
                return items
            offset += len(page)

    def search(self, query: str, *, limit: int = 50) -> list[ResourceItem]:
        terms = _WORD_RE.findall(query)[:12]
        if not terms:
            return []
        cap = max(1, min(limit, 200))
        with self._connect() as conn:
            if self._fts_available:
                expression = " AND ".join(f'"{term.replace(chr(34), chr(34) * 2)}"*' for term in terms)
                try:
                    rows = conn.execute(
                        "SELECT r.* FROM resource_fts f JOIN resources r ON r.id = f.resource_id "
                        "WHERE resource_fts MATCH ? ORDER BY bm25(resource_fts), r.name LIMIT ?",
                        (expression, cap),
                    ).fetchall()
                    return [self._row_to_item(row) for row in rows]
                except sqlite3.DatabaseError:
                    self._fts_available = False
            needle = f"%{' '.join(terms)}%"
            rows = conn.execute(
                "SELECT * FROM resources WHERE name LIKE ? OR summary LIKE ? OR tags_json LIKE ? "
                "OR capabilities_json LIKE ? ORDER BY name COLLATE NOCASE LIMIT ?",
                (needle, needle, needle, needle, cap),
            ).fetchall()
        return [self._row_to_item(row) for row in rows]

    def recommendation_candidates(self, query: str, *, limit: int = 100) -> list[ResourceItem]:
        """Retrieve a bounded candidate set; deterministic reranking happens later."""
        terms = [term for term in _WORD_RE.findall(query.casefold()) if len(term) >= 2][:32]
        if not terms:
            return []
        cap = max(1, min(limit, 100))
        with self._connect() as conn:
            if self._fts_available:
                expression = " OR ".join(
                    f'"{term.replace(chr(34), chr(34) * 2)}"*' for term in dict.fromkeys(terms)
                )
                try:
                    rows = conn.execute(
                        "SELECT r.* FROM resource_fts_v2 f JOIN resources r ON r.id=f.resource_id "
                        "WHERE resource_fts_v2 MATCH ? AND r.index_status != 'inactive' "
                        "ORDER BY bm25(resource_fts_v2, 0, 10, 5, 3, 8, 4, 5, 2), r.name COLLATE NOCASE LIMIT ?",
                        (expression, cap),
                    ).fetchall()
                    return [self._row_to_item(row) for row in rows]
                except sqlite3.DatabaseError:
                    self._fts_available = False
            clauses: list[str] = []
            params: list[object] = []
            for term in dict.fromkeys(terms[:12]):
                clauses.append(
                    "(name LIKE ? OR summary LIKE ? OR tags_json LIKE ? OR capabilities_json LIKE ? OR metadata_json LIKE ?)"
                )
                params.extend([f"%{term}%"] * 5)
            params.append(cap)
            rows = conn.execute(
                "SELECT * FROM resources WHERE index_status != 'inactive' AND (" + " OR ".join(clauses) + ") "
                "ORDER BY name COLLATE NOCASE LIMIT ?",
                params,
            ).fetchall()
        return [self._row_to_item(row) for row in rows]

    def list_children(self, parent_resource_id: str, *, include_inactive: bool = False) -> list[ResourceItem]:
        status = "" if include_inactive else " AND index_status='active'"
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM resources WHERE parent_resource_id=?" + status + " ORDER BY name COLLATE NOCASE",
                (parent_resource_id,),
            ).fetchall()
        return [self._row_to_item(row) for row in rows]

    def replace_children(self, parent_resource_id: str, children: Iterable[ResourceItem]) -> tuple[int, int]:
        """Idempotently refresh one directory and retain disappeared entries as inactive."""
        current = {item.source_url: item for item in self.list_children(parent_resource_id, include_inactive=True)}
        seen: set[str] = set()
        indexed = 0
        for child in children:
            if not child.source_url:
                raise ValueError("nested resources require a canonical source_url")
            seen.add(child.source_url)
            existing = current.get(child.source_url)
            if existing:
                child = child.model_copy(update={"id": existing.id, "created_at": existing.created_at})
            self.upsert(child.model_copy(update={
                "parent_resource_id": parent_resource_id,
                "index_status": "active",
                "indexed_at": child.indexed_at or _now(),
            }))
            indexed += 1
        inactive = 0
        for source_url, item in current.items():
            if source_url not in seen and item.index_status != "inactive":
                self.upsert(item.model_copy(update={"index_status": "inactive", "indexed_at": _now()}))
                inactive += 1
        return indexed, inactive

    def set_visibility(self, resource_id: str, agent_ids: list[str]) -> ResourceItem:
        item = self.get(resource_id)
        cleaned = sorted({value.strip() for value in agent_ids if value and value.strip()}, key=str.casefold)
        return self.upsert(item.model_copy(update={"visible_agent_ids": cleaned}))

    def get_preference(self, key: str, default: object = None) -> object:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT value_json FROM resource_preferences WHERE preference_key = ?", (key,)
            ).fetchone()
        if row is None:
            return default
        try:
            return json.loads(row["value_json"])
        except (TypeError, json.JSONDecodeError):
            return default

    def set_preference(self, key: str, value: object) -> object:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO resource_preferences(preference_key, value_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(preference_key) DO UPDATE SET
                    value_json=excluded.value_json, updated_at=excluded.updated_at
                """,
                (key, encoded, _now().isoformat()),
            )
        return value

    def upsert_discovery_source(self, source: DiscoverySource) -> DiscoverySource:
        payload = source.model_copy(update={"updated_at": _now()})
        with self._connect() as conn:
            existing = conn.execute("SELECT created_at FROM discovery_sources WHERE url=?", (payload.url,)).fetchone()
            if existing:
                payload = payload.model_copy(update={"created_at": datetime.fromisoformat(existing["created_at"])})
            conn.execute(
                """
                INSERT INTO discovery_sources (
                    id,name,url,provider,source_type,description,enabled,available,
                    requires_credentials,setup_hint,metadata_json,created_at,updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(url) DO UPDATE SET
                    name=excluded.name, provider=excluded.provider,
                    source_type=excluded.source_type, description=excluded.description,
                    enabled=excluded.enabled, available=excluded.available,
                    requires_credentials=excluded.requires_credentials,
                    setup_hint=excluded.setup_hint, metadata_json=excluded.metadata_json,
                    updated_at=excluded.updated_at
                """,
                (
                    payload.id, payload.name, payload.url, payload.provider,
                    payload.source_type, payload.description, int(payload.enabled),
                    int(payload.available), int(payload.requires_credentials),
                    payload.setup_hint, json.dumps(payload.metadata, ensure_ascii=False),
                    payload.created_at.isoformat(), payload.updated_at.isoformat(),
                ),
            )
            row = conn.execute("SELECT * FROM discovery_sources WHERE url=?", (payload.url,)).fetchone()
        return self._row_to_discovery_source(row)

    def list_discovery_sources(self) -> list[DiscoverySource]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM discovery_sources ORDER BY name COLLATE NOCASE, id").fetchall()
        return [self._row_to_discovery_source(row) for row in rows]

    @staticmethod
    def _row_to_discovery_source(row: sqlite3.Row) -> DiscoverySource:
        return DiscoverySource(
            id=row["id"], name=row["name"], url=row["url"], provider=row["provider"],
            source_type=row["source_type"], description=row["description"],
            enabled=bool(row["enabled"]), available=bool(row["available"]),
            requires_credentials=bool(row["requires_credentials"]), setup_hint=row["setup_hint"],
            metadata=json.loads(row["metadata_json"] or "{}"),
            created_at=datetime.fromisoformat(row["created_at"]),
            updated_at=datetime.fromisoformat(row["updated_at"]),
        )

    def migrate_radar_profiles(self) -> list[DiscoverySource]:
        """Move legacy Radar profiles out of the artifact catalog without deleting history."""
        from app.resource_sources import classify_external_url

        migrated: list[DiscoverySource] = []
        for item in self.list_resources(limit=500):
            if item.metadata.get("inspiration_collection") != "radar" or not item.repo_url:
                continue
            classification = classify_external_url(item.repo_url)
            if classification.role != "discovery_source":
                continue
            source = self.upsert_discovery_source(DiscoverySource(
                id=f"custom-{item.id}", name=item.name, url=classification.canonical_url,
                provider=classification.provider, source_type="account",
                description=item.summary, enabled=True, available=False,
                requires_credentials=classification.provider in {"threads", "x"},
                setup_hint=("Configura la API de Meta Threads para leer sus publicaciones."
                            if classification.provider == "threads" else "Configura el proveedor para leer esta fuente."),
                metadata={"migrated_from_resource_id": item.id},
            ))
            self.upsert(item.model_copy(update={
                "index_status": "inactive",
                "metadata": {**item.metadata, "migrated_to_discovery_source_id": source.id},
            }))
            migrated.append(source)
        return migrated

    def ensure_default_groups(self) -> list[ResourceGroup]:
        """Ensure the task-oriented catalog taxonomy exists.

        Stable system ids make this an idempotent migration. Assignments made
        to operator-created groups are deliberately left untouched.
        """
        return self.apply_resource_taxonomy()

    def apply_resource_taxonomy(self) -> list[ResourceGroup]:
        """Create the decision taxonomy and classify system-owned resources."""
        from app.resource_taxonomy import TAXONOMY_NODES, TAXONOMY_VERSION, taxonomy_path

        taxonomy_ids = {node.id for node in TAXONOMY_NODES}
        legacy_ids = {"rgrp_skills", "rgrp_capabilities", "rgrp_references"}
        now = _now().isoformat()
        with self._connect() as conn:
            legacy_editorial_ids = {
                row["id"] for row in conn.execute(
                    "SELECT id FROM resource_groups WHERE description LIKE 'Clasificación editorial:%'"
                ).fetchall()
            }
            system_ids = taxonomy_ids | legacy_ids | legacy_editorial_ids
            for node in TAXONOMY_NODES:
                conn.execute(
                    "INSERT INTO resource_groups(id, name, description, parent_id, sort_order, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET "
                    "name=excluded.name, description=excluded.description, parent_id=excluded.parent_id, "
                    "sort_order=excluded.sort_order, updated_at=excluded.updated_at",
                    (node.id, node.name, node.description, node.parent_id, node.sort_order, now, now),
                )
            assignments = {
                row["resource_id"]: row["group_id"] for row in conn.execute(
                    "SELECT resource_id, group_id FROM resource_group_assignments"
                ).fetchall()
            }
            for row in conn.execute("SELECT * FROM resources").fetchall():
                item = self._row_to_item(row)
                owner = assignments.get(item.id)
                if owner is not None and owner not in system_ids:
                    continue
                root, leaf = taxonomy_path(item)
                conn.execute(
                    "INSERT INTO resource_group_assignments(resource_id, group_id) VALUES (?, ?) "
                    "ON CONFLICT(resource_id) DO UPDATE SET group_id=excluded.group_id",
                    (item.id, leaf.id),
                )
                metadata = dict(item.metadata)
                metadata["decision_taxonomy"] = {
                    "version": TAXONOMY_VERSION,
                    "family_id": root.id,
                    "family": root.name,
                    "group_id": leaf.id,
                    "group": leaf.name,
                    "tone": root.tone,
                }
                conn.execute(
                    "UPDATE resources SET metadata_json = ?, updated_at = ? WHERE id = ?",
                    (json.dumps(metadata, ensure_ascii=False, sort_keys=True), now, item.id),
                )
            # Retire only empty legacy system groups. Custom descendants and
            # their assignments prevent deletion and remain operator-owned.
            for group_id in sorted(legacy_editorial_ids):
                has_resources = conn.execute(
                    "SELECT 1 FROM resource_group_assignments WHERE group_id = ? LIMIT 1", (group_id,)
                ).fetchone()
                has_children = conn.execute(
                    "SELECT 1 FROM resource_groups WHERE parent_id = ? LIMIT 1", (group_id,)
                ).fetchone()
                if not has_resources and not has_children:
                    conn.execute("DELETE FROM resource_groups WHERE id = ?", (group_id,))
            for group_id in sorted(legacy_ids):
                # A custom subgroup survives migration as a root instead of
                # keeping the obsolete Skills/Habilidades/Recursos wrapper.
                conn.execute(
                    "UPDATE resource_groups SET parent_id = NULL, updated_at = ? "
                    "WHERE parent_id = ? AND id NOT IN ({})".format(
                        ",".join("?" for _ in taxonomy_ids)
                    ),
                    (now, group_id, *sorted(taxonomy_ids)),
                )
                has_resources = conn.execute(
                    "SELECT 1 FROM resource_group_assignments WHERE group_id = ? LIMIT 1", (group_id,)
                ).fetchone()
                has_children = conn.execute(
                    "SELECT 1 FROM resource_groups WHERE parent_id = ? LIMIT 1", (group_id,)
                ).fetchone()
                if not has_resources and not has_children:
                    conn.execute("DELETE FROM resource_groups WHERE id = ?", (group_id,))
            return self._list_groups_conn(conn)

    def list_groups(self) -> list[ResourceGroup]:
        with self._connect() as conn:
            return self._list_groups_conn(conn)

    def create_group(self, request: ResourceGroupCreateRequest) -> ResourceGroup:
        group = ResourceGroup(**request.model_dump())
        now = _now().isoformat()
        with self._connect() as conn:
            self._validate_group_parent(conn, group.id, group.parent_id)
            try:
                conn.execute(
                    "INSERT INTO resource_groups(id, name, description, parent_id, sort_order, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (group.id, group.name, group.description, group.parent_id, group.sort_order, now, now),
                )
            except sqlite3.IntegrityError as exc:
                raise ValueError("a group with this name already exists under the selected parent") from exc
            return self._get_group_conn(conn, group.id)

    def update_group(self, group_id: str, request: ResourceGroupUpdateRequest) -> ResourceGroup:
        with self._connect() as conn:
            self._get_group_conn(conn, group_id)
            self._validate_group_parent(conn, group_id, request.parent_id)
            try:
                conn.execute(
                    "UPDATE resource_groups SET name = ?, description = ?, parent_id = ?, "
                    "sort_order = ?, updated_at = ? WHERE id = ?",
                    (request.name, request.description, request.parent_id, request.sort_order, _now().isoformat(), group_id),
                )
            except sqlite3.IntegrityError as exc:
                raise ValueError("a group with this name already exists under the selected parent") from exc
            return self._get_group_conn(conn, group_id)

    def delete_group(self, group_id: str, *, move_to_id: str | None = None) -> None:
        with self._connect() as conn:
            current = self._get_group_conn(conn, group_id)
            if move_to_id == group_id:
                raise ValueError("a deleted group cannot be its own destination")
            if move_to_id is not None:
                self._get_group_conn(conn, move_to_id)
                descendants = self._descendant_ids(conn, group_id)
                if move_to_id in descendants:
                    raise ValueError("resources cannot be moved into a descendant of the deleted group")
                conn.execute(
                    "UPDATE resource_group_assignments SET group_id = ? WHERE group_id = ?",
                    (move_to_id, group_id),
                )
            else:
                conn.execute("DELETE FROM resource_group_assignments WHERE group_id = ?", (group_id,))
            conn.execute(
                "UPDATE resource_groups SET parent_id = ?, updated_at = ? WHERE parent_id = ?",
                (current.parent_id, _now().isoformat(), group_id),
            )
            conn.execute("DELETE FROM resource_groups WHERE id = ?", (group_id,))

    def assign_groups(self, assignments: dict[str, str | None]) -> list[ResourceGroup]:
        with self._connect() as conn:
            resource_ids = set(assignments)
            if resource_ids:
                placeholders = ",".join("?" for _ in resource_ids)
                existing = {
                    row["id"] for row in conn.execute(
                        f"SELECT id FROM resources WHERE id IN ({placeholders})", tuple(resource_ids)
                    ).fetchall()
                }
                missing = sorted(resource_ids - existing)
                if missing:
                    raise KeyError(f"unknown resource ids: {', '.join(missing)}")
            group_ids = {value for value in assignments.values() if value is not None}
            if group_ids:
                placeholders = ",".join("?" for _ in group_ids)
                existing = {
                    row["id"] for row in conn.execute(
                        f"SELECT id FROM resource_groups WHERE id IN ({placeholders})", tuple(group_ids)
                    ).fetchall()
                }
                missing = sorted(group_ids - existing)
                if missing:
                    raise KeyError(f"unknown group ids: {', '.join(missing)}")
            for resource_id, group_id in assignments.items():
                if group_id is None:
                    conn.execute("DELETE FROM resource_group_assignments WHERE resource_id = ?", (resource_id,))
                else:
                    conn.execute(
                        "INSERT INTO resource_group_assignments(resource_id, group_id) VALUES (?, ?) "
                        "ON CONFLICT(resource_id) DO UPDATE SET group_id = excluded.group_id",
                        (resource_id, group_id),
                    )
            return self._list_groups_conn(conn)

    @staticmethod
    def _descendant_ids(conn: sqlite3.Connection, group_id: str) -> set[str]:
        rows = conn.execute(
            "WITH RECURSIVE descendants(id) AS ("
            "SELECT id FROM resource_groups WHERE parent_id = ? UNION ALL "
            "SELECT g.id FROM resource_groups g JOIN descendants d ON g.parent_id = d.id"
            ") SELECT id FROM descendants",
            (group_id,),
        ).fetchall()
        return {row["id"] for row in rows}

    def _validate_group_parent(
        self, conn: sqlite3.Connection, group_id: str, parent_id: str | None
    ) -> None:
        if parent_id is None:
            return
        if parent_id == group_id:
            raise ValueError("a resource group cannot be its own parent")
        self._get_group_conn(conn, parent_id)
        if parent_id in self._descendant_ids(conn, group_id):
            raise ValueError("resource group hierarchy cannot contain cycles")
        depth = 2
        cursor = parent_id
        while cursor is not None:
            row = conn.execute("SELECT parent_id FROM resource_groups WHERE id = ?", (cursor,)).fetchone()
            cursor = row["parent_id"] if row else None
            if cursor is not None:
                depth += 1
        subtree_depth = self._subtree_depth(conn, group_id)
        if depth + subtree_depth - 1 > MAX_RESOURCE_GROUP_DEPTH:
            raise ValueError(f"resource group hierarchy is limited to {MAX_RESOURCE_GROUP_DEPTH} levels")

    @staticmethod
    def _subtree_depth(conn: sqlite3.Connection, group_id: str) -> int:
        if not conn.execute("SELECT 1 FROM resource_groups WHERE id = ?", (group_id,)).fetchone():
            return 1
        row = conn.execute(
            "WITH RECURSIVE tree(id, depth) AS ("
            "SELECT id, 1 FROM resource_groups WHERE id = ? UNION ALL "
            "SELECT g.id, tree.depth + 1 FROM resource_groups g JOIN tree ON g.parent_id = tree.id"
            ") SELECT MAX(depth) AS depth FROM tree",
            (group_id,),
        ).fetchone()
        return int(row["depth"] or 1)

    @staticmethod
    def _get_group_conn(conn: sqlite3.Connection, group_id: str) -> ResourceGroup:
        row = conn.execute("SELECT * FROM resource_groups WHERE id = ?", (group_id,)).fetchone()
        if row is None:
            raise KeyError(group_id)
        resource_ids = [
            entry["resource_id"] for entry in conn.execute(
                "SELECT a.resource_id FROM resource_group_assignments a "
                "JOIN resources r ON r.id = a.resource_id WHERE a.group_id = ? "
                "ORDER BY r.name COLLATE NOCASE, a.resource_id",
                (group_id,),
            ).fetchall()
        ]
        return ResourceGroup(
            id=row["id"], name=row["name"], description=row["description"],
            parent_id=row["parent_id"], sort_order=row["sort_order"], resource_ids=resource_ids,
        )

    def _list_groups_conn(self, conn: sqlite3.Connection) -> list[ResourceGroup]:
        rows = conn.execute(
            "SELECT id FROM resource_groups ORDER BY sort_order, name COLLATE NOCASE, id"
        ).fetchall()
        return [self._get_group_conn(conn, row["id"]) for row in rows]

    def set_installations(
        self,
        resource_id: str,
        installations: list[ResourceInstallation],
        *,
        status: str | None = None,
    ) -> ResourceItem:
        item = self.get(resource_id)
        derived = status or ("installed" if installations else "available")
        return self.upsert(item.model_copy(update={"installations": installations, "status": derived}))

    def record_operation(
        self,
        *,
        resource_id: str | None,
        action: str,
        status: str,
        detail: str = "",
        targets: list[str] | None = None,
        metadata: dict | None = None,
    ) -> ResourceOperationResult:
        result = ResourceOperationResult(
            operation_id=f"rop_{uuid4().hex[:12]}",
            resource_id=resource_id,
            action=action,
            status=status,
            detail=detail[:4000],
            targets=targets or [],
            metadata=metadata or {},
        )
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO resource_operations VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    result.operation_id,
                    result.resource_id,
                    result.action,
                    result.status,
                    result.detail,
                    json.dumps(result.targets, ensure_ascii=False),
                    json.dumps(result.metadata, ensure_ascii=False, sort_keys=True),
                    result.created_at.isoformat(),
                ),
            )
        return result

    def list_operations(self, resource_id: str | None = None, *, limit: int = 100) -> list[ResourceOperationResult]:
        query = "SELECT * FROM resource_operations"
        params: list[object] = []
        if resource_id is not None:
            query += " WHERE resource_id = ?"
            params.append(resource_id)
        query += " ORDER BY created_at DESC LIMIT ?"
        params.append(max(1, min(limit, 500)))
        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [
            ResourceOperationResult(
                operation_id=row["operation_id"], resource_id=row["resource_id"], action=row["action"],
                status=row["status"], detail=row["detail"], targets=json.loads(row["targets_json"]),
                metadata=json.loads(row["metadata_json"]), created_at=datetime.fromisoformat(row["created_at"]),
            )
            for row in rows
        ]

    @staticmethod
    def _to_values(item: ResourceItem) -> tuple:
        dump = item.model_dump(mode="json")
        return (
            item.id, item.slug, item.name, item.kind.value, item.source, item.repo_url, item.summary,
            json.dumps(dump["tags"], ensure_ascii=False), json.dumps(dump["requirements"], ensure_ascii=False),
            json.dumps(dump["capabilities"], ensure_ascii=False),
            json.dumps(dump["compatible_runtimes"], ensure_ascii=False), item.install_strategy, item.status,
            json.dumps(dump["installations"], ensure_ascii=False, sort_keys=True),
            json.dumps(dump["visible_agent_ids"], ensure_ascii=False),
            json.dumps(dump["metadata"], ensure_ascii=False, sort_keys=True),
            item.created_at.isoformat(), item.updated_at.isoformat(),
            item.parent_resource_id, item.source_url,
            item.indexed_at.isoformat() if item.indexed_at else None, item.index_status,
        )

    @staticmethod
    def _row_to_item(row: sqlite3.Row) -> ResourceItem:
        return ResourceItem(
            id=row["id"], slug=row["slug"], name=row["name"], kind=row["kind"], source=row["source"],
            repo_url=row["repo_url"], summary=row["summary"], tags=json.loads(row["tags_json"]),
            parent_resource_id=row["parent_resource_id"] if "parent_resource_id" in row.keys() else None,
            source_url=row["source_url"] if "source_url" in row.keys() else None,
            indexed_at=(datetime.fromisoformat(row["indexed_at"]) if "indexed_at" in row.keys() and row["indexed_at"] else None),
            index_status=(row["index_status"] if "index_status" in row.keys() and row["index_status"] else "active"),
            requirements=json.loads(row["requirements_json"]), capabilities=json.loads(row["capabilities_json"]),
            compatible_runtimes=json.loads(row["compatible_runtimes_json"]),
            install_strategy=row["install_strategy"], status=row["status"],
            installations=json.loads(row["installations_json"]),
            visible_agent_ids=json.loads(row["visible_agent_ids_json"]), metadata=json.loads(row["metadata_json"]),
            created_at=datetime.fromisoformat(row["created_at"]), updated_at=datetime.fromisoformat(row["updated_at"]),
        )

    @staticmethod
    def _search_document(item: ResourceItem, conn: sqlite3.Connection) -> tuple[str, ...]:
        intelligence = item.metadata.get("intelligence", {}) if isinstance(item.metadata, dict) else {}
        aliases = intelligence.get("aliases", []) if isinstance(intelligence, dict) else []
        use_cases = intelligence.get("use_cases", []) if isinstance(intelligence, dict) else []
        parent_context = ""
        if item.parent_resource_id:
            parent = conn.execute(
                "SELECT name, summary FROM resources WHERE id=?", (item.parent_resource_id,)
            ).fetchone()
            if parent:
                parent_context = f"{parent['name']} {parent['summary']}"
        return (
            item.id, item.name, item.summary, " ".join(item.tags), " ".join(item.capabilities),
            " ".join(str(value) for value in aliases),
            " ".join(str(value) for value in use_cases), parent_context,
        )


def seed_resource_library(
    store: ResourceStore,
    installers_dir: Path | str = DEFAULT_NAITYER_INSTALLERS,
) -> list[ResourceItem]:
    """Idempotently seed Karajan, Naityer and verified editorial resources."""
    from app.skills_catalog import list_skills
    from app.curated_resources import curated_resource_items
    from app.resource_intelligence import extract_resource_signals

    skill_capabilities = {
        "repo-analyzer": ["repository-audit", "code-review", "dependency-analysis"],
        "security-review": ["security-audit"],
        "frontend-builder": ["frontend-development", "data-visualization"],
        "backend-builder": ["api-integration", "database-access"],
        "promptfoo": ["testing"],
        "webapp-testing": ["testing", "browser-automation"],
        "web-artifacts-builder": ["frontend-development"],
        "xlsx": ["spreadsheet-analysis", "data-analysis"],
        "mcp-builder": ["api-integration", "plugin-packaging"],
    }

    seeded: list[ResourceItem] = []
    for skill in list_skills():
        intelligence = extract_resource_signals(
            {"name": skill.name, "description": skill.description}
        ).to_dict()
        functional = sorted(set(intelligence.get("capabilities", ())) | set(skill_capabilities.get(skill.name, ())))
        intelligence["capabilities"] = functional
        item = ResourceItem(
            slug=skill.name.lower().replace("_", "-"),
            name=skill.name,
            kind=ResourceKind.SKILL,
            source="skills_catalog",
            repo_url=skill.repo_url,
            summary=deterministic_summary(skill.name, skill.description),
            tags=["skill", *intelligence.get("tags", ())],
            capabilities=functional,
            compatible_runtimes=skill.applies_to,
            install_strategy="github_skill" if skill.repo_url else "catalog",
            status="installed" if skill.installed else "available",
            metadata={"seed": "app.skills_catalog", "intelligence": intelligence},
        )
        try:
            old = store.get_by_slug(item.slug, ResourceKind.SKILL)
            item = item.model_copy(update={
                "installations": old.installations,
                "visible_agent_ids": old.visible_agent_ids,
                "status": old.status if old.installations else item.status,
            })
        except KeyError:
            pass
        seeded.append(store.upsert(item))

    root = Path(installers_dir)
    repo_by_slug, description_by_slug = _read_naityer_readme(root / "README.md")
    if root.is_dir():
        for script in sorted(root.glob("*.ps1"), key=lambda path: path.name.casefold()):
            slug = script.stem.lower().replace("_", "-")
            description = description_by_slug.get(slug, "")
            item = ResourceItem(
                slug=slug,
                name=script.stem.replace("_", " ").title(),
                kind=ResourceKind.CAPABILITY,
                source="naityer",
                repo_url=repo_by_slug.get(slug),
                summary=deterministic_summary(script.stem.replace("_", " "), description),
                tags=["naityer", "complementos-ia"],
                capabilities=[script.stem],
                compatible_runtimes=["windows", "powershell"],
                install_strategy="naityer_allowlisted",
                metadata={"installer_key": script.stem, "script_path": str(script)},
            )
            item = _preserve_seed_state(store, item)
            seeded.append(store.upsert(item))
        readme = root / "README.md"
        if readme.is_file():
            reference = ResourceItem(
                slug="complementos-ia",
                name="Complementos IA",
                kind=ResourceKind.REFERENCE,
                source="naityer",
                summary="Referencia local del catálogo de complementos IA de Naityer.",
                tags=["naityer", "documentation"],
                install_strategy="none",
                metadata={"path": str(readme)},
            )
            seeded.append(store.upsert(_preserve_seed_state(store, reference)))
    for item in curated_resource_items():
        stored = store.upsert(_preserve_seed_state(store, item))
        seeded.append(stored)
    store.apply_resource_taxonomy()
    return seeded


def _preserve_seed_state(store: ResourceStore, item: ResourceItem) -> ResourceItem:
    """Keep operator-owned state while refreshing seed-owned metadata."""
    try:
        old = store.get_by_slug(item.slug, item.kind)
    except KeyError:
        return item
    return item.model_copy(update={
        "installations": old.installations,
        "visible_agent_ids": old.visible_agent_ids,
        "status": old.status if old.installations else item.status,
    })


def _read_naityer_readme(path: Path) -> tuple[dict[str, str], dict[str, str]]:
    repos: dict[str, str] = {}
    descriptions: dict[str, str] = {}
    if not path.is_file():
        return repos, descriptions
    for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        match = re.match(
            r"^\|\s*([^|]+?)\s*\|\s*\[[^]]+\]\((https://github\.com/[^)]+)\)\s*\|\s*([^|]+?)\s*\|$",
            line,
        )
        if not match:
            continue
        label, repo, description = match.groups()
        slug = label.strip().lower().replace(" ", "-").replace("_", "-")
        aliases = {slug, slug.replace("browser-use", "browser-use"), slug.replace("taste-skill", "taste-skill")}
        for alias in aliases:
            repos[alias] = repo
            descriptions[alias] = description.strip()
    return repos, descriptions
