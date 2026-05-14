"""HIVEMIND Python client — sync + async, httpx-based."""

from __future__ import annotations

import os
from typing import Any, Literal

import httpx

from hivemind.models import Memory, Relationship, SearchResult

DEFAULT_BASE_URL = "https://core.hivemind.davinciai.eu:8050"
DEFAULT_TIMEOUT = 30.0


class HiveMindError(Exception):
    """Raised when HIVEMIND API returns a non-2xx response."""

    def __init__(self, message: str, status_code: int | None = None, body: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.body = body


def _build_headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "hivemind-python-sdk/0.1.0",
    }


def _coerce_results(raw: list[dict[str, Any]] | None) -> list[SearchResult]:
    if not raw:
        return []
    out: list[SearchResult] = []
    for item in raw:
        # API may return either {memory, score} or flat — handle both
        if "memory" in item and isinstance(item["memory"], dict):
            mem = item["memory"]
            score = float(item.get("score", 0.0))
        else:
            mem = item
            score = float(item.get("score", item.get("similarity", 0.0)))
        try:
            out.append(SearchResult(
                memory=Memory.model_validate(mem),
                score=score,
                method=item.get("method", "hybrid"),
                explanation=item.get("explanation"),
            ))
        except Exception:
            # Skip malformed entries — don't break the whole list
            continue
    return out


class HiveMind:
    """Synchronous HIVEMIND client.

    Args:
        api_key: Bearer token (hmk_live_...). Falls back to HIVEMIND_API_KEY env.
        base_url: API base URL. Falls back to HIVEMIND_URL env.
        user_id: Optional default user_id for memory ownership.
        org_id: Optional default org_id for tenant scope.
        timeout: HTTP timeout in seconds.
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        user_id: str | None = None,
        org_id: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ):
        self.api_key = api_key or os.environ.get("HIVEMIND_API_KEY")
        if not self.api_key:
            raise ValueError(
                "api_key required. Pass api_key=... or set HIVEMIND_API_KEY env var."
            )
        self.base_url = (base_url or os.environ.get("HIVEMIND_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.user_id = user_id
        self.org_id = org_id
        self._client = httpx.Client(
            base_url=self.base_url,
            headers=_build_headers(self.api_key),
            timeout=timeout,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> HiveMind:
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            resp = self._client.request(method, path, **kwargs)
        except httpx.HTTPError as e:
            raise HiveMindError(f"Network error: {e}") from e
        if resp.status_code >= 400:
            try:
                body = resp.json()
            except Exception:
                body = resp.text
            raise HiveMindError(
                f"HTTP {resp.status_code}: {body}",
                status_code=resp.status_code,
                body=body,
            )
        if resp.headers.get("content-type", "").startswith("application/json"):
            return resp.json()
        return resp.text

    # ─── Memory ops ─────────────────────────────────────────────────

    def save(
        self,
        content: str,
        *,
        title: str | None = None,
        tags: list[str] | None = None,
        memory_type: str = "fact",
        project: str | None = None,
        importance_score: float | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> Memory:
        """Save a new memory. Returns the persisted Memory with id."""
        payload: dict[str, Any] = {
            "content": content,
            "memoryType": memory_type,
            "tags": tags or [],
        }
        if title:
            payload["title"] = title
        if project:
            payload["project"] = project
        if importance_score is not None:
            payload["importanceScore"] = importance_score
        if metadata:
            payload["metadata"] = metadata
        if self.user_id:
            payload["userId"] = self.user_id
        if self.org_id:
            payload["orgId"] = self.org_id

        result = self._request("POST", "/api/memories", json=payload)
        mem_data = result.get("memory") if isinstance(result, dict) and "memory" in result else result
        return Memory.model_validate(mem_data)

    def search(
        self,
        query: str,
        *,
        n_results: int = 10,
        scope: Literal["personal", "team", "all"] = "personal",
        tags: list[str] | None = None,
        project: str | None = None,
        memory_type: str | None = None,
        min_score: float | None = None,
    ) -> list[SearchResult]:
        """Hybrid semantic search. Returns ranked SearchResult list with provenance."""
        payload: dict[str, Any] = {
            "query": query,
            "n_results": n_results,
            "scope": scope,
        }
        if tags:
            payload["tags"] = tags
        if project:
            payload["project"] = project
        if memory_type:
            payload["memoryType"] = memory_type
        if min_score is not None:
            payload["minScore"] = min_score

        result = self._request("POST", "/api/memories/search", json=payload)
        raw = result.get("results") or result.get("memories") or []
        return _coerce_results(raw)

    def recall(
        self,
        query: str,
        *,
        n_results: int = 10,
        mode: Literal["quick", "panorama", "insight"] = "quick",
        scope: Literal["personal", "team", "all"] = "personal",
        project: str | None = None,
    ) -> list[SearchResult]:
        """Higher-level recall with optional reasoning modes (panorama/insight)."""
        payload: dict[str, Any] = {
            "query": query,
            "limit": n_results,
            "mode": mode,
            "scope": scope,
        }
        if project:
            payload["project"] = project

        result = self._request("POST", "/api/recall", json=payload)
        raw = result.get("memories") or result.get("results") or []
        return _coerce_results(raw)

    def get(self, memory_id: str) -> Memory:
        """Fetch a single memory by id."""
        result = self._request("GET", f"/api/memories/{memory_id}")
        data = result.get("memory") if isinstance(result, dict) and "memory" in result else result
        return Memory.model_validate(data)

    def delete(self, memory_id: str) -> bool:
        """Soft-delete a memory. Returns True on success."""
        self._request("DELETE", f"/api/memories/{memory_id}")
        return True

    def list_memories(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        tags: list[str] | None = None,
        project: str | None = None,
        scope: Literal["personal", "team", "all"] = "personal",
    ) -> list[Memory]:
        """List memories with filters."""
        params: dict[str, Any] = {"limit": limit, "offset": offset, "scope": scope}
        if tags:
            params["tags"] = ",".join(tags)
        if project:
            params["project"] = project
        result = self._request("GET", "/api/memories", params=params)
        items = result.get("memories") or result.get("results") or []
        return [Memory.model_validate(m) for m in items]

    # ─── Graph ops ──────────────────────────────────────────────────

    def graph(
        self,
        *,
        scope: Literal["personal", "team", "all"] = "personal",
        project: str | None = None,
        limit: int = 1000,
        include_edges: bool = True,
    ) -> dict[str, Any]:
        """Fetch the memory graph (nodes + edges + clusters + meta)."""
        params: dict[str, Any] = {
            "scope": scope,
            "limit": limit,
            "include_edges": str(include_edges).lower(),
        }
        if project:
            params["project"] = project
        return self._request("GET", "/api/graph", params=params)

    def traverse(
        self,
        memory_id: str,
        *,
        depth: int = 2,
        relationship: str = "all",
    ) -> dict[str, Any]:
        """Walk the graph from a starting memory."""
        return self._request(
            "POST",
            "/api/memories/traverse",
            json={"memoryId": memory_id, "depth": depth, "relationship": relationship},
        )

    # ─── Knowledge / docs ───────────────────────────────────────────

    def upload_document(
        self,
        file_path: str,
        *,
        tags: list[str] | None = None,
        target_scope: Literal["personal", "organization"] = "personal",
        container_tag: str | None = None,
    ) -> dict[str, Any]:
        """Upload a document (PDF, DOCX, TXT, MD, CSV, XLSX) for chunked ingestion."""
        with open(file_path, "rb") as f:
            files = {"file": (os.path.basename(file_path), f.read())}
        data: dict[str, str] = {"targetScope": target_scope}
        if tags:
            data["tags"] = ",".join(tags)
        if container_tag:
            data["containerTag"] = container_tag
        # httpx multipart — temporarily strip JSON content-type
        headers = {k: v for k, v in _build_headers(self.api_key).items() if k != "Content-Type"}
        resp = self._client.post(
            "/api/knowledge/upload",
            files=files,
            data=data,
            headers=headers,
            timeout=300.0,  # large file uploads
        )
        if resp.status_code >= 400:
            raise HiveMindError(f"HTTP {resp.status_code}: {resp.text}", resp.status_code, resp.text)
        return resp.json()

    # ─── Health ─────────────────────────────────────────────────────

    def health(self) -> dict[str, Any]:
        """Check API health."""
        return self._request("GET", "/api/health")


class AsyncHiveMind:
    """Async variant — same surface, awaitable methods."""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        user_id: str | None = None,
        org_id: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ):
        self.api_key = api_key or os.environ.get("HIVEMIND_API_KEY")
        if not self.api_key:
            raise ValueError("api_key required.")
        self.base_url = (base_url or os.environ.get("HIVEMIND_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.user_id = user_id
        self.org_id = org_id
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers=_build_headers(self.api_key),
            timeout=timeout,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> AsyncHiveMind:
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            resp = await self._client.request(method, path, **kwargs)
        except httpx.HTTPError as e:
            raise HiveMindError(f"Network error: {e}") from e
        if resp.status_code >= 400:
            try:
                body = resp.json()
            except Exception:
                body = resp.text
            raise HiveMindError(
                f"HTTP {resp.status_code}: {body}",
                status_code=resp.status_code,
                body=body,
            )
        if resp.headers.get("content-type", "").startswith("application/json"):
            return resp.json()
        return resp.text

    async def save(self, content: str, **kwargs: Any) -> Memory:
        sync = HiveMind.save.__wrapped__ if hasattr(HiveMind.save, "__wrapped__") else None
        # Reuse the sync logic for payload construction
        payload: dict[str, Any] = {"content": content, "memoryType": kwargs.get("memory_type", "fact")}
        if kwargs.get("title"):
            payload["title"] = kwargs["title"]
        if kwargs.get("tags"):
            payload["tags"] = kwargs["tags"]
        if kwargs.get("project"):
            payload["project"] = kwargs["project"]
        if kwargs.get("importance_score") is not None:
            payload["importanceScore"] = kwargs["importance_score"]
        if self.user_id:
            payload["userId"] = self.user_id
        if self.org_id:
            payload["orgId"] = self.org_id
        result = await self._request("POST", "/api/memories", json=payload)
        data = result.get("memory") if isinstance(result, dict) and "memory" in result else result
        return Memory.model_validate(data)

    async def search(self, query: str, **kwargs: Any) -> list[SearchResult]:
        payload: dict[str, Any] = {
            "query": query,
            "n_results": kwargs.get("n_results", 10),
            "scope": kwargs.get("scope", "personal"),
        }
        if kwargs.get("tags"):
            payload["tags"] = kwargs["tags"]
        if kwargs.get("project"):
            payload["project"] = kwargs["project"]
        result = await self._request("POST", "/api/memories/search", json=payload)
        raw = result.get("results") or result.get("memories") or []
        return _coerce_results(raw)

    async def recall(self, query: str, **kwargs: Any) -> list[SearchResult]:
        payload = {
            "query": query,
            "limit": kwargs.get("n_results", 10),
            "mode": kwargs.get("mode", "quick"),
            "scope": kwargs.get("scope", "personal"),
        }
        result = await self._request("POST", "/api/recall", json=payload)
        raw = result.get("memories") or result.get("results") or []
        return _coerce_results(raw)

    async def graph(self, **kwargs: Any) -> dict[str, Any]:
        params: dict[str, Any] = {
            "scope": kwargs.get("scope", "personal"),
            "limit": kwargs.get("limit", 1000),
            "include_edges": str(kwargs.get("include_edges", True)).lower(),
        }
        if kwargs.get("project"):
            params["project"] = kwargs["project"]
        return await self._request("GET", "/api/graph", params=params)

    async def health(self) -> dict[str, Any]:
        return await self._request("GET", "/api/health")
