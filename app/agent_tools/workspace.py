"""Workspace confinement: every path a tool touches, checked against one root.

The `safe_resolve` contract here is the one already proven in
`audit_code/src/audit_code/model/store.py` (itself adapted from KARAJAN's own
`graph_store.py`, removed with Grafo): join relative paths onto the root, fully
resolve, refuse anything not contained. This module adds what a tool loop needs
on top of that:

- resolution of a path whose **target does not exist yet** (writes), by walking
  up to the deepest existing ancestor before comparing;
- a **re-check after opening for write** — a `run_command` in an earlier turn
  could have planted a symlink between the check and the write;
- an outright **read** deny-list for secret-shaped files. Denying the read, not
  just the write, is the strongest single control in the layer: it keeps
  credentials out of the model's context, and therefore out of `run_events`.

There is no OS sandbox. That is stated plainly in `docs/agent-tools.md` rather
than implied away — this module buys containment of *paths*, not of processes.
"""

from __future__ import annotations

import fnmatch
import hashlib
import os
from dataclasses import dataclass, field
from pathlib import Path

from app.agent_tools.spec import ToolDenied

# Never readable, never writable, not overridable by config. Matched against
# each path component and against the file name.
SECRET_PATTERNS: tuple[str, ...] = (
    ".env", ".env.*", "*.pem", "*.key", "*.pfx", "*.p12", "*.keystore",
    "id_rsa*", "id_ed25519*", "*.ppk",
    "credentials", "credentials.*", "secrets", "secrets.*", ".npmrc", ".pypirc",
)
SECRET_DIRS: tuple[str, ...] = (".ssh", ".aws", ".gnupg", ".azure", ".kube")

# Excluded from listing/search (noise and token cost), still readable by an
# explicit `read_file` — a lockfile is sometimes exactly what you need.
NOISE_DIRS: frozenset[str] = frozenset({
    ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", "dist", "build", ".next",
    ".turbo", ".idea", ".vscode", "site-packages", ".tox", "target",
})

# Writing inside `.git` corrupts the repo in ways an agent cannot reason about;
# git goes through `run_command` instead.
PROTECTED_DIRS: tuple[str, ...] = (".git",)

# If the workspace happens to be KARAJAN's own checkout, keep the agent out of
# the harness that is supervising it.
SELF_PROTECTED: tuple[str, ...] = ("app", "data", "dashboard/static")

MAX_READ_BYTES = 1_500_000
MAX_WRITE_BYTES = 512_000


def _is_secret_name(name: str) -> bool:
    lowered = name.lower()
    return any(fnmatch.fnmatch(lowered, pattern) for pattern in SECRET_PATTERNS)


@dataclass(frozen=True)
class Workspace:
    """A resolved, confined root. Build it with `Workspace.open()`."""

    root: Path
    dry_run: bool = False
    # True when `root` is KARAJAN's own repo, which enables `SELF_PROTECTED`.
    is_self: bool = False
    extra_deny: tuple[str, ...] = field(default=())

    @classmethod
    def open(cls, root: str | Path, *, dry_run: bool = False, allow_self: bool = False) -> Workspace:
        """Resolve and validate a workspace root.

        Refuses a filesystem root or the user's home directory outright: those
        are not workspaces, they are accidents, and a confinement boundary that
        wide protects nothing.
        """
        resolved = Path(root).expanduser()
        try:
            resolved = resolved.resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise ToolDenied(f"la raiz de trabajo no existe o no es accesible: {root}", "not_found") from exc
        if not resolved.is_dir():
            raise ToolDenied(f"la raiz de trabajo no es un directorio: {resolved}", "bad_params")
        if resolved.parent == resolved:
            raise ToolDenied("la raiz de un sistema de archivos no puede ser un workspace", "denied")
        if resolved == Path.home().resolve():
            raise ToolDenied("el directorio personal no puede ser un workspace", "denied")

        karajan_root = Path(__file__).resolve().parent.parent.parent
        is_self = resolved == karajan_root
        if is_self and not allow_self:
            raise ToolDenied(
                "el propio repositorio de KARAJAN no puede ser el workspace de un agente "
                "sin habilitarlo explicitamente",
                "denied",
            )
        return cls(root=resolved, dry_run=dry_run, is_self=is_self)

    # ── path resolution ─────────────────────────────────────────────────────
    def resolve(self, rel: str, *, for_write: bool = False) -> Path:
        """Resolve `rel` inside the workspace or raise `ToolDenied`."""
        if not rel or not rel.strip():
            raise ToolDenied("la ruta esta vacia", "bad_params")
        raw = rel.strip().replace("\\", "/")
        if "\0" in raw:
            raise ToolDenied("la ruta contiene un byte nulo", "bad_params")
        # Reject before touching the filesystem: absolute paths, drive letters
        # and UNC shares are not "outside the root", they ignore it entirely.
        if raw.startswith("/") or raw.startswith("//") or (len(raw) > 1 and raw[1] == ":"):
            raise ToolDenied(f"usa rutas relativas al workspace, no absolutas: {rel}", "outside_workspace")

        candidate = (self.root / raw)
        resolved = self._resolve_existing_ancestor(candidate)
        self._assert_contained(resolved, rel)
        self._assert_allowed(resolved, for_write=for_write)
        return (self.root / raw) if not candidate.exists() else resolved

    def _resolve_existing_ancestor(self, candidate: Path) -> Path:
        """Fully resolve the deepest part of `candidate` that exists.

        A write target usually does not exist yet, so `Path.resolve(strict=True)`
        is not an option; resolving the existing prefix is what still defeats a
        symlinked parent directory.
        """
        current = candidate
        suffix: list[str] = []
        while not current.exists():
            if current.parent == current:
                break
            suffix.append(current.name)
            current = current.parent
        resolved = current.resolve()
        for part in reversed(suffix):
            resolved = resolved / part
        return resolved

    def _assert_contained(self, resolved: Path, original: str) -> None:
        try:
            contained = os.path.commonpath([str(self.root), str(resolved)]) == str(self.root)
        except ValueError:  # different drives on Windows
            contained = False
        if not contained:
            raise ToolDenied(
                f"la ruta {original!r} se sale del workspace {self.root}", "outside_workspace"
            )

    def _assert_allowed(self, resolved: Path, *, for_write: bool) -> None:
        try:
            parts = resolved.relative_to(self.root).parts
        except ValueError:
            parts = resolved.parts

        for part in parts:
            if part.lower() in SECRET_DIRS:
                raise ToolDenied(f"'{part}' contiene credenciales; el acceso esta prohibido", "denied")
        if parts and _is_secret_name(parts[-1]):
            raise ToolDenied(
                f"'{parts[-1]}' tiene forma de archivo de credenciales; el acceso esta prohibido "
                "(tampoco en lectura, para que no entre en el contexto del modelo)",
                "denied",
            )
        if any(part in PROTECTED_DIRS for part in parts):
            raise ToolDenied("los internos de .git no se tocan directamente; usa run_command git", "denied")
        for pattern in self.extra_deny:
            if fnmatch.fnmatch("/".join(parts).lower(), pattern.lower()):
                raise ToolDenied(f"la ruta esta excluida por politica: {pattern}", "denied")

        # Reading KARAJAN's own source is required by the documentation
        # handoff.  Keep the harness immutable to agents, but do not confuse a
        # guarded context read with a write.
        if self.is_self and parts and for_write:
            prefix = "/".join(parts)
            if any(prefix == p or prefix.startswith(f"{p}/") for p in SELF_PROTECTED):
                raise ToolDenied(
                    "esa ruta pertenece al propio KARAJAN; un agente no modifica el arnes que lo supervisa",
                    "denied",
                )
        if for_write and resolved.is_dir():
            raise ToolDenied(f"'{resolved.name}' es un directorio, no un archivo", "bad_params")

    # ── helpers used by the executors ───────────────────────────────────────
    def relative(self, path: Path) -> str:
        """Workspace-relative POSIX path — the form stored in `artifacts`."""
        try:
            return path.resolve().relative_to(self.root).as_posix()
        except (ValueError, OSError):
            return path.as_posix()

    def confirm_after_write(self, path: Path) -> None:
        """Re-check containment once the file exists.

        Between `resolve()` and the write, an earlier `run_command` could have
        created a symlink at the target. This is the second half of that guard.
        """
        self._assert_contained(Path(os.path.realpath(path)), self.relative(path))

    def is_noise(self, path: Path) -> bool:
        try:
            parts = path.resolve().relative_to(self.root).parts
        except (ValueError, OSError):
            return False
        return any(part in NOISE_DIRS for part in parts)

    @staticmethod
    def digest(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()
