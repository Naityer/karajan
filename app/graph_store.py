from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from app.models import GraphEdge, GraphNode, GraphSnapshot, RepoConfig

DEFAULT_DB_PATH = Path("data/graph_index.db")


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_resolve(root_path: Path, rel_or_abs: str) -> Path:
    """Resolve a path against a repo root, refusing anything that escapes it.

    Joins `rel_or_abs` onto `root_path` when relative (absolute inputs are used
    as-is), fully resolves the result, and raises `ValueError` if it is not
    contained within `root_path.resolve()`. This is the path-traversal guard for
    later phases that read file content out of a registered repo (Fase C/D); it
    is defined now so the security-sensitive primitive is locked in and tested
    early, even though no route calls it yet in this phase.
    """
    root = root_path.resolve()
    candidate = Path(rel_or_abs)
    if not candidate.is_absolute():
        candidate = root / candidate
    resolved = candidate.resolve()
    if not resolved.is_relative_to(root):
        raise ValueError(f"path {rel_or_abs!r} escapes repo root {root}")
    return resolved


class GraphStore:
    """SQLite-backed store for registered repositories and their code graph.

    Mirrors `app.database.TaskStore`'s connection/migration style: a fresh
    connection per call with WAL/NORMAL/busy_timeout pragmas, idempotent schema
    creation, and an unconditional `_migrate()` pass for future columns. Backed
    by its own DB file (`data/graph_index.db`) since the graph has different
    write patterns and scale than the task log.
    """

    def __init__(self, db_path: Path | str = DEFAULT_DB_PATH) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        # WAL lets the dashboard read while a scan writes, instead of serializing
        # behind a single lock; NORMAL keeps that safe and fast. busy_timeout
        # avoids spurious "database is locked" under contention.
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS repos (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    root_path TEXT NOT NULL UNIQUE,
                    language_hint TEXT,
                    provider_override TEXT,
                    exclude_globs TEXT,
                    created_at TEXT NOT NULL,
                    last_scanned_at TEXT,
                    last_scan_status TEXT,
                    last_scan_summary_json TEXT
                )
                """
            )
            # Files/nodes/edges/findings are created now (Fase A) but stay empty
            # until later phases populate them — building them up front avoids a
            # second migration pass when static analysis lands.
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS graph_files (
                    id TEXT PRIMARY KEY,
                    repo_id TEXT NOT NULL,
                    rel_path TEXT NOT NULL,
                    language TEXT,
                    mtime_ns INTEGER,
                    size INTEGER,
                    content_hash TEXT,
                    last_scanned_at TEXT,
                    UNIQUE(repo_id, rel_path)
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_graph_files_repo ON graph_files(repo_id)")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS graph_nodes (
                    id TEXT PRIMARY KEY,
                    repo_id TEXT NOT NULL,
                    file_id TEXT,
                    kind TEXT NOT NULL,
                    name TEXT,
                    qualified_name TEXT,
                    parent_id TEXT,
                    start_line INTEGER,
                    end_line INTEGER,
                    method_count INTEGER,
                    loc INTEGER,
                    complexity_estimate INTEGER
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_graph_nodes_repo ON graph_nodes(repo_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_graph_nodes_file ON graph_nodes(file_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_graph_nodes_parent ON graph_nodes(parent_id)")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS graph_edges (
                    id TEXT PRIMARY KEY,
                    repo_id TEXT NOT NULL,
                    src_node_id TEXT NOT NULL,
                    dst_node_id TEXT,
                    edge_type TEXT NOT NULL,
                    dst_unresolved TEXT
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_graph_edges_src ON graph_edges(repo_id, src_node_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_graph_edges_dst ON graph_edges(repo_id, dst_node_id)")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS graph_findings (
                    id TEXT PRIMARY KEY,
                    repo_id TEXT NOT NULL,
                    node_id TEXT,
                    severity TEXT NOT NULL,
                    category TEXT NOT NULL,
                    message TEXT NOT NULL,
                    detector TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    resolved INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_graph_findings_repo ON graph_findings(repo_id)")
            self._migrate(conn)

    def _migrate(self, conn: sqlite3.Connection) -> None:
        """Idempotent column-addition pass for a pre-existing DB.

        Runs unconditionally on every startup. No columns to backfill yet, but
        the machinery is here (mirroring `TaskStore._migrate`) so future schema
        additions are a one-line `_EXPECTED_COLUMNS` entry, never an ALTER by
        hand.
        """
        expected: dict[str, list[tuple[str, str]]] = {
            "repos": [],
            "graph_files": [],
            # extraction_method records how a TS/JS symbol was recovered
            # (tree_sitter vs regex fallback) so the UI can flag lower-confidence
            # nodes; it is not part of the original Fase A schema, so it lands via
            # this migration path rather than a CREATE TABLE change.
            "graph_nodes": [("extraction_method", "TEXT")],
            "graph_edges": [],
            "graph_findings": [],
        }
        for table, columns in expected.items():
            existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
            for name, sql_type in columns:
                if name not in existing:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}")

    def add_repo(self, repo: RepoConfig) -> RepoConfig:
        """Register a repository, assigning a fresh id (task-ID style)."""
        repo_id = f"repo_{uuid4().hex[:12]}"
        stored = repo.model_copy(update={"id": repo_id})
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO repos (
                    id, name, root_path, language_hint, provider_override,
                    exclude_globs, created_at, last_scanned_at, last_scan_status,
                    last_scan_summary_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                """,
                (
                    stored.id,
                    stored.name,
                    stored.root_path,
                    stored.language_hint,
                    stored.provider_override,
                    json.dumps(stored.exclude_globs),
                    stored.created_at,
                    stored.last_scanned_at,
                    stored.last_scan_status,
                ),
            )
        return stored

    def list_repos(self) -> list[RepoConfig]:
        with self._connect() as conn:
            try:
                rows = conn.execute("SELECT * FROM repos ORDER BY created_at").fetchall()
            except sqlite3.DatabaseError:
                rows = []
        repos: list[RepoConfig] = []
        for row in rows:
            try:
                repos.append(self._row_to_repo(row))
            except Exception:
                continue
        return repos

    def get_repo(self, repo_id: str) -> RepoConfig | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM repos WHERE id = ?", (repo_id,)).fetchone()
        if row is None:
            return None
        return self._row_to_repo(row)

    def delete_repo(self, repo_id: str) -> bool:
        """Delete a repo and cascade-remove its files/nodes/edges/findings.

        All deletes run in a single transaction so a partial cascade can never
        leave orphaned graph rows behind.
        """
        with self._connect() as conn:
            cursor = conn.execute("SELECT id FROM repos WHERE id = ?", (repo_id,))
            if cursor.fetchone() is None:
                return False
            for table in ("graph_findings", "graph_edges", "graph_nodes", "graph_files"):
                conn.execute(f"DELETE FROM {table} WHERE repo_id = ?", (repo_id,))
            conn.execute("DELETE FROM repos WHERE id = ?", (repo_id,))
        return True

    def _row_to_repo(self, row: sqlite3.Row) -> RepoConfig:
        raw_globs = row["exclude_globs"]
        return RepoConfig(
            id=row["id"],
            name=row["name"],
            root_path=row["root_path"],
            language_hint=row["language_hint"],
            provider_override=row["provider_override"],
            exclude_globs=json.loads(raw_globs) if raw_globs else [],
            created_at=row["created_at"],
            last_scanned_at=row["last_scanned_at"],
            last_scan_status=row["last_scan_status"],
        )

    # --- Graph read/write (Fase B) -------------------------------------------

    _NODE_COLS = (
        "id, repo_id, file_id, kind, name, qualified_name, parent_id, "
        "start_line, end_line, method_count, loc, complexity_estimate, extraction_method"
    )
    _EDGE_COLS = "id, repo_id, src_node_id, dst_node_id, edge_type, dst_unresolved"

    def get_file_row(self, repo_id: str, rel_path: str) -> dict | None:
        """Return the cached graph_files row for (repo_id, rel_path), if any.

        Used by the scanner's incremental cache: comparing the stored
        `mtime_ns`/`size` against a fresh `os.stat` lets an unchanged file be
        skipped without ever being read or parsed.
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM graph_files WHERE repo_id = ? AND rel_path = ?",
                (repo_id, rel_path),
            ).fetchone()
        return dict(row) if row is not None else None

    def _insert_nodes(self, conn: sqlite3.Connection, nodes: list[GraphNode]) -> None:
        conn.executemany(
            f"INSERT INTO graph_nodes ({self._NODE_COLS}) VALUES "
            "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    n.id, n.repo_id, n.file_id, n.kind, n.name, n.qualified_name,
                    n.parent_id, n.start_line, n.end_line, n.method_count, n.loc,
                    n.complexity_estimate, n.extraction_method,
                )
                for n in nodes
            ],
        )

    def _insert_edges(self, conn: sqlite3.Connection, edges: list[GraphEdge]) -> None:
        conn.executemany(
            f"INSERT INTO graph_edges ({self._EDGE_COLS}) VALUES (?, ?, ?, ?, ?, ?)",
            [
                (e.id, e.repo_id, e.src_node_id, e.dst_node_id, e.edge_type, e.dst_unresolved)
                for e in edges
            ],
        )

    def replace_file_graph(
        self,
        repo_id: str,
        file_row: dict,
        nodes: list[GraphNode],
        edges: list[GraphEdge],
    ) -> None:
        """Atomically replace one file's graph rows (delete-then-reinsert).

        Removes the file's prior nodes (by `file_id`) and any edges originating
        from them, plus the old graph_files row, then inserts the fresh row,
        nodes and edges — all in a single transaction so a crash mid-scan can
        never leave a half-updated file. Edges pointing *into* this file from
        other files are left intact; node ids are deterministic, so they stay
        valid across rescans.
        """
        file_id = file_row["id"]
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM graph_edges WHERE repo_id = ? AND src_node_id IN "
                "(SELECT id FROM graph_nodes WHERE repo_id = ? AND file_id = ?)",
                (repo_id, repo_id, file_id),
            )
            conn.execute(
                "DELETE FROM graph_nodes WHERE repo_id = ? AND file_id = ?",
                (repo_id, file_id),
            )
            conn.execute("DELETE FROM graph_files WHERE id = ?", (file_id,))
            conn.execute(
                """
                INSERT INTO graph_files (
                    id, repo_id, rel_path, language, mtime_ns, size,
                    content_hash, last_scanned_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    file_row["id"], repo_id, file_row["rel_path"], file_row["language"],
                    file_row["mtime_ns"], file_row["size"], file_row["content_hash"],
                    file_row["last_scanned_at"],
                ),
            )
            self._insert_nodes(conn, nodes)
            self._insert_edges(conn, edges)

    def delete_file_graph(self, repo_id: str, rel_path: str) -> None:
        """Drop a file that no longer exists on disk (nodes, edges, file row)."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT id FROM graph_files WHERE repo_id = ? AND rel_path = ?",
                (repo_id, rel_path),
            ).fetchone()
            if row is None:
                return
            file_id = row["id"]
            conn.execute(
                "DELETE FROM graph_edges WHERE repo_id = ? AND src_node_id IN "
                "(SELECT id FROM graph_nodes WHERE repo_id = ? AND file_id = ?)",
                (repo_id, repo_id, file_id),
            )
            conn.execute("DELETE FROM graph_nodes WHERE repo_id = ? AND file_id = ?", (repo_id, file_id))
            conn.execute("DELETE FROM graph_files WHERE id = ?", (file_id,))

    def replace_structure(
        self,
        repo_id: str,
        nodes: list[GraphNode],
        edges: list[GraphEdge],
    ) -> None:
        """Rebuild the repo/dir scaffold layer (kind in {repo, dir}) wholesale.

        The directory tree is cheap to derive with no file IO, so it is rebuilt
        in full on every scan rather than incrementally. This deletes the prior
        repo/dir nodes and the structural `contains` edges that originate from
        them (repo->dir, dir->dir, dir->file), leaving file->symbol and import
        edges — which belong to individual files — untouched.
        """
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM graph_edges WHERE repo_id = ? AND src_node_id IN "
                "(SELECT id FROM graph_nodes WHERE repo_id = ? AND kind IN ('repo', 'dir'))",
                (repo_id, repo_id),
            )
            conn.execute(
                "DELETE FROM graph_nodes WHERE repo_id = ? AND kind IN ('repo', 'dir')",
                (repo_id,),
            )
            self._insert_nodes(conn, nodes)
            self._insert_edges(conn, edges)

    def list_file_rel_paths(self, repo_id: str) -> list[str]:
        """All rel_paths currently recorded for a repo (for stale-file pruning)."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT rel_path FROM graph_files WHERE repo_id = ?", (repo_id,)
            ).fetchall()
        return [row["rel_path"] for row in rows]

    def clear_repo_graph(self, repo_id: str) -> None:
        """Wipe all graph rows for a repo (files/nodes/edges), keeping the repo."""
        with self._connect() as conn:
            for table in ("graph_edges", "graph_nodes", "graph_files"):
                conn.execute(f"DELETE FROM {table} WHERE repo_id = ?", (repo_id,))

    def get_snapshot(self, repo_id: str) -> GraphSnapshot:
        """Return every node and edge for a repo (drives the frontend fetch)."""
        with self._connect() as conn:
            node_rows = conn.execute(
                f"SELECT {self._NODE_COLS} FROM graph_nodes WHERE repo_id = ?", (repo_id,)
            ).fetchall()
            edge_rows = conn.execute(
                f"SELECT {self._EDGE_COLS} FROM graph_edges WHERE repo_id = ?", (repo_id,)
            ).fetchall()
        nodes = [GraphNode(**dict(row)) for row in node_rows]
        edges = [GraphEdge(**dict(row)) for row in edge_rows]
        return GraphSnapshot(repo_id=repo_id, nodes=nodes, edges=edges)

    # --- Findings read/write (Fase D) -----------------------------------------

    _FINDING_COLS = (
        "id, repo_id, node_id, severity, category, message, detector, created_at, resolved"
    )

    def replace_findings(self, repo_id: str, findings: list["Finding"]) -> None:
        """Replace all findings for a repo (delete prior + insert) atomically.

        A fresh audit run supersedes the previous one wholesale, so old findings
        are dropped in the same transaction that inserts the new set — a reader
        never sees a mix of two audit runs.
        """
        with self._connect() as conn:
            conn.execute("DELETE FROM graph_findings WHERE repo_id = ?", (repo_id,))
            conn.executemany(
                f"INSERT INTO graph_findings ({self._FINDING_COLS}) VALUES "
                "(?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (
                        f.id, f.repo_id, f.node_id, f.severity, f.category,
                        f.message, f.detector, f.created_at, int(f.resolved),
                    )
                    for f in findings
                ],
            )

    def list_findings(self, repo_id: str) -> list["Finding"]:
        """Return every persisted finding for a repo (powers frontend badges)."""
        from app.models import Finding

        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT {self._FINDING_COLS} FROM graph_findings WHERE repo_id = ? "
                "ORDER BY created_at",
                (repo_id,),
            ).fetchall()
        return [Finding(**dict(row)) for row in rows]

    def update_scan_result(self, repo_id: str, status: str, summary_json: str) -> None:
        """Persist the outcome of a scan on the repo row (status + summary + ts)."""
        with self._connect() as conn:
            conn.execute(
                "UPDATE repos SET last_scanned_at = ?, last_scan_status = ?, "
                "last_scan_summary_json = ? WHERE id = ?",
                (_utcnow_iso(), status, summary_json, repo_id),
            )
