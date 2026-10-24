from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from uuid import uuid4

from app.github_resources import validate_github_repository_url
from app.models import (
    ResourceInstallation,
    ResourceItem,
    ResourceOperationRequest,
    ResourceOperationResult,
)
from app.resource_library import ResourceStore


_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")
_MAX_FILES_PER_SKILL = 2_000
_MAX_SKILL_BYTES = 50 * 1024 * 1024


class SkillRepositoryManager:
    """Transactional installer for repositories that contain SKILL.md files."""

    def __init__(
        self,
        store: ResourceStore,
        *,
        target_roots: dict[str, Path | str] | None = None,
        git_executable: str | None = None,
    ) -> None:
        self.store = store
        self.target_roots = {
            key: Path(value)
            for key, value in (target_roots or {
                "claude": Path.home() / ".claude" / "skills",
                "codex": Path.home() / ".agents" / "skills",
            }).items()
        }
        self.git_executable = git_executable or shutil.which("git")

    def operate(self, item: ResourceItem, request: ResourceOperationRequest) -> ResourceOperationResult:
        targets = request.targets or ["claude", "codex"]
        if request.action == "verify":
            return self.verify(item, targets=targets)
        if not request.confirmed:
            return self.store.record_operation(
                resource_id=item.id,
                action=request.action,
                status="denied",
                detail="Explicit confirmation is required for filesystem changes.",
                targets=targets,
            )
        if request.action == "install":
            return self.install_repository(item, targets=targets)
        if request.action == "update":
            return self.install_repository(item, targets=targets, replace_existing=True, operation_action="update")
        return self.uninstall(item, targets=targets)

    def install_repository(
        self,
        item: ResourceItem,
        *,
        targets: list[str],
        replace_existing: bool = False,
        operation_action: str = "install",
    ) -> ResourceOperationResult:
        if not item.repo_url:
            return self._failure(item, operation_action, targets, "Resource has no repository URL")
        try:
            repository = validate_github_repository_url(item.repo_url)
        except ValueError as exc:
            return self._failure(item, operation_action, targets, str(exc))
        if not self.git_executable:
            return self._failure(item, operation_action, targets, "git is not available")

        try:
            with tempfile.TemporaryDirectory(prefix="karajan-resource-") as temp:
                checkout = Path(temp) / "repo"
                completed = subprocess.run(
                    [
                        self.git_executable,
                        "-c", "core.hooksPath=NUL" if os.name == "nt" else "core.hooksPath=/dev/null",
                        "-c", "protocol.file.allow=never",
                        "-c", "submodule.recurse=false",
                        "clone", "--depth", "1", "--no-tags", "--filter=blob:none", "--",
                        repository.canonical_url, str(checkout),
                    ],
                    capture_output=True,
                    text=True,
                    timeout=120,
                    check=False,
                    shell=False,
                )
                if completed.returncode != 0:
                    detail = (completed.stderr or completed.stdout or "git clone failed").strip()
                    return self._failure(item, operation_action, targets, detail[:2000])
                return self.install_from_directory(
                    item,
                    checkout,
                    targets=targets,
                    replace_existing=replace_existing,
                    operation_action=operation_action,
                )
        except (OSError, subprocess.SubprocessError) as exc:
            return self._failure(item, operation_action, targets, str(exc))

    def install_from_directory(
        self,
        item: ResourceItem,
        source_root: Path | str,
        *,
        targets: list[str],
        replace_existing: bool = False,
        operation_action: str = "install",
    ) -> ResourceOperationResult:
        stages: list[Path] = []
        committed: list[Path] = []
        backups: list[tuple[Path, Path]] = []
        installations = [entry for entry in item.installations if entry.target not in targets]
        try:
            selected_targets = self._validate_targets(targets)
            skills = self._discover_skills(Path(source_root), fallback_name=item.slug)
            planned: list[tuple[str, Path, Path, str, str, Path | None]] = []
            for target in selected_targets:
                root = self.target_roots[target]
                root.mkdir(parents=True, exist_ok=True)
                for name, source in skills:
                    digest = _tree_digest(source)
                    destination = root / name
                    if destination.exists():
                        if not destination.is_dir():
                            raise FileExistsError(f"Refusing to overwrite existing skill: {destination}")
                        if _tree_digest(destination) == digest:
                            planned.append((target, source, destination, digest, "present", None))
                            continue
                        if not replace_existing:
                            raise FileExistsError(f"Refusing to overwrite existing skill: {destination}")
                    stage = root / f".karajan-stage-{uuid4().hex}"
                    _copy_safe_tree(source, stage)
                    if _tree_digest(stage) != digest:
                        raise OSError(f"Staging verification failed for {name}")
                    stages.append(stage)
                    planned.append((
                        target,
                        source,
                        destination,
                        digest,
                        "replace" if destination.exists() else "new",
                        stage,
                    ))

            for target, _source, destination, digest, mode, stage in planned:
                if mode != "present" and stage is not None:
                    if mode == "replace":
                        backup = destination.parent / f".karajan-backup-{uuid4().hex}"
                        destination.replace(backup)
                        backups.append((destination, backup))
                    stage.replace(destination)
                    if stage in stages:
                        stages.remove(stage)
                    committed.append(destination)
                installations.append(ResourceInstallation(
                    target=target, path=str(destination), digest=digest, verified=True,
                ))
            self.store.set_installations(item.id, installations, status="installed")
            result = self.store.record_operation(
                resource_id=item.id,
                action=operation_action,
                status="succeeded",
                detail=f"Installed and verified {len(skills)} skill(s) in {len(selected_targets)} target(s).",
                targets=selected_targets,
                metadata={"paths": [entry.path for entry in installations if entry.target in selected_targets]},
            )
            for _destination, backup in backups:
                shutil.rmtree(backup, ignore_errors=True)
            return result
        except Exception as exc:
            for path in reversed(committed):
                shutil.rmtree(path, ignore_errors=True)
            for destination, backup in reversed(backups):
                if backup.exists() and not destination.exists():
                    backup.replace(destination)
            for stage in stages:
                shutil.rmtree(stage, ignore_errors=True)
            try:
                self.store.set_installations(item.id, item.installations, status=item.status)
            except Exception:
                pass
            return self._failure(item, operation_action, targets, str(exc), rolled_back=bool(committed or backups))

    def verify(self, item: ResourceItem, *, targets: list[str]) -> ResourceOperationResult:
        try:
            selected = set(self._validate_targets(targets))
            entries = [entry for entry in item.installations if entry.target in selected]
            failures: list[str] = []
            for entry in entries:
                path = self._managed_path(entry.target, entry.path)
                if not path.is_dir() or not (path / "SKILL.md").is_file():
                    failures.append(f"missing:{entry.target}/{path.name}")
                elif _tree_digest(path) != entry.digest:
                    failures.append(f"changed:{entry.target}/{path.name}")
            if not entries:
                failures.append("no managed installations")
            status = "failed" if failures else "succeeded"
            detail = "; ".join(failures) if failures else f"Verified {len(entries)} installation(s)."
            return self.store.record_operation(
                resource_id=item.id, action="verify", status=status, detail=detail, targets=sorted(selected),
            )
        except Exception as exc:
            return self._failure(item, "verify", targets, str(exc))

    def uninstall(self, item: ResourceItem, *, targets: list[str]) -> ResourceOperationResult:
        backups: list[tuple[Path, Path]] = []
        try:
            selected = set(self._validate_targets(targets))
            removing = [entry for entry in item.installations if entry.target in selected]
            for entry in removing:
                path = self._managed_path(entry.target, entry.path)
                if not path.exists():
                    continue
                if not path.is_dir() or _tree_digest(path) != entry.digest:
                    raise ValueError(
                        f"Refusing to remove a modified managed skill: {entry.target}/{path.name}"
                    )
                backup = path.parent / f".karajan-remove-{uuid4().hex}"
                path.replace(backup)
                backups.append((path, backup))
            remaining = [entry for entry in item.installations if entry.target not in selected]
            self.store.set_installations(item.id, remaining, status="partial" if remaining else "available")
            result = self.store.record_operation(
                resource_id=item.id,
                action="uninstall",
                status="succeeded",
                detail=f"Removed {len(removing)} managed installation(s).",
                targets=sorted(selected),
            )
            for _path, backup in backups:
                shutil.rmtree(backup, ignore_errors=True)
            return result
        except Exception as exc:
            for path, backup in reversed(backups):
                if backup.exists() and not path.exists():
                    backup.replace(path)
            try:
                self.store.set_installations(item.id, item.installations, status=item.status)
            except Exception:
                pass
            return self._failure(item, "uninstall", targets, str(exc), rolled_back=bool(backups))

    def _discover_skills(self, root: Path, *, fallback_name: str) -> list[tuple[str, Path]]:
        if not root.is_dir():
            raise ValueError("Repository checkout is missing")
        manifests = sorted(
            (path for path in root.rglob("SKILL.md") if ".git" not in path.parts),
            key=lambda path: str(path).casefold(),
        )
        if not manifests:
            raise ValueError("Repository contains no SKILL.md")
        if len(manifests) > 200:
            raise ValueError("Repository contains too many skills")
        result: list[tuple[str, Path]] = []
        names: set[str] = set()
        for manifest in manifests:
            source = manifest.parent
            if source == root:
                name = fallback_name
            else:
                name = source.name
            if not _SAFE_NAME.fullmatch(name):
                raise ValueError(f"Unsafe skill directory name: {name}")
            folded = name.casefold()
            if folded in names:
                raise ValueError(f"Duplicate skill directory name: {name}")
            _validate_tree(source)
            names.add(folded)
            result.append((name, source))
        return result

    def _validate_targets(self, targets: list[str]) -> list[str]:
        selected = sorted(set(targets))
        if not selected:
            raise ValueError("At least one target is required")
        unknown = [target for target in selected if target not in self.target_roots]
        if unknown:
            raise ValueError(f"Unknown target(s): {', '.join(unknown)}")
        return selected

    def _managed_path(self, target: str, raw_path: str) -> Path:
        root = self.target_roots[target].resolve()
        path = Path(raw_path).resolve()
        if path.parent != root or not _SAFE_NAME.fullmatch(path.name):
            raise ValueError(f"Installation path is outside the managed target: {raw_path}")
        return path

    def _failure(
        self,
        item: ResourceItem,
        action: str,
        targets: list[str],
        detail: str,
        *,
        rolled_back: bool = False,
    ) -> ResourceOperationResult:
        return self.store.record_operation(
            resource_id=item.id,
            action=action,
            status="failed",
            detail=detail,
            targets=targets,
            metadata={"rolled_back": rolled_back},
        )


def _validate_tree(root: Path) -> None:
    files = 0
    size = 0
    for path in root.rglob("*"):
        if ".git" in path.relative_to(root).parts:
            continue
        if path.is_symlink():
            raise ValueError(f"Symbolic links are not allowed: {path.name}")
        if path.is_file():
            files += 1
            size += path.stat().st_size
            if files > _MAX_FILES_PER_SKILL or size > _MAX_SKILL_BYTES:
                raise ValueError("Skill exceeds installation size limits")


def _copy_safe_tree(source: Path, destination: Path) -> None:
    _validate_tree(source)
    shutil.copytree(
        source,
        destination,
        symlinks=False,
        ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc"),
    )


def _tree_digest(root: Path) -> str:
    _validate_tree(root)
    digest = hashlib.sha256()
    for path in sorted((item for item in root.rglob("*") if item.is_file()), key=lambda item: item.as_posix()):
        relative = path.relative_to(root).as_posix()
        if relative.startswith(".git/") or "/.git/" in relative or relative.endswith(".pyc"):
            continue
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()
