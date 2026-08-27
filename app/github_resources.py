from __future__ import annotations

import html
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import quote, urlsplit, urlunsplit

import httpx

from app.platform import http

from app.models import AnalyzeResult, ResourceCreateRequest, ResourceKind
from app.resource_intelligence import extract_resource_signals
from app.resource_library import ResourceStore, deterministic_summary


_OWNER_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$")
_REPO_RE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
_MAX_RESPONSE_BYTES = 2_000_000
_MAX_TREE_RESPONSE_BYTES = 32_000_000
_MAX_MANIFEST_FILES = 12
_MANIFEST_NAMES = {
    "package.json", "pyproject.toml", "requirements.txt", "cargo.toml", "go.mod",
    "plugin.json", "mcp.json", "dockerfile", "docker-compose.yml", "compose.yaml",
}


@dataclass(frozen=True)
class GitHubRepositoryURL:
    owner: str
    repository: str
    canonical_url: str


def validate_github_repository_url(value: str) -> GitHubRepositoryURL:
    """Validate and canonicalize a public HTTPS github.com repository URL."""
    parsed = urlsplit(value.strip())
    if parsed.scheme != "https" or parsed.hostname != "github.com":
        raise ValueError("Only https://github.com repository URLs are allowed")
    if parsed.username or parsed.password or parsed.port or parsed.query or parsed.fragment:
        raise ValueError("Credentials, ports, query strings and fragments are not allowed")
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) < 2 or len(parts) > 2:
        raise ValueError("URL must point to a GitHub repository root")
    owner, repository = parts
    if repository.endswith(".git"):
        repository = repository[:-4]
    if not _OWNER_RE.fullmatch(owner) or not _REPO_RE.fullmatch(repository) or repository in {".", ".."}:
        raise ValueError("Invalid GitHub owner or repository name")
    canonical = urlunsplit(("https", "github.com", f"/{owner}/{repository}", "", ""))
    return GitHubRepositoryURL(owner=owner, repository=repository, canonical_url=canonical)


class GitHubResourceAnalyzer:
    """Metadata-only GitHub analyzer; it never clones or executes repository code."""

    def __init__(
        self,
        client: httpx.Client | None = None,
        *,
        token: str | None = None,
        timeout_s: float = 10,
        summarizer: Callable[[str, str], str] | None = None,
    ) -> None:
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "karajan-resource-library/1",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self._client = client or http.build_client(headers=headers, timeout=timeout_s, follow_redirects=False)
        self._owns_client = client is None
        self._headers = headers
        self._summarizer = summarizer

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def analyze(self, repo_url: str) -> AnalyzeResult:
        try:
            parsed = validate_github_repository_url(repo_url)
        except ValueError as exc:
            return AnalyzeResult(valid=False, repo_url=repo_url, warnings=[str(exc)])

        try:
            metadata = self._get_json(f"https://api.github.com/repos/{quote(parsed.owner)}/{quote(parsed.repository)}")
            default_branch = str(metadata.get("default_branch") or "main")
            tree = self._get_json(
                f"https://api.github.com/repos/{quote(parsed.owner)}/{quote(parsed.repository)}/git/trees/"
                f"{quote(default_branch, safe='')}?recursive=1",
                max_bytes=_MAX_TREE_RESPONSE_BYTES,
            )
        except (httpx.HTTPError, ValueError) as exc:
            return AnalyzeResult(
                valid=False,
                repo_url=parsed.canonical_url,
                owner=parsed.owner,
                repository=parsed.repository,
                warnings=[f"GitHub metadata could not be read: {exc}"],
            )

        entries = tree.get("tree") if isinstance(tree, dict) else None
        repository_paths = sorted(
            entry["path"]
            for entry in (entries if isinstance(entries, list) else [])
            if isinstance(entry, dict) and entry.get("type") == "blob" and isinstance(entry.get("path"), str)
        )[:10_000]
        skill_paths = sorted(
            entry["path"]
            for entry in (entries if isinstance(entries, list) else [])
            if isinstance(entry, dict)
            and entry.get("type") == "blob"
            and isinstance(entry.get("path"), str)
            and entry["path"].split("/")[-1].casefold() == "skill.md"
        )[:200]
        warnings: list[str] = []
        if tree.get("truncated"):
            warnings.append("GitHub returned a truncated repository tree")
        if not skill_paths:
            warnings.append("No SKILL.md file was found; repository installation is disabled")
        description = str(metadata.get("description") or "")
        name = str(metadata.get("name") or parsed.repository)
        raw_stars = metadata.get("stargazers_count")
        github_stars = max(0, int(raw_stars)) if isinstance(raw_stars, (int, float)) and not isinstance(raw_stars, bool) else None
        readme = self._read_readme(parsed, default_branch, repository_paths)
        manifests = self._read_manifests(parsed, default_branch, repository_paths)
        intelligence = extract_resource_signals(metadata, repository_paths, readme, manifests)
        summary_method = "github_description"
        summary = deterministic_summary(
            name,
            _readme_summary(readme) or description,
            ["skill repository"] if skill_paths else ["reference"],
        )
        if readme and self._summarizer is not None:
            try:
                generated = " ".join(self._summarizer(name, readme[:24_000]).split()).strip()
                if generated:
                    summary = _clean_summary(generated)
                    summary_method = "llm"
            except Exception as exc:  # provider failures must not block cataloging
                warnings.append(f"LLM summary unavailable; README fallback used: {type(exc).__name__}")
                summary_method = "readme_fallback"
        elif readme:
            summary_method = "readme_fallback"
        preview = ResourceCreateRequest(
            slug=_slugify(name),
            name=name,
            kind=ResourceKind.SKILL if skill_paths else ResourceKind.REFERENCE,
            source="github",
            repo_url=parsed.canonical_url,
            summary=summary,
            tags=sorted({
                *(str(topic) for topic in metadata.get("topics", []) if isinstance(topic, str)),
                *intelligence.tags,
                *(("skill",) if skill_paths else ()),
            })[:80],
            capabilities=sorted({
                *(intelligence.capabilities or ("reference",)),
                *(("agent skill",) if skill_paths else ()),
            }),
            requirements=sorted({*intelligence.languages, *intelligence.frameworks}),
            compatible_runtimes=["claude", "codex"],
            install_strategy="github_skill" if skill_paths else "none",
            metadata={
                "default_branch": default_branch,
                "source_revision": str(tree.get("sha") or ""),
                "source_updated_at": metadata.get("updated_at"),
                "source_pushed_at": metadata.get("pushed_at"),
                "skill_paths": skill_paths,
                "license": (metadata.get("license") or {}).get("spdx_id") if isinstance(metadata.get("license"), dict) else None,
                "archived": bool(metadata.get("archived")),
                "fork": bool(metadata.get("fork")),
                "github_stars": github_stars,
                "detection_succeeded": True,
                "source_accessible": True,
                "html_url": parsed.canonical_url,
                "readme_url": f"{parsed.canonical_url}#readme",
                "readme_excerpt": readme[:4000],
                "summary_method": summary_method,
                "summarized_at": datetime.now(timezone.utc).isoformat(),
                "manifests_inspected": sorted(manifests),
                "intelligence": intelligence.to_dict(),
            },
        )
        return AnalyzeResult(
            valid=True,
            repo_url=parsed.canonical_url,
            owner=parsed.owner,
            repository=parsed.repository,
            default_branch=default_branch,
            summary=summary,
            skill_paths=skill_paths,
            metadata=preview.metadata,
            preview=preview,
            warnings=warnings,
        )

    def _read_readme(
        self,
        repository: GitHubRepositoryURL,
        branch: str,
        paths: list[str],
    ) -> str:
        candidates = [
            path for path in paths
            if path.count("/") == 0 and path.casefold().startswith("readme")
        ]
        if not candidates:
            return ""
        path = sorted(candidates, key=lambda value: (value.casefold() != "readme.md", value.casefold()))[0]
        try:
            return self._get_raw_text(repository, branch, path, max_bytes=_MAX_RESPONSE_BYTES)
        except (httpx.HTTPError, ValueError):
            return ""

    def _read_manifests(
        self,
        repository: GitHubRepositoryURL,
        branch: str,
        paths: list[str],
    ) -> dict[str, str]:
        selected = [
            path for path in paths
            if path.split("/")[-1].casefold() in _MANIFEST_NAMES
        ][:_MAX_MANIFEST_FILES]
        manifests: dict[str, str] = {}
        remaining = _MAX_RESPONSE_BYTES
        for path in selected:
            if remaining <= 0:
                break
            try:
                text = self._get_raw_text(repository, branch, path, max_bytes=min(256_000, remaining))
                manifests[path] = text
                remaining -= len(text.encode("utf-8"))
            except (httpx.HTTPError, ValueError):
                continue
        return manifests

    def _get_raw_text(
        self,
        repository: GitHubRepositoryURL,
        branch: str,
        path: str,
        *,
        max_bytes: int,
    ) -> str:
        url = (
            f"https://raw.githubusercontent.com/{quote(repository.owner)}/{quote(repository.repository)}/"
            f"{quote(branch, safe='')}/{quote(path, safe='/')}"
        )
        chunks: list[bytes] = []
        remaining = max_bytes
        with self._client.stream("GET", url, headers={"User-Agent": "karajan-resource-library/1"}) as response:
            response.raise_for_status()
            length = response.headers.get("content-length")
            if length and int(length) > max_bytes:
                raise ValueError("GitHub raw file exceeded the size limit")
            for chunk in response.iter_bytes():
                if len(chunk) > remaining:
                    raise ValueError("GitHub raw file exceeded the size limit")
                chunks.append(chunk)
                remaining -= len(chunk)
        return b"".join(chunks).decode("utf-8", errors="replace")

    @staticmethod
    def persist_preview(store: ResourceStore, result: AnalyzeResult):
        if not result.valid or result.preview is None:
            raise ValueError("Only a valid analysis preview can be persisted")
        try:
            return store.create(result.preview)
        except ValueError:
            existing = store.get_by_slug(result.preview.slug, result.preview.kind)
            return store.upsert(existing.model_copy(update=result.preview.model_dump(exclude={"slug", "kind"})))

    def _get_json(self, url: str, *, max_bytes: int = _MAX_RESPONSE_BYTES) -> dict[str, Any]:
        response = self._client.get(url, headers=self._headers)
        if response.status_code in {301, 302, 307, 308}:
            location = response.headers.get("location", "")
            redirected = urlsplit(location)
            if redirected.scheme != "https" or redirected.hostname != "api.github.com":
                raise ValueError("GitHub returned an unsafe redirect")
            response = self._client.get(location, headers=self._headers)
        if response.status_code == 403 and (
            response.headers.get("x-ratelimit-remaining") == "0"
            or "rate limit" in response.text.casefold()
        ):
            reset = response.headers.get("x-ratelimit-reset")
            reset_hint = ""
            if reset and reset.isdigit():
                reset_hint = f"; retry after {datetime.fromtimestamp(int(reset), timezone.utc).isoformat()}"
            raise ValueError(f"GitHub API rate limit exceeded{reset_hint}")
        response.raise_for_status()
        content_length = response.headers.get("content-length")
        if content_length and int(content_length) > max_bytes:
            raise ValueError("GitHub response exceeded the size limit")
        if len(response.content) > max_bytes:
            raise ValueError("GitHub response exceeded the size limit")
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError("GitHub returned an unexpected response")
        return payload


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9._-]+", "-", value.casefold()).strip("-.")[:120]
    return slug or "github-resource"


def _readme_summary(markdown: str) -> str:
    """Extract a readable, bounded fallback without executing repository code."""
    if not markdown:
        return ""
    text = re.sub(r"```.*?```", " ", markdown, flags=re.DOTALL)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"!\[[^]]*\]\([^)]*\)", " ", text)
    text = re.sub(r"\[([^]]+)\]\([^)]*\)", r"\1", text)
    lines = []
    for raw in text.splitlines():
        line = re.sub(r"^\s{0,3}(?:#{1,6}|[-*+]>?)\s*", "", raw).strip()
        if not line or line.startswith(("[!", "<img", "<a ")) or "badge" in line.casefold():
            continue
        lines.append(line)
        if len(" ".join(lines)) >= 1200:
            break
    compact = " ".join(" ".join(lines).split())
    sentences = re.split(r"(?<=[.!?])\s+", compact)
    return _clean_summary(" ".join(sentences[:5])[:1800].strip())


def _clean_summary(value: str) -> str:
    value = html.unescape(re.sub(r"<[^>]+>", " ", str(value or "")))
    value = re.sub(r"\s+", " ", value).strip()
    return value[:4000]
