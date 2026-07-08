"""Deterministic code-audit engine (Fase D) — the core value of the Grafo window.

Reads the nodes/edges already computed and persisted in Fase B (via
`GraphStore.get_snapshot`) rather than re-parsing source, and only touches file
bytes for the two detectors that genuinely need them (secret scan, TODO
density). Every detector is pure Python and runs with ZERO providers configured;
an optional LLM narrative (`include_llm=True`) is layered on top and degrades
gracefully — a provider failure never invalidates the deterministic findings.

Severity vocabulary: info < warning < critical. Detectors attach each finding to
the graph `node_id` it concerns (a file node for file-level checks, a symbol
node otherwise) so the frontend can badge the right node.
"""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from pathlib import Path

from app.graph_store import GraphStore, safe_resolve
from app.models import (
    AuditResult,
    Finding,
    GraphEdge,
    GraphNode,
    KarajanConfig,
    RecommendedModel,
)

logger = logging.getLogger("karajan.audit")

# --- Thresholds (single source of truth) -------------------------------------
_GOD_CLASS_METHODS = 15
_LARGE_FILE_LOC = 600
_LARGE_FILE_SYMBOLS = 25
_LONG_FN_WARN = 80
_LONG_FN_CRIT = 150
# McCabe-approx warning raised from 10 → 13: >10 fired on ~60 of 75 findings in a
# real FastAPI codebase (many branching route handlers), drowning the god-class /
# circular-import / security signals. 13 keeps genuine hotspots as warnings while
# critical (>20) stays a tight, high-signal set.
_COMPLEXITY_WARN = 13
_COMPLEXITY_CRIT = 20
_TODO_DENSITY = 8

_SEVERITY_ORDER = {"info": 1, "warning": 2, "critical": 3}
_MAX_SECRET_SCAN_BYTES = 1_500_000

# --- Secret-scan regexes -----------------------------------------------------
_AWS_KEY_RE = re.compile(r"\bAKIA[0-9A-Z]{16}\b")
# `name = "value"` / `name: 'value'` where name looks like a credential.
_SECRET_ASSIGN_RE = re.compile(
    r"""(?ix)
    \b(password|passwd|secret|api[_-]?key|apikey|token|private[_-]?key)\b
    \s* [:=] \s*
    (["'])(?P<val>.+?)\2
    """
)
_TODO_RE = re.compile(r"\b(TODO|FIXME|XXX|HACK)\b")
_ONLY_X_RE = re.compile(r"^x+$", re.IGNORECASE)
_ENV_NAME_RE = re.compile(r"^[A-Z0-9_]+$")


def _mk(
    repo_id: str,
    node_id: str | None,
    severity: str,
    category: str,
    detector: str,
    message: str,
) -> Finding:
    return Finding(
        repo_id=repo_id,
        node_id=node_id,
        severity=severity,
        category=category,
        detector=detector,
        message=message,
    )


# --- Deterministic detectors -------------------------------------------------
# Each takes the node list (and edges / repo where needed) and returns findings.


def detect_god_class(repo_id: str, nodes: list[GraphNode]) -> list[Finding]:
    out: list[Finding] = []
    for n in nodes:
        if n.kind == "class" and (n.method_count or 0) > _GOD_CLASS_METHODS:
            out.append(
                _mk(
                    repo_id, n.id, "warning", "srp", "god_class",
                    f"La clase '{n.name}' tiene {n.method_count} métodos "
                    f"(> {_GOD_CLASS_METHODS}): posible violación de responsabilidad única.",
                )
            )
    return out


def detect_large_file(repo_id: str, nodes: list[GraphNode]) -> list[Finding]:
    out: list[Finding] = []
    top_symbols: dict[str, int] = defaultdict(int)
    for n in nodes:
        if n.kind in ("class", "function") and n.parent_id:
            top_symbols[n.parent_id] += 1
    for n in nodes:
        if n.kind != "file":
            continue
        loc = n.loc or n.end_line or 0
        symbols = top_symbols.get(n.id, 0)
        if loc > _LARGE_FILE_LOC or symbols > _LARGE_FILE_SYMBOLS:
            out.append(
                _mk(
                    repo_id, n.id, "warning", "size", "large_file",
                    f"Fichero grande '{n.qualified_name or n.name}': {loc} líneas, "
                    f"{symbols} símbolos de nivel superior. Considera dividirlo.",
                )
            )
    return out


def detect_long_function(repo_id: str, nodes: list[GraphNode]) -> list[Finding]:
    out: list[Finding] = []
    for n in nodes:
        if n.kind not in ("function", "method"):
            continue
        loc = n.loc or 0
        if loc > _LONG_FN_CRIT:
            sev = "critical"
        elif loc > _LONG_FN_WARN:
            sev = "warning"
        else:
            continue
        out.append(
            _mk(
                repo_id, n.id, sev, "size", "long_function",
                f"La función '{n.qualified_name or n.name}' tiene {loc} líneas "
                f"(> {_LONG_FN_WARN if sev == 'warning' else _LONG_FN_CRIT}).",
            )
        )
    return out


def detect_high_complexity(repo_id: str, nodes: list[GraphNode]) -> list[Finding]:
    out: list[Finding] = []
    for n in nodes:
        if n.kind not in ("function", "method"):
            continue
        cx = n.complexity_estimate or 0
        if cx > _COMPLEXITY_CRIT:
            sev = "critical"
        elif cx > _COMPLEXITY_WARN:
            sev = "warning"
        else:
            continue
        out.append(
            _mk(
                repo_id, n.id, sev, "complexity", "high_complexity",
                f"'{n.qualified_name or n.name}' tiene complejidad ~{cx} "
                f"(McCabe aprox., > {_COMPLEXITY_WARN if sev == 'warning' else _COMPLEXITY_CRIT}).",
            )
        )
    return out


def detect_circular_imports(
    repo_id: str, nodes: list[GraphNode], edges: list[GraphEdge]
) -> list[Finding]:
    """Flag file-level import cycles via Tarjan strongly-connected components.

    Only `imports` edges resolved to an internal node (`dst_node_id` set) count;
    external packages have no `dst_node_id` and cannot form a cycle. Every file
    node inside a non-trivial SCC gets a warning naming the cycle members.
    """
    file_ids = {n.id for n in nodes if n.kind == "file"}
    name_by_id = {n.id: (n.qualified_name or n.name or n.id) for n in nodes}
    adj: dict[str, list[str]] = defaultdict(list)
    for e in edges:
        if (
            e.edge_type == "imports"
            and e.dst_node_id
            and e.src_node_id in file_ids
            and e.dst_node_id in file_ids
        ):
            adj[e.src_node_id].append(e.dst_node_id)

    sccs = _tarjan_scc(list(file_ids), adj)
    out: list[Finding] = []
    for comp in sccs:
        if len(comp) < 2:
            continue
        names = sorted(name_by_id.get(nid, nid) for nid in comp)
        cycle = " ↔ ".join(names)
        for nid in comp:
            out.append(
                _mk(
                    repo_id, nid, "warning", "architecture", "circular_imports",
                    f"Import circular entre {len(comp)} ficheros: {cycle}.",
                )
            )
    return out


def _tarjan_scc(vertices: list[str], adj: dict[str, list[str]]) -> list[list[str]]:
    """Iterative Tarjan SCC (iterative to avoid recursion limits on big repos)."""
    index_counter = [0]
    index: dict[str, int] = {}
    lowlink: dict[str, int] = {}
    on_stack: set[str] = set()
    stack: list[str] = []
    result: list[list[str]] = []

    for root in vertices:
        if root in index:
            continue
        work = [(root, 0)]
        while work:
            v, pi = work[-1]
            if pi == 0:
                index[v] = lowlink[v] = index_counter[0]
                index_counter[0] += 1
                stack.append(v)
                on_stack.add(v)
            recursed = False
            neighbors = adj.get(v, [])
            for i in range(pi, len(neighbors)):
                w = neighbors[i]
                if w not in index:
                    work[-1] = (v, i + 1)
                    work.append((w, 0))
                    recursed = True
                    break
                if w in on_stack:
                    lowlink[v] = min(lowlink[v], index[w])
            if recursed:
                continue
            if lowlink[v] == index[v]:
                comp: list[str] = []
                while True:
                    w = stack.pop()
                    on_stack.discard(w)
                    comp.append(w)
                    if w == v:
                        break
                result.append(comp)
            work.pop()
            if work:
                parent = work[-1][0]
                lowlink[parent] = min(lowlink[parent], lowlink[v])
    return result


def _is_placeholder_secret(value: str) -> bool:
    """True when a matched string is an obvious non-secret (env ref, placeholder)."""
    v = value.strip()
    if len(v) < 12:
        return True
    low = v.lower()
    if _ONLY_X_RE.match(v):
        return True
    if v.startswith("<") and v.endswith(">"):
        return True
    if "${" in v or "os.environ" in v or "process.env" in v or "getenv" in low:
        return True
    if _ENV_NAME_RE.match(v):  # an ALL_CAPS env-var NAME, not a value
        return True
    for token in ("changeme", "your-", "your_", "yourtoken", "placeholder",
                  "example", "xxxxx", "dummy", "redacted", "todo", "none", "null"):
        if token in low:
            return True
    return False


def scan_secrets_in_text(text: str) -> list[tuple[int, str, str]]:
    """Return (line_no, severity, message) for likely secrets in `text`.

    Never includes the raw secret value — AWS keys are redacted to `AKIA****…`
    and generic assignments report only the variable name + line. Precision over
    recall: obvious placeholders and env-var references are excluded.
    """
    findings: list[tuple[int, str, str]] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        flagged_line = False
        for m in _AWS_KEY_RE.finditer(line):
            redacted = m.group(0)[:4] + "****…"
            findings.append(
                (lineno, "critical",
                 f"Posible AWS Access Key ({redacted}) embebida en la línea {lineno}.")
            )
            flagged_line = True
        if flagged_line:
            continue  # avoid double-flagging the same line via the generic rule
        m = _SECRET_ASSIGN_RE.search(line)
        if m and not _is_placeholder_secret(m.group("val")):
            key_name = m.group(1)
            findings.append(
                (lineno, "critical",
                 f"Posible secreto embebido: '{key_name}' asignado a un literal "
                 f"en la línea {lineno} (valor redactado).")
            )
    return findings


def detect_file_text_issues(
    repo_id: str, nodes: list[GraphNode], root: Path | None
) -> list[Finding]:
    """Secret scan + TODO density — the only detectors that read file bytes."""
    out: list[Finding] = []
    if root is None:
        return out
    for n in nodes:
        if n.kind != "file" or not n.qualified_name:
            continue
        try:
            abs_path = safe_resolve(root, n.qualified_name)
            if not abs_path.is_file() or abs_path.stat().st_size > _MAX_SECRET_SCAN_BYTES:
                continue
            text = abs_path.read_text(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            continue
        for lineno, sev, msg in scan_secrets_in_text(text):
            out.append(_mk(repo_id, n.id, sev, "security", "hardcoded_secret", msg))
        todo_count = len(_TODO_RE.findall(text))
        if todo_count > _TODO_DENSITY:
            out.append(
                _mk(
                    repo_id, n.id, "info", "maintainability", "todo_density",
                    f"'{n.qualified_name}' contiene {todo_count} marcadores "
                    f"TODO/FIXME/XXX/HACK (> {_TODO_DENSITY}).",
                )
            )
    return out


# --- Orchestration -----------------------------------------------------------


def run_audit(
    repo_id: str,
    store: GraphStore,
    *,
    include_llm: bool = False,
    config: KarajanConfig | None = None,
) -> AuditResult:
    """Run every deterministic detector, persist findings, and optionally add an
    LLM narrative. Never raises on an empty/unscanned repo or an LLM failure."""
    snapshot = store.get_snapshot(repo_id)
    nodes, edges = snapshot.nodes, snapshot.edges

    if not nodes:
        store.replace_findings(repo_id, [])
        return AuditResult(
            repo_id=repo_id,
            findings=[],
            counts_by_severity={"info": 0, "warning": 0, "critical": 0},
            llm_summary="El repositorio no tiene grafo aún; ejecuta un escaneo antes de auditar.",
        )

    repo = store.get_repo(repo_id)
    root = Path(repo.root_path) if repo else None

    findings: list[Finding] = []
    findings += detect_god_class(repo_id, nodes)
    findings += detect_large_file(repo_id, nodes)
    findings += detect_long_function(repo_id, nodes)
    findings += detect_high_complexity(repo_id, nodes)
    findings += detect_circular_imports(repo_id, nodes, edges)
    findings += detect_file_text_issues(repo_id, nodes, root)

    store.replace_findings(repo_id, findings)

    counts = {"info": 0, "warning": 0, "critical": 0}
    for f in findings:
        counts[f.severity] = counts.get(f.severity, 0) + 1

    result = AuditResult(
        repo_id=repo_id,
        findings=findings,
        counts_by_severity=counts,
    )

    if include_llm:
        summary, truncated = _llm_narrative(repo_id, findings, nodes, repo, config)
        result.llm_summary = summary
        result.truncated = truncated

    return result


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
