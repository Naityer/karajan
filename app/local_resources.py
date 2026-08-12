"""Safe metadata extraction for catalog entries backed by local files."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from app.models import AnalyzeResult, ResourceCreateRequest, ResourceItem
from app.resource_intelligence import extract_resource_signals
from app.resource_library import deterministic_summary


_MAX_FILE_BYTES = 256_000
_MAX_TOTAL_BYTES = 1_000_000


def _frontmatter_description(text: str) -> str:
    if text.startswith("---"):
        match = re.search(r"(?im)^description:\s*[|>-]?\s*(.+)$", text[:12_000])
        if match:
            return " ".join(match.group(1).strip(" \"'").split())
    paragraphs = [re.sub(r"^#+\s*", "", value).strip() for value in re.split(r"\n\s*\n", text)]
    return next((value for value in paragraphs if value and not value.startswith(("---", "#"))), "")


class LocalResourceAnalyzer:
    """Enrich local skills/installers without executing their contents."""

    def __init__(self, project_root: Path | None = None, extra_roots: tuple[Path, ...] = ()) -> None:
        self.project_root = (project_root or Path(__file__).resolve().parent.parent).resolve()
        self.roots = (
            self.project_root / "skills",
            Path.home() / ".agents" / "skills",
            Path.home() / ".claude" / "skills",
            *extra_roots,
        )

    def analyze(self, item: ResourceItem) -> AnalyzeResult:
        paths = self._candidate_files(item)
        contents: dict[str, str] = {}
        remaining = _MAX_TOTAL_BYTES
        for path in paths:
            try:
                raw = path.read_bytes()
            except OSError:
                continue
            if len(raw) > min(_MAX_FILE_BYTES, remaining):
                continue
            contents[str(path)] = raw.decode("utf-8", errors="replace")
            remaining -= len(raw)
            if remaining <= 0:
                break

        combined = "\n\n".join(contents.values())
        intelligence = extract_resource_signals(
            {"name": item.name, "description": item.summary},
            [Path(path).name for path in contents],
            combined,
            contents,
        )
        description = next((_frontmatter_description(text) for text in contents.values() if text.strip()), "")
        summary = deterministic_summary(item.name, description or item.summary, intelligence.capabilities)
        digest_payload = "\n".join(f"{path}\0{contents[path]}" for path in sorted(contents))
        digest = hashlib.sha256(digest_payload.encode("utf-8")).hexdigest() if digest_payload else hashlib.sha256(
            f"{item.source}\0{item.name}\0{item.summary}".encode("utf-8")
        ).hexdigest()
        metadata = {
            "source_revision": digest,
            "source_analysis_method": "local-files" if contents else "catalog-fallback",
            "source_files": sorted(contents),
            "intelligence": intelligence.to_dict(),
        }
        preview = ResourceCreateRequest(
            slug=item.slug,
            name=item.name,
            kind=item.kind,
            source=item.source,
            repo_url=item.repo_url,
            source_url=item.source_url,
            summary=summary,
            tags=sorted({*item.tags, *intelligence.tags}, key=str.casefold),
            requirements=sorted({*item.requirements, *intelligence.languages, *intelligence.frameworks}, key=str.casefold),
            capabilities=sorted({*item.capabilities, *intelligence.capabilities}, key=str.casefold),
            compatible_runtimes=item.compatible_runtimes,
            install_strategy=item.install_strategy,
            metadata=metadata,
        )
        warnings = [] if contents else ["No local source file was found; catalog metadata was normalized"]
        return AnalyzeResult(valid=True, repo_url=item.repo_url or item.source_url or "", preview=preview, metadata=metadata, warnings=warnings)

    def _candidate_files(self, item: ResourceItem) -> list[Path]:
        candidates: list[Path] = []
        for key in ("path", "script_path", "launcher_path"):
            value = (item.metadata or {}).get(key)
            if value:
                candidate = Path(str(value))
                if candidate.is_file():
                    candidates.append(candidate.resolve())
                elif candidate.is_dir():
                    candidates.extend(self._directory_docs(candidate))
        names = {item.slug, item.name.casefold().replace(" ", "-")}
        for root in self.roots:
            for name in names:
                directory = root / name
                if directory.is_dir():
                    candidates.extend(self._directory_docs(directory))
        unique: dict[str, Path] = {}
        for candidate in candidates:
            unique[str(candidate).casefold()] = candidate
        return list(unique.values())[:20]

    @staticmethod
    def _directory_docs(directory: Path) -> list[Path]:
        selected: list[Path] = []
        for name in ("SKILL.md", "README.md", "README.es.md", "pyproject.toml", "package.json"):
            path = directory / name
            if path.is_file():
                selected.append(path.resolve())
        return selected


__all__ = ["LocalResourceAnalyzer"]
