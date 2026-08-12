"""Safe metadata-only analyzer for non-GitHub web references."""

from __future__ import annotations

import re
import hashlib
from html.parser import HTMLParser
from urllib.parse import urlsplit, urlunsplit

import httpx

from app.models import AnalyzeResult, ResourceCreateRequest, ResourceKind
from app.resource_intelligence import extract_resource_signals


class _PageMetadata(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title: list[str] = []
        self.description = ""
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {key.lower(): (value or "") for key, value in attrs}
        if tag.lower() == "title":
            self._in_title = True
        if tag.lower() == "meta" and values.get("name", "").lower() in {"description", "og:description"}:
            self.description = values.get("content", "")[:600]

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title.append(data)


def validate_reference_url(value: str) -> str:
    raw = value.strip()
    if raw and "://" not in raw:
        raw = f"https://{raw}"
    parsed = urlsplit(raw)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("Solo se aceptan referencias HTTPS públicas")
    if parsed.username or parsed.password or parsed.fragment:
        raise ValueError("La URL no puede incluir credenciales ni fragmentos")
    host = parsed.hostname.lower().rstrip(".")
    if host in {"localhost", "127.0.0.1", "0.0.0.0", "::1"} or host.endswith(".local"):
        raise ValueError("La referencia no puede apuntar a una red local")
    return urlunsplit(("https", host, parsed.path or "/", parsed.query, ""))


class WebReferenceAnalyzer:
    def analyze(self, url: str) -> AnalyzeResult:
        try:
            canonical = validate_reference_url(url)
            with httpx.Client(follow_redirects=True, max_redirects=2, timeout=8.0, headers={"User-Agent": "Karajan-Inspiration/1.0"}) as client:
                with client.stream("GET", canonical) as response:
                    canonical = validate_reference_url(str(response.url))
                    access_limited = response.status_code in {401, 403, 429}
                    if not access_limited:
                        response.raise_for_status()
                    chunks: list[bytes] = []
                    remaining = 512_000
                    if not access_limited:
                        for chunk in response.iter_bytes():
                            if not chunk:
                                continue
                            if len(chunk) > remaining:
                                chunks.append(chunk[:remaining])
                                remaining = 0
                                break
                            chunks.append(chunk)
                            remaining -= len(chunk)
                    body = b"".join(chunks)
                    content_type = response.headers.get("content-type", "")
            parser = _PageMetadata()
            if not access_limited:
                parser.feed(body.decode("utf-8", errors="ignore"))
            host = urlsplit(canonical).hostname or "web"
            title = re.sub(r"\s+", " ", " ".join(parser.title)).strip() or host
            summary = re.sub(r"\s+", " ", parser.description).strip() or (f"Referencia web de {host}." if not access_limited else f"Referencia web de {host} (contenido restringido; se guardó la URL para consulta).")
            slug = re.sub(r"[^a-z0-9]+", "-", f"{host}-{urlsplit(canonical).path.strip('/')}".lower()).strip("-")[:120] or "web-reference"
            intelligence = extract_resource_signals(
                {"name": title, "description": summary},
                (),
                body.decode("utf-8", errors="ignore") if body else summary,
                None,
            )
            preview = ResourceCreateRequest(
                name=title[:160], slug=slug, kind=ResourceKind.REFERENCE, source=host[:80], repo_url=canonical,
                summary=summary[:4000], tags=sorted({"web", host, *intelligence.tags}),
                capabilities=sorted({"referencia web", *intelligence.capabilities}), install_strategy="none",
                metadata={
                    "reference_type": "webpage", "hostname": host, "content_type": content_type,
                    "source_revision": hashlib.sha256(body).hexdigest() if body else f"restricted:{response.status_code}",
                    "source_analysis_method": "web-metadata",
                    "intelligence": intelligence.to_dict(),
                },
            )
            return AnalyzeResult(valid=True, repo_url=canonical, summary=summary, metadata=preview.metadata, preview=preview)
        except (ValueError, httpx.HTTPError) as exc:
            return AnalyzeResult(valid=False, repo_url=url, warnings=[str(exc)])
