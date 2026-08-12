from __future__ import annotations

import httpx

from app.inspiration_feed import InspirationFeed, source_catalog


class _Client:
    def get(self, url: str) -> httpx.Response:
        request = httpx.Request("GET", url)
        if "api.github.com" in url:
            return httpx.Response(200, request=request, json={"items": [{
                "full_name": "acme/agent-kit",
                "html_url": "https://github.com/acme/agent-kit",
                "description": "Useful <b>agent</b> tools",
                "pushed_at": "2026-02-02T00:00:00Z",
                "topics": ["agents"],
            }]})
        raise AssertionError(url)


def test_source_catalog_marks_selection_and_threads_setup() -> None:
    catalog = source_catalog(["github"])
    github = next(source for source in catalog if source["id"] == "github")
    threads = next(source for source in catalog if source["id"] == "threads")
    assert github["enabled"] is True
    assert threads["enabled"] is False
    assert threads["requires_credentials"] is True


def test_feed_normalizes_repository_item() -> None:
    result = InspirationFeed(client=_Client()).fetch(["github"], limit=4)
    assert result["errors"] == {}
    assert result["items"][0]["title"] == "acme/agent-kit"
    assert result["items"][0]["summary"] == "Useful agent tools"
    assert result["items"][0]["url"] == "https://github.com/acme/agent-kit"


def test_unconfigured_source_is_reported_without_fake_items() -> None:
    result = InspirationFeed(client=_Client()).fetch(["threads"])
    assert result["items"] == []
    assert "threads" in result["errors"]
