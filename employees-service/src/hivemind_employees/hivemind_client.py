"""HTTP client to HIVEMIND core + control-plane.

This is how the sidecar invokes Slack actions, recall, and memory
saves — via the existing REST endpoints (and the policy-gated
/api/employees/slack-action). NO direct Slack tokens here.
"""
from __future__ import annotations

import httpx
import logging
from typing import Any, Dict, Optional

from .config import get_settings

log = logging.getLogger(__name__)


class HivemindClient:
    """Per-employee HTTP client. One instance per WorkflowAgent.
    Carries the employee's scoped API key."""

    def __init__(self, api_key: str):
        settings = get_settings()
        self.api_key = api_key
        self.core = httpx.AsyncClient(
            base_url=settings.hivemind_core_url,
            timeout=httpx.Timeout(30.0, connect=5.0),
            headers={
                "Authorization": f"Bearer {api_key}",
                "X-API-Key": api_key,
                "Content-Type": "application/json",
            },
        )
        self.cp = httpx.AsyncClient(
            base_url=settings.hivemind_cp_url,
            timeout=httpx.Timeout(30.0, connect=5.0),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
        )

    # ── Slack action gateway ────────────────────────────────
    async def slack_post(self, channel: str, text: str, thread_ts: Optional[str] = None) -> Dict[str, Any]:
        return await self._slack_action("slack_post", {"channel": channel, "text": text, "thread_ts": thread_ts})

    async def slack_react(self, channel: str, ts: str, emoji: str) -> Dict[str, Any]:
        return await self._slack_action("slack_react", {"channel": channel, "ts": ts, "emoji": emoji})

    async def slack_search(self, query: str, count: int = 10) -> Dict[str, Any]:
        return await self._slack_action("slack_search", {"query": query, "count": count})

    async def slack_history(self, channel: str, limit: int = 50, since: Optional[str] = None) -> Dict[str, Any]:
        return await self._slack_action("slack_history", {"channel": channel, "limit": limit, "since": since})

    async def _slack_action(self, action_type: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        r = await self.core.post(
            "/api/employees/slack-action",
            json={"action_type": action_type, "payload": payload},
        )
        r.raise_for_status()
        return r.json()

    # ── Memory ───────────────────────────────────────────────
    async def recall(self, query: str, max_memories: int = 5, **kwargs) -> Dict[str, Any]:
        r = await self.core.post(
            "/api/recall",
            json={"query_context": query, "max_memories": max_memories, **kwargs},
        )
        r.raise_for_status()
        return r.json()

    async def save_memory(self, title: str, content: str, tags: Optional[list] = None, **kwargs) -> Dict[str, Any]:
        r = await self.core.post(
            "/api/memories",
            json={"title": title, "content": content, "tags": tags or [], "sync": True, **kwargs},
        )
        r.raise_for_status()
        return r.json()

    # ── Lifecycle ────────────────────────────────────────────
    async def aclose(self) -> None:
        await self.core.aclose()
        await self.cp.aclose()


# ── Service-level client (uses master key) ──────────────────
class ServiceClient:
    """Master-key client for admin operations (reconcile etc.)"""
    def __init__(self):
        settings = get_settings()
        if not settings.hivemind_master_api_key:
            log.warning("HIVEMIND_MASTER_API_KEY not set — service client disabled")
        self.master = settings.hivemind_master_api_key
        self.cp = httpx.AsyncClient(
            base_url=settings.hivemind_cp_url,
            timeout=30.0,
            headers={"X-API-Key": self.master or "", "Content-Type": "application/json"},
        )

    async def core_health(self) -> Dict[str, Any]:
        settings = get_settings()
        async with httpx.AsyncClient(base_url=settings.hivemind_core_url, timeout=5.0) as c:
            r = await c.get("/health")
            return {"ok": r.status_code == 200, "status": r.status_code}

    async def aclose(self) -> None:
        await self.cp.aclose()
