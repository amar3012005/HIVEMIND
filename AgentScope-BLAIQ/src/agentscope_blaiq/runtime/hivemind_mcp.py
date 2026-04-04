from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

import httpx


class HivemindMCPError(RuntimeError):
    pass


@dataclass
class HivemindWebJobResult:
    job_id: str
    status: str
    payload: dict[str, Any]


class HivemindMCPClient:
    def __init__(
        self,
        *,
        rpc_url: str | None,
        api_key: str | None,
        timeout_seconds: int = 20,
        poll_interval_seconds: float = 1.0,
        poll_attempts: int = 10,
    ) -> None:
        self.rpc_url = rpc_url
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds
        self.poll_interval_seconds = poll_interval_seconds
        self.poll_attempts = poll_attempts

    @property
    def enabled(self) -> bool:
        return bool(self.rpc_url and self.api_key)

    async def tools_list(self) -> dict[str, Any]:
        return await self._rpc("tools/list", {})

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        response = await self._rpc("tools/call", {"name": name, "arguments": arguments})
        return response

    async def recall(self, *, query: str, limit: int = 20, mode: str = "insight") -> dict[str, Any]:
        return await self.call_tool("hivemind_recall", {"query": query, "limit": limit, "mode": mode})

    async def query_with_ai(self, *, question: str, context_limit: int = 8) -> dict[str, Any]:
        return await self.call_tool("hivemind_query_with_ai", {"question": question, "context_limit": context_limit})

    async def get_memory(self, *, memory_id: str) -> dict[str, Any]:
        return await self.call_tool("hivemind_get_memory", {"memory_id": memory_id})

    async def traverse_graph(self, *, memory_id: str, depth: int = 2) -> dict[str, Any]:
        return await self.call_tool("hivemind_traverse_graph", {"memory_id": memory_id, "depth": depth})

    async def web_search(self, *, query: str, domains: list[str] | None = None, limit: int = 5) -> dict[str, Any]:
        payload: dict[str, Any] = {"query": query, "limit": limit}
        if domains:
            payload["domains"] = domains
        return await self.call_tool("hivemind_web_search", payload)

    async def web_crawl(self, *, urls: list[str], depth: int = 1, page_limit: int = 5) -> dict[str, Any]:
        return await self.call_tool("hivemind_web_crawl", {"urls": urls, "depth": depth, "page_limit": page_limit})

    async def web_job_status(self, *, job_id: str) -> dict[str, Any]:
        return await self.call_tool("hivemind_web_job_status", {"job_id": job_id})

    async def web_usage(self) -> dict[str, Any]:
        return await self.call_tool("hivemind_web_usage", {})

    async def save_memory(self, *, title: str, content: str, tags: list[str] | None = None, project: str | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"title": title, "content": content, "source_type": "research_summary"}
        if tags:
            payload["tags"] = tags
        if project:
            payload["project"] = project
        return await self.call_tool("hivemind_save_memory", payload)

    async def save_conversation(self, *, title: str, messages: list[dict[str, str]], tags: list[str] | None = None, project: str | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"title": title, "messages": messages, "platform": "blaiq"}
        if tags:
            payload["tags"] = tags
        if project:
            payload["project"] = project
        return await self.call_tool("hivemind_save_conversation", payload)

    async def poll_web_job(self, *, job_id: str) -> HivemindWebJobResult:
        last_payload: dict[str, Any] | None = None
        for _ in range(self.poll_attempts):
            payload = await self.web_job_status(job_id=job_id)
            last_payload = payload
            normalized = self._extract_tool_payload(payload)
            status = str(normalized.get("status") or normalized.get("state") or "").lower()
            if status in {"succeeded", "success", "completed", "complete"}:
                return HivemindWebJobResult(job_id=job_id, status=status, payload=normalized)
            if status in {"failed", "error"}:
                raise HivemindMCPError(f"HIVE-MIND web job failed: {normalized}")
            await asyncio.sleep(self.poll_interval_seconds)
        raise HivemindMCPError(f"HIVE-MIND web job did not finish in time: {last_payload}")

    async def _rpc(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if not self.enabled:
            raise HivemindMCPError("HIVE-MIND MCP is not configured")

        async with httpx.AsyncClient(timeout=self.timeout_seconds, follow_redirects=True) as client:
            response = await client.post(
                self.rpc_url,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={"method": method, "params": params, "id": 1},
            )
            response.raise_for_status()
            payload = response.json()
        if "error" in payload and payload["error"]:
            raise HivemindMCPError(str(payload["error"]))
        return payload.get("result") or payload

    @staticmethod
    def _extract_tool_payload(result: dict[str, Any]) -> dict[str, Any]:
        content = result.get("content")
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    text = item.get("text")
                    if isinstance(text, dict):
                        return text
                    if isinstance(text, str):
                        try:
                            parsed = json.loads(text)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(parsed, dict):
                            return parsed
            return {"content": content}
        if isinstance(result.get("metadata"), dict):
            return result["metadata"]
        return result
