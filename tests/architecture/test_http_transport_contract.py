"""HTTP transport remains explicit and preserves service errors and credentials."""

from __future__ import annotations

import httpx
import pytest

from karajan_cli.client import HttpKarajanClient, KarajanApiError, build_client


def test_unavailable_http_does_not_create_embedded_store(tmp_path, monkeypatch):
    def unavailable(*args, **kwargs):
        raise httpx.ConnectError("service unavailable")

    monkeypatch.setattr(httpx, "request", unavailable)
    client = build_client(transport="http", url="http://127.0.0.1:1", data_dir=str(tmp_path))
    assert isinstance(client, HttpKarajanClient)
    with pytest.raises(KarajanApiError, match="service unavailable") as error:
        client.health()
    assert error.value.status_code == 0
    assert list(tmp_path.iterdir()) == []


def test_http_forwards_token_and_preserves_error_contract(monkeypatch):
    calls = []

    def request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        return httpx.Response(403, json={"detail": "insufficient permissions"})

    monkeypatch.setattr(httpx, "request", request)
    client = HttpKarajanClient(base_url="http://example.invalid", token="test-token")
    with pytest.raises(KarajanApiError) as error:
        client.put_config({"profile": "offline"})
    assert (error.value.status_code, error.value.detail) == (403, "insufficient permissions")
    assert calls[0][0:2] == ("PUT", "http://example.invalid/config")
    assert calls[0][2]["headers"] == {"X-Karajan-Token": "test-token"}
