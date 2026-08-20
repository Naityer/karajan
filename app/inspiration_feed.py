from __future__ import annotations

import html
import hashlib
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse
from xml.etree import ElementTree

import httpx

from app.platform import http


_TAG_RE = re.compile(r"<[^>]+>")
_MAX_RESPONSE_BYTES = 1_000_000


SOURCES: dict[str, dict[str, Any]] = {
    "github": {
        "id": "github",
        "name": "GitHub",
        "description": "Repositorios de agentes y herramientas actualizados recientemente.",
        "homepage": "https://github.com/topics/ai-agents",
        "available": True,
        "requires_credentials": False,
    },
    "hacker-news": {
        "id": "hacker-news",
        "name": "Hacker News",
        "description": "Historias recientes sobre IA, agentes y herramientas para desarrolladores.",
        "homepage": "https://news.ycombinator.com/",
        "available": True,
        "requires_credentials": False,
    },
    "devto": {
        "id": "devto",
        "name": "DEV Community",
        "description": "Artículos prácticos publicados por la comunidad de desarrollo.",
        "homepage": "https://dev.to/t/ai",
        "available": True,
        "requires_credentials": False,
    },
    "hugging-face": {
        "id": "hugging-face",
        "name": "Hugging Face",
        "description": "Novedades de modelos, datasets y herramientas open source.",
        "homepage": "https://huggingface.co/blog",
        "available": True,
        "requires_credentials": False,
    },
    "threads": {
        "id": "threads",
        "name": "Threads",
        "description": "Publicaciones de cuentas elegidas. Requiere conectar la API de Meta.",
        "homepage": "https://www.threads.net/",
        "available": False,
        "requires_credentials": True,
        "setup_hint": "Configura una integración de Meta Threads con permisos de lectura.",
    },
}

DEFAULT_SOURCE_IDS = ("github", "hacker-news", "devto", "hugging-face")


def source_catalog(selected: list[str] | tuple[str, ...]) -> list[dict[str, Any]]:
    chosen = set(selected)
    return [{**source, "enabled": source_id in chosen} for source_id, source in SOURCES.items()]


class InspirationFeed:
    """Fetch a small feed from fixed public endpoints; repository content is never executed."""

    def __init__(self, client: httpx.Client | None = None, timeout_s: float = 5.0) -> None:
        self._client = client or http.build_client(
            timeout=timeout_s,
            follow_redirects=False,
            headers={"User-Agent": "Karajan-Inspiration/1.0", "Accept": "application/json, application/xml, text/xml"},
        )

    def fetch(self, source_ids: list[str], *, limit: int = 18) -> dict[str, Any]:
        items: list[dict[str, Any]] = []
        errors: dict[str, str] = {}
        by_source: list[list[dict[str, Any]]] = []
        for source_id in source_ids:
            source = SOURCES.get(source_id)
            if source is None:
                continue
            if not source["available"]:
                errors[source_id] = source.get("setup_hint", "Fuente no configurada")
                continue
            try:
                loader = getattr(self, f"_fetch_{source_id.replace('-', '_')}")
                by_source.append(loader(max(3, min(8, limit))))
            except (httpx.HTTPError, ValueError, TypeError, KeyError, ElementTree.ParseError) as exc:
                errors[source_id] = self._safe_error(exc)
        # Keep source diversity: a global date sort can push GitHub completely
        # out of the first page when news feeds are more active. Round-robin
        # the source buckets, then sort each bucket by recency.
        for bucket in by_source:
            bucket.sort(key=lambda item: item.get("published_at") or "", reverse=True)
        while len(items) < max(1, min(limit, 50)) and any(by_source):
            for bucket in by_source:
                if bucket and len(items) < max(1, min(limit, 50)):
                    items.append(bucket.pop(0))
        return {
            "items": items[: max(1, min(limit, 50))],
            "errors": errors,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }

    def _get(self, url: str) -> httpx.Response:
        response = self._client.get(url)
        response.raise_for_status()
        if len(response.content) > _MAX_RESPONSE_BYTES:
            raise ValueError("respuesta demasiado grande")
        return response

    def _fetch_github(self, limit: int) -> list[dict[str, Any]]:
        response = self._get(
            "https://api.github.com/search/repositories"
            f"?q=topic%3Aai-agents&sort=stars&order=desc&per_page={limit}"
        )
        return [
            self._item(
                "github",
                row.get("full_name", "Repositorio sin nombre"),
                row.get("html_url", ""),
                row.get("description", ""),
                row.get("pushed_at"),
                ["repositorio", *(row.get("topics") or [])[:3]],
                stars=row.get("stargazers_count"),
            )
            for row in response.json().get("items", [])[:limit]
        ]

    def _fetch_hacker_news(self, limit: int) -> list[dict[str, Any]]:
        response = self._get(
            "https://hn.algolia.com/api/v1/search_by_date"
            f"?query=AI%20agents&tags=story&hitsPerPage={limit}"
        )
        return [
            self._item(
                "hacker-news",
                row.get("title", "Historia sin título"),
                row.get("url") or f"https://news.ycombinator.com/item?id={row.get('objectID', '')}",
                f"{row.get('points', 0)} puntos · {row.get('num_comments', 0)} comentarios",
                row.get("created_at"),
                ["noticia", "comunidad"],
            )
            for row in response.json().get("hits", [])[:limit]
        ]

    def _fetch_devto(self, limit: int) -> list[dict[str, Any]]:
        response = self._get(f"https://dev.to/api/articles?tag=ai&per_page={limit}&top=7")
        return [
            self._item(
                "devto",
                row.get("title", "Artículo sin título"),
                row.get("url", ""),
                row.get("description", ""),
                row.get("published_at"),
                ["artículo", *(row.get("tag_list") or [])[:3]],
            )
            for row in response.json()[:limit]
        ]

    def _fetch_hugging_face(self, limit: int) -> list[dict[str, Any]]:
        root = ElementTree.fromstring(self._get("https://huggingface.co/blog/feed.xml").content)
        rows: list[dict[str, Any]] = []
        for entry in root.findall(".//item")[:limit]:
            rows.append(self._item(
                "hugging-face",
                entry.findtext("title") or "Publicación sin título",
                entry.findtext("link") or "",
                entry.findtext("description") or "",
                entry.findtext("pubDate"),
                ["modelo", "open-source"],
            ))
        return rows

    @staticmethod
    def _item(
        source_id: str,
        title: str,
        url: str,
        summary: str,
        published_at: str | None,
        tags: list[str],
        stars: int | None = None,
    ) -> dict[str, Any]:
        parsed = urlparse(url)
        safe_url = url if parsed.scheme == "https" and parsed.netloc else SOURCES[source_id]["homepage"]
        clean_summary = html.unescape(_TAG_RE.sub(" ", summary or ""))
        clean_summary = " ".join(clean_summary.split())[:280]
        return {
            "id": f"{source_id}:{hashlib.sha256(f'{title}\0{safe_url}'.encode('utf-8')).hexdigest()[:16]}",
            "source_id": source_id,
            "source_name": SOURCES[source_id]["name"],
            "title": " ".join(str(title).split())[:180],
            "summary": clean_summary,
            "url": safe_url,
            "published_at": published_at,
            "tags": tags,
            "stars": max(0, int(stars or 0)) if stars is not None else None,
        }

    @staticmethod
    def _safe_error(error: Exception) -> str:
        if isinstance(error, httpx.TimeoutException):
            return "La fuente tardó demasiado en responder."
        if isinstance(error, httpx.HTTPStatusError):
            return f"La fuente respondió con HTTP {error.response.status_code}."
        return "No se pudo actualizar esta fuente."
