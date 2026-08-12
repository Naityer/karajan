"""Bounded, explicit indexing of resources contained in web directories.

Recommendation code never imports this module and therefore never performs
network I/O.  Operators invoke an index operation first; its children then
behave like any other catalog resource.
"""

from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Iterable, Protocol
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

from app.models import ResourceItem, ResourceKind
from app.resource_intelligence import extract_resource_signals
from app.resource_library import ResourceStore, deterministic_summary


MAX_CHILDREN = 150
MAX_PAGE_BYTES = 256 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024
MAX_WORKERS = 4
_SPACE_RE = re.compile(r"\s+")
_SLUG_RE = re.compile(r"[^a-z0-9]+")


@dataclass(frozen=True)
class IndexResult:
    indexed: int
    inactive: int = 0
    warnings: tuple[str, ...] = ()


class DirectoryAdapter(Protocol):
    def supports(self, resource: ResourceItem) -> bool: ...
    def discover(self, resource: ResourceItem) -> Iterable[ResourceItem]: ...


class _PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.description = ""
        self.links: list[str] = []
        self.link_labels: list[tuple[str, str]] = []
        self._link_href: str | None = None
        self._link_text: list[str] = []
        self._title_open = False
        self._h1_open = False
        self._h1: list[str] = []
        self.text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "a" and values.get("href"):
            self.links.append(values["href"] or "")
            self._link_href = values["href"] or ""
            self._link_text = []
        elif tag == "meta" and values.get("name", "").casefold() in {"description", "og:description"}:
            self.description = values.get("content", "") or self.description
        self._title_open = tag == "title"
        self._h1_open = tag == "h1"

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._title_open = False
        elif tag == "h1":
            self._h1_open = False
        elif tag == "a" and self._link_href:
            self.link_labels.append((self._link_href, " ".join(self._link_text).strip()))
            self._link_href = None
            self._link_text = []

    def handle_data(self, data: str) -> None:
        clean = _SPACE_RE.sub(" ", data).strip()
        if not clean:
            return
        self.text.append(clean)
        if self._title_open:
            self.title = f"{self.title} {clean}".strip()
        if self._h1_open:
            self._h1.append(clean)
        if self._link_href:
            self._link_text.append(clean)

    @property
    def heading(self) -> str:
        return " ".join(self._h1).strip() or self.title.strip()


def _canonical_https(url: str, *, allowed_hosts: set[str]) -> str:
    parsed = urlsplit(url.strip())
    host = (parsed.hostname or "").casefold()
    if parsed.scheme.casefold() != "https" or host not in allowed_hosts or parsed.username or parsed.password:
        raise ValueError("nested index URL is not an allowed HTTPS source")
    port = f":{parsed.port}" if parsed.port and parsed.port != 443 else ""
    path = re.sub(r"/{2,}", "/", parsed.path or "/")
    if parsed.path.endswith("/") and path != "/":
        path = path.rstrip("/") + "/"
    else:
        path = path.rstrip("/") or "/"
    return urlunsplit(("https", host + port, path, parsed.query, ""))


def _with_directory_child_fallback(
    intelligence: dict,
    *,
    fallback_capability: str,
    fallback_tags: tuple[str, ...],
    source: str,
    url: str,
    method: str,
) -> dict:
    if intelligence.get("capabilities") or intelligence.get("tags") or intelligence.get("evidence"):
        return intelligence
    enriched = dict(intelligence)
    enriched["capabilities"] = [fallback_capability]
    enriched["tags"] = list(fallback_tags)
    enriched["evidence"] = [{
        "field": "capability",
        "value": fallback_capability,
        "source": source,
        "matched": fallback_capability,
        "url": url,
        "method": method,
    }]
    return enriched


class ItsFreeAdapter:
    """Indexer for itsfree category/directory pages and individual tool cards."""

    hosts = {"itsfree.dev", "www.itsfree.dev"}

    def __init__(self, client: httpx.Client | None = None) -> None:
        self.client = client or httpx.Client(timeout=8.0, follow_redirects=False)

    def supports(self, resource: ResourceItem) -> bool:
        candidate = resource.source_url or resource.repo_url or ""
        return (urlsplit(candidate).hostname or "").casefold() in self.hosts

    def _fetch(self, url: str) -> tuple[str, int]:
        canonical = _canonical_https(url, allowed_hosts=self.hosts)
        for _ in range(3):
            response = self.client.get(canonical, headers={"Accept": "text/html", "User-Agent": "Karajan-Indexer/1"})
            if response.status_code not in {301, 302, 303, 307, 308}:
                break
            location = response.headers.get("location")
            if not location:
                raise ValueError("redirect without a destination")
            canonical = _canonical_https(urljoin(canonical, location), allowed_hosts=self.hosts)
        else:
            raise ValueError("nested source exceeded the redirect limit")
        response.raise_for_status()
        if (urlsplit(str(response.url)).hostname or "").casefold() not in self.hosts:
            raise ValueError("redirect outside the allowed source")
        content = response.content
        if len(content) > MAX_PAGE_BYTES:
            raise ValueError("page exceeds the 256 KB inspection limit")
        return content.decode(response.encoding or "utf-8", errors="replace"), len(content)

    def discover(self, resource: ResourceItem) -> list[ResourceItem]:
        root = _canonical_https(resource.source_url or resource.repo_url or "", allowed_hosts=self.hosts)
        directory_html, total_bytes = self._fetch(root)
        parser = _PageParser()
        parser.feed(directory_html)
        urls: list[str] = []
        for href in parser.links:
            try:
                candidate = _canonical_https(urljoin(root, href), allowed_hosts=self.hosts)
            except ValueError:
                continue
            if re.search(r"/(?:es/)?tools/[^/?#]+$", urlsplit(candidate).path) and candidate not in urls:
                urls.append(candidate)
            if len(urls) >= MAX_CHILDREN:
                break

        pool = ThreadPoolExecutor(max_workers=MAX_WORKERS)
        futures = [pool.submit(self._fetch, url) for url in urls]
        completed, pending = wait(futures, timeout=60)
        if pending:
            for future in pending:
                future.cancel()
            pool.shutdown(wait=False, cancel_futures=True)
            raise ValueError("directory indexing exceeded the 60 second operation limit")
        try:
            pages = [future.result() for future in futures]
        finally:
            pool.shutdown(wait=True)
        if total_bytes + sum(size for _, size in pages) > MAX_TOTAL_BYTES:
            raise ValueError("directory exceeds the 32 MB inspection limit")

        now = datetime.now(timezone.utc)
        children: list[ResourceItem] = []
        for url, (html, _) in zip(urls, pages):
            page = _PageParser()
            page.feed(html)
            name = page.heading or urlsplit(url).path.rsplit("/", 1)[-1].replace("-", " ").title()
            body = " ".join(page.text)[:80_000]
            summary = deterministic_summary(name, page.description or body[:1000])
            intelligence = extract_resource_signals(
                {"name": name, "description": summary, "topics": []}, readme=body
            ).to_dict()
            # Evidence stays auditable down to the inspected page.
            intelligence["evidence"] = [
                {**entry, "url": url, "method": "itsfree-html"}
                for entry in intelligence.get("evidence", [])
            ]
            intelligence = _with_directory_child_fallback(
                intelligence,
                fallback_capability="developer-resource",
                fallback_tags=("developer-resource", "itsfree"),
                source=name or summary,
                url=url,
                method="itsfree-html",
            )
            child_slug = _SLUG_RE.sub("-", urlsplit(url).path.rsplit("/", 1)[-1].casefold()).strip("-")
            children.append(ResourceItem(
                slug=f"{resource.slug}--{child_slug}"[:120],
                name=name[:160],
                kind=ResourceKind.CAPABILITY,
                source="itsfree.dev",
                parent_resource_id=resource.id,
                source_url=url,
                summary=summary,
                tags=list(intelligence.get("tags", [])),
                capabilities=list(intelligence.get("capabilities", [])),
                install_strategy="none",
                indexed_at=now,
                metadata={
                    "homepage_url": url,
                    "intelligence": intelligence,
                    "provenance": {"parent_resource_id": resource.id, "canonical_url": url, "method": "itsfree-html"},
                    "agent_resource": {
                        "purpose": summary, "access_mode": "reference",
                        "when_to_use": list(intelligence.get("use_cases", [])),
                        "capabilities": list(intelligence.get("capabilities", [])),
                    },
                },
            ))
        return children


class GenericHtmlDirectoryAdapter:
    """Extension point for explicitly allowlisted same-origin HTML sources.

    Generic sources are intentionally disabled unless hosts and a link pattern
    are supplied by application configuration; arbitrary pages are never
    crawled merely because they were added to the catalog.
    """

    def __init__(self, allowed_hosts: Iterable[str], link_pattern: str, client: httpx.Client | None = None) -> None:
        self.allowed_hosts = {host.casefold() for host in allowed_hosts}
        self.link_pattern = re.compile(link_pattern)
        self.client = client or httpx.Client(timeout=8.0, follow_redirects=False)

    def supports(self, resource: ResourceItem) -> bool:
        url = resource.source_url or resource.repo_url or ""
        return (urlsplit(url).hostname or "").casefold() in self.allowed_hosts

    def discover(self, resource: ResourceItem) -> list[ResourceItem]:
        root = _canonical_https(resource.source_url or resource.repo_url or "", allowed_hosts=self.allowed_hosts)

        def fetch(url: str) -> str:
            canonical = _canonical_https(url, allowed_hosts=self.allowed_hosts)
            for _ in range(3):
                response = self.client.get(canonical, headers={"Accept": "text/html", "User-Agent": "Karajan-Indexer/1"})
                if response.status_code not in {301, 302, 303, 307, 308}:
                    break
                location = response.headers.get("location")
                if not location:
                    raise ValueError("redirect without a destination")
                canonical = _canonical_https(urljoin(canonical, location), allowed_hosts=self.allowed_hosts)
            else:
                raise ValueError("nested source exceeded the redirect limit")
            response.raise_for_status()
            if len(response.content) > MAX_PAGE_BYTES:
                raise ValueError("page exceeds the 256 KB inspection limit")
            return response.content.decode(response.encoding or "utf-8", errors="replace")

        directory = fetch(root)
        parser = _PageParser()
        parser.feed(directory)
        urls: list[str] = []
        for href in parser.links:
            try:
                candidate = _canonical_https(urljoin(root, href), allowed_hosts=self.allowed_hosts)
            except ValueError:
                continue
            if self.link_pattern.search(urlsplit(candidate).path) and candidate not in urls:
                urls.append(candidate)
            if len(urls) >= MAX_CHILDREN:
                break
        pool = ThreadPoolExecutor(max_workers=MAX_WORKERS)
        futures = [pool.submit(fetch, url) for url in urls]
        _, pending = wait(futures, timeout=60)
        if pending:
            for future in pending:
                future.cancel()
            pool.shutdown(wait=False, cancel_futures=True)
            raise ValueError("directory indexing exceeded the 60 second operation limit")
        try:
            pages = [future.result() for future in futures]
        finally:
            pool.shutdown(wait=True)
        if len(directory.encode("utf-8")) + sum(len(page.encode("utf-8")) for page in pages) > MAX_TOTAL_BYTES:
            raise ValueError("directory exceeds the 32 MB inspection limit")
        now = datetime.now(timezone.utc)
        children: list[ResourceItem] = []
        for position, (url, html) in enumerate(zip(urls, pages), start=1):
            page = _PageParser()
            page.feed(html)
            name = page.heading or f"Resource {position}"
            body = " ".join(page.text)[:80_000]
            summary = deterministic_summary(name, page.description or body[:1000])
            intelligence = extract_resource_signals({"name": name, "description": summary}, readme=body).to_dict()
            intelligence["evidence"] = [
                {**entry, "url": url, "method": "generic-html"}
                for entry in intelligence.get("evidence", [])
            ]
            slug = _SLUG_RE.sub("-", urlsplit(url).path.rsplit("/", 1)[-1].casefold()).strip("-")
            children.append(ResourceItem(
                slug=f"{resource.slug}--{slug or position}"[:120], name=name[:160],
                kind=ResourceKind.REFERENCE, source=(urlsplit(url).hostname or "html"),
                parent_resource_id=resource.id, source_url=url, summary=summary,
                tags=list(intelligence.get("tags", [])), capabilities=list(intelligence.get("capabilities", [])),
                indexed_at=now, metadata={
                    "homepage_url": url, "intelligence": intelligence,
                    "provenance": {"parent_resource_id": resource.id, "canonical_url": url, "method": "generic-html"},
                    "agent_resource": {
                        "purpose": summary, "access_mode": "reference",
                        "when_to_use": list(intelligence.get("use_cases", [])),
                        "capabilities": list(intelligence.get("capabilities", [])),
                    },
                },
            ))
        return children


class RefactoringGuruAdapter(GenericHtmlDirectoryAdapter):
    """Approved adapter for the structured design-pattern catalog."""

    def __init__(self, client: httpx.Client | None = None) -> None:
        super().__init__(
            {"refactoring.guru", "www.refactoring.guru"},
            r"^/design-patterns/(?!catalog/?$)[a-z0-9-]+/?$",
            client,
        )


class TooolsDesignAdapter:
    """Materialize the external tools listed by toools.design without fetching them."""

    hosts = {"toools.design", "www.toools.design"}

    def __init__(self, client: httpx.Client | None = None) -> None:
        self.client = client or httpx.Client(timeout=8.0, follow_redirects=False)

    def supports(self, resource: ResourceItem) -> bool:
        candidate = resource.source_url or resource.repo_url or ""
        return (urlsplit(candidate).hostname or "").casefold() in self.hosts

    def discover(self, resource: ResourceItem) -> list[ResourceItem]:
        root = _canonical_https(resource.source_url or resource.repo_url or "", allowed_hosts=self.hosts)
        response = self.client.get(root, headers={"Accept": "text/html", "User-Agent": "Karajan-Indexer/1"})
        response.raise_for_status()
        if len(response.content) > MAX_PAGE_BYTES:
            raise ValueError("page exceeds the 256 KB inspection limit")
        parser = _PageParser()
        parser.feed(response.content.decode(response.encoding or "utf-8", errors="replace"))
        now = datetime.now(timezone.utc)
        children: list[ResourceItem] = []
        seen: set[str] = set()
        for href, label in parser.link_labels:
            candidate = urljoin(root, href)
            parsed = urlsplit(candidate)
            if parsed.scheme != "https" or not parsed.hostname or parsed.hostname.casefold() in self.hosts:
                continue
            canonical = urlunsplit(("https", parsed.netloc.casefold(), parsed.path.rstrip("/") or "/", parsed.query, ""))
            if canonical in seen or not label or len(label) > 160:
                continue
            seen.add(canonical)
            summary = f"Herramienta de diseño referenciada por toools.design: {label}."
            intelligence = extract_resource_signals({"name": label, "description": summary}, readme=label).to_dict()
            intelligence = _with_directory_child_fallback(
                intelligence,
                fallback_capability="design-reference",
                fallback_tags=("design-resource", "toools-design"),
                source=label or summary,
                url=canonical,
                method="toools-directory",
            )
            slug = _SLUG_RE.sub("-", f"{parsed.hostname}-{label}".casefold()).strip("-")[:80]
            children.append(ResourceItem(
                slug=f"{resource.slug}--{slug}"[:120], name=label, kind=ResourceKind.REFERENCE,
                source="toools.design", parent_resource_id=resource.id, source_url=canonical,
                summary=summary, tags=list(intelligence.get("tags", [])),
                capabilities=list(intelligence.get("capabilities", [])), indexed_at=now,
                metadata={
                    "homepage_url": canonical, "intelligence": intelligence,
                    "provenance": {"parent_resource_id": resource.id, "canonical_url": canonical, "method": "toools-directory"},
                    "agent_resource": {
                        "purpose": summary, "access_mode": "reference",
                        "when_to_use": list(intelligence.get("use_cases", [])),
                        "capabilities": list(intelligence.get("capabilities", [])),
                    },
                },
            ))
            if len(children) >= MAX_CHILDREN:
                break
        return children


class NestedResourceIndexer:
    def __init__(self, store: ResourceStore, adapters: Iterable[DirectoryAdapter] | None = None) -> None:
        self.store = store
        self.adapters = list(adapters or [ItsFreeAdapter(), RefactoringGuruAdapter(), TooolsDesignAdapter()])

    def index(self, resource: ResourceItem) -> IndexResult:
        adapter = next((candidate for candidate in self.adapters if candidate.supports(resource)), None)
        if adapter is None:
            raise ValueError("no approved nested-resource adapter supports this source")
        children = list(adapter.discover(resource))
        indexed, inactive = self.store.replace_children(resource.id, children)
        parent_metadata = dict(resource.metadata)
        parent_metadata["nested_index"] = {
            "indexed": indexed, "inactive": inactive, "indexed_at": datetime.now(timezone.utc).isoformat()
        }
        self.store.upsert(resource.model_copy(update={"metadata": parent_metadata, "indexed_at": datetime.now(timezone.utc)}))
        return IndexResult(indexed=indexed, inactive=inactive)


__all__ = [
    "DirectoryAdapter", "GenericHtmlDirectoryAdapter", "IndexResult", "ItsFreeAdapter",
    "RefactoringGuruAdapter", "TooolsDesignAdapter", "NestedResourceIndexer",
]
