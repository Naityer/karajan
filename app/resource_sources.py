"""Pure URL role classification for Inspiration."""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit


@dataclass(frozen=True)
class SourceClassification:
    role: str
    canonical_url: str
    provider: str
    confidence: float
    evidence: tuple[str, ...]


_SOCIAL_PROFILE_RULES: tuple[tuple[str, re.Pattern[str], str], ...] = (
    ("threads.com", re.compile(r"^/@[^/]+/?$", re.I), "threads"),
    ("threads.net", re.compile(r"^/@[^/]+/?$", re.I), "threads"),
    ("x.com", re.compile(r"^/[^/]+/?$", re.I), "x"),
    ("twitter.com", re.compile(r"^/[^/]+/?$", re.I), "x"),
    ("mastodon.social", re.compile(r"^/@[^/]+/?$", re.I), "mastodon"),
)


def normalize_external_url(value: str) -> str:
    raw = str(value or "").strip()
    if not re.match(r"^https?://", raw, re.I):
        raw = f"https://{raw}"
    parsed = urlsplit(raw)
    host = (parsed.hostname or "").casefold()
    if parsed.scheme.casefold() != "https" or not host or parsed.username or parsed.password:
        raise ValueError("Introduce una URL HTTPS valida")
    port = f":{parsed.port}" if parsed.port and parsed.port != 443 else ""
    path = re.sub(r"/{2,}", "/", parsed.path or "/")
    path = path.rstrip("/") or "/"
    return urlunsplit(("https", host + port, path, parsed.query, ""))


def classify_external_url(value: str) -> SourceClassification:
    canonical = normalize_external_url(value)
    parsed = urlsplit(canonical)
    host = (parsed.hostname or "").removeprefix("www.").casefold()
    path = parsed.path or "/"
    for rule_host, pattern, provider in _SOCIAL_PROFILE_RULES:
        if host == rule_host and pattern.fullmatch(path):
            return SourceClassification(
                "discovery_source", canonical, provider, 1.0,
                ("social-profile-url", f"provider:{provider}"),
            )
    if host == "github.com" and len([part for part in path.split("/") if part]) >= 2:
        return SourceClassification("artifact", canonical, "github", 1.0, ("github-repository-url",))
    if host in {"itsfree.dev", "refactoring.guru", "toools.design"}:
        return SourceClassification("collection", canonical, host, 0.95, ("approved-resource-directory",))
    return SourceClassification("knowledge_resource", canonical, host, 0.65, ("https-reference",))


__all__ = ["SourceClassification", "classify_external_url", "normalize_external_url"]
