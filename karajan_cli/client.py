"""Shared HTTP client for the Karajan API, used by both the `karajan` CLI and
`karajan_mcp.py` so there is exactly one implementation of each request.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

DEFAULT_URL = "http://127.0.0.1:8000"
URL_ENV_VAR = "KARAJAN_URL"
TOKEN_ENV_VAR = "KARAJAN_TOKEN"


class KarajanApiError(Exception):
    """Raised for any non-2xx response, with the server's `detail` surfaced."""

    def __init__(self, status_code: int, detail: str) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"HTTP {status_code}: {detail}")


class KarajanClient:
    def __init__(self, base_url: str | None = None, token: str | None = None, timeout: float = 30.0) -> None:
        self.base_url = (base_url or os.environ.get(URL_ENV_VAR, DEFAULT_URL)).rstrip("/")
        self.token = token or os.environ.get(TOKEN_ENV_VAR)
        self.timeout = timeout

    def _headers(self) -> dict[str, str]:
        return {"X-Karajan-Token": self.token} if self.token else {}

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = httpx.request(
                method, f"{self.base_url}{path}", headers=self._headers(), timeout=self.timeout, **kwargs
            )
        except httpx.HTTPError as exc:
            raise KarajanApiError(0, str(exc)) from exc
        if response.status_code >= 400:
            detail = response.text
            try:
                detail = response.json().get("detail", detail)
            except Exception:
                pass
            raise KarajanApiError(response.status_code, detail)
        if response.headers.get("content-type", "").startswith("text/plain"):
            return response.text
        if not response.content:
            return {}
        return response.json()

    # -- health / activation --
    def is_running(self) -> bool:
        try:
            response = httpx.get(f"{self.base_url}/health", timeout=3.0)
            response.raise_for_status()
            return True
        except httpx.HTTPError:
            return False

    def health(self) -> dict:
        return self._request("GET", "/health")

    # -- classify / ingest / delegate --
    def classify(self, prompt: str) -> dict:
        return self._request("POST", "/classify-task", json={"prompt": prompt})

    def ingest(self, payload: dict) -> dict:
        return self._request("POST", "/ingest", json=payload)

    def delegate(
        self, task_id: str, *, force_provider: str | None = None, force_entity_id: str | None = None
    ) -> dict:
        return self._request(
            "POST",
            "/delegate-task",
            json={"task_id": task_id, "force_provider": force_provider, "force_entity_id": force_entity_id},
        )

    def append_decision(self, task_id: str, entry: dict) -> dict:
        return self._request("POST", f"/tasks/{task_id}/decisions", json=entry)

    def approve_review(self, task_id: str) -> dict:
        return self._request("POST", f"/tasks/{task_id}/approve-review")

    def queue_status(self) -> dict:
        return self._request("GET", "/queue/status")

    # -- tasks --
    def list_tasks(self, limit: int | None = None, offset: int = 0) -> list[dict]:
        params: dict[str, Any] = {"offset": offset}
        if limit is not None:
            params["limit"] = limit
        return self._request("GET", "/tasks", params=params)

    def get_task(self, task_id: str) -> dict:
        return self._request("GET", f"/tasks/{task_id}")

    def get_decisions(self, task_id: str) -> list[dict]:
        return self._request("GET", f"/tasks/{task_id}/decisions")

    def search_tasks(self, query: str, limit: int = 20) -> dict:
        return self._request("GET", "/search/tasks", params={"q": query, "limit": limit})

    # -- config / routing layout (whole-object read-modify-write) --
    def get_config(self) -> dict:
        return self._request("GET", "/config")

    def put_config(self, config: dict) -> dict:
        return self._request("PUT", "/config", json=config)

    def get_routing_layout(self) -> dict:
        return self._request("GET", "/routing-layout")

    def put_routing_layout(self, layout: dict) -> dict:
        return self._request("PUT", "/routing-layout", json=layout)

    # -- providers / agents --
    def list_catalog(self) -> list[dict]:
        return self._request("GET", "/catalog")

    def list_providers(self) -> list[dict]:
        return self._request("GET", "/providers")

    def provider_setup(self, name: str) -> dict:
        return self._request("GET", f"/providers/{name}/setup")

    def provider_run(self, name: str, slot: str) -> dict:
        return self._request("POST", f"/providers/{name}/run", json={"slot": slot})

    # -- analytics --
    def metrics(self) -> dict:
        return self._request("GET", "/metrics")

    def agents_performance(self) -> list[dict]:
        return self._request("GET", "/agents/performance")

    def dashboard(self, days: int = 30) -> dict:
        return self._request("GET", "/analytics/dashboard", params={"days": days})

    def observability(self) -> dict:
        return self._request("GET", "/observability")

    def observability_history(self, limit: int = 200) -> dict:
        return self._request("GET", "/observability/history", params={"limit": limit})
