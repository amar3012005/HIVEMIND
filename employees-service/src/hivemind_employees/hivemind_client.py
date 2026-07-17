"""HTTP client to HIVEMIND core + control-plane.

This is how the sidecar invokes Slack actions, recall, and memory
saves — via the existing REST endpoints (and the policy-gated
/api/employees/slack-action). NO direct Slack tokens here.
"""
from __future__ import annotations

import os
import httpx
import logging
from typing import Any, Dict, Optional

from .config import get_settings

log = logging.getLogger(__name__)


def _emulated_headers(api_key: str, user_id: Optional[str], org_id: Optional[str]) -> Dict[str, str]:
    """Auth headers for HIVEMIND core. Preferred: the employee's scoped key.
    Fallback when no minted key exists: master key + X-HM-User-Id/X-HM-Org-Id
    emulation so recall executes as the room owner. Mirrors the agent toolkit
    (agentscope_tools._client) so server-side prefetch reaches the SAME org
    brain the agents' tool calls do — not whatever key bootstrap happens to
    hand back (often none)."""
    effective = api_key or ""
    extra: Dict[str, str] = {}
    if not effective:
        master = os.environ.get("HIVEMIND_MASTER_API_KEY") or os.environ.get("API_MASTER_KEY") or ""
        if master:
            effective = master
            if user_id:
                extra["X-HM-User-Id"] = user_id
            if org_id:
                extra["X-HM-Org-Id"] = org_id
    headers = {
        "Authorization": f"Bearer {effective}" if effective else "",
        "X-API-Key": effective,
        "Content-Type": "application/json",
    }
    headers = {k: v for k, v in headers.items() if v}
    headers.update(extra)
    return headers


async def report_llm_usage(*, user_id: Optional[str], org_id: Optional[str], api_key: str = "",
                           model: str = "hyperagents-director", total_tokens: int = 0,
                           prompt_tokens: int = 0, completion_tokens: int = 0,
                           feature: str = "hyperagents-room") -> None:
    """Report the director's LLM token spend to HIVEMIND core so it records against the org's
    HIVEMIND API key (org_id + key from the emulation headers + model + feature). The director runs
    in this Python service — its LLM calls never touch core's JS metering chokepoint, so without this
    bridge HyperAgents spend is invisible to per-key accounting. Fire-and-forget: never raise into a
    room turn. No-op when there are no tokens or no org."""
    if not org_id or not total_tokens or total_tokens <= 0:
        return
    try:
        settings = get_settings()
        headers = _emulated_headers(api_key, user_id, org_id)
        async with httpx.AsyncClient(
            base_url=settings.hivemind_core_url,
            timeout=httpx.Timeout(8.0, connect=4.0),
            headers=headers,
        ) as c:
            await c.post("/api/usage/llm-report", json={
                "model": model,
                "total_tokens": int(total_tokens),
                "prompt_tokens": int(prompt_tokens or 0),
                "completion_tokens": int(completion_tokens or 0),
                "feature": feature,
            })
    except Exception:
        # Metering must never break a turn — swallow transport/auth errors silently.
        return


async def recall_emulated(query: str, *, user_id: Optional[str], org_id: Optional[str],
                          api_key: str = "", max_memories: int = 8,
                          project_id: Optional[str] = None,
                          mode: str = "explain") -> Dict[str, Any]:
    """Async recall that works even when the employee has no minted key, via
    master + emulation headers. Returns the raw /api/recall JSON."""
    settings = get_settings()
    headers = _emulated_headers(api_key, user_id, org_id)
    async with httpx.AsyncClient(
        base_url=settings.hivemind_core_url,
        timeout=httpx.Timeout(30.0, connect=5.0),
        headers=headers,
    ) as c:
        recall_mode = mode if mode in {"fact", "explain", "full"} else "explain"
        body: Dict[str, Any] = {
            "query_context": query,
            "max_memories": max_memories,
            "mode": recall_mode,
        }
        if project_id:
            # project_id (snake) is the HARD scope: core forces the access context to this
            # project and EXCLUDES other projects' memories (so a Solvis-project room never
            # recalls SINGULANCE etc.). project/preferred_project alone were only a SOFT
            # boost — they leaked cross-project. Keep them for container-tag mapping + intra-
            # scope ranking, but project_id is what makes recall strictly project-scoped.
            body["project_id"] = project_id
            body["project"] = project_id
            body["preferred_project"] = project_id
        r = await c.post("/api/recall", json=body)
        r.raise_for_status()
        return r.json()


async def list_tagged_emulated(*, tags: str, user_id: Optional[str], org_id: Optional[str],
                               api_key: str = "", limit: int = 6) -> list:
    """Guaranteed tag-filtered memory lane (same pattern as the org-canon lane) —
    e.g. tags="outreach-learning" surfaces the org's distilled call learnings even
    when vector recall would rank them low. Best-effort: [] on any failure."""
    settings = get_settings()
    headers = _emulated_headers(api_key, user_id, org_id)
    try:
        async with httpx.AsyncClient(
            base_url=settings.hivemind_core_url,
            timeout=httpx.Timeout(12.0, connect=4.0),
            headers=headers,
        ) as c:
            r = await c.get("/api/memories", params={
                "tags": str(tags), "is_latest": "true", "limit": max(1, min(int(limit or 6), 12)),
            })
            r.raise_for_status()
            j = r.json()
            return j.get("memories") or j.get("results") or []
    except Exception:  # noqa: BLE001
        return []


async def list_canon_emulated(*, user_id: Optional[str], org_id: Optional[str],
                              api_key: str = "", limit: int = 8) -> list:
    """Fetch the org's PINNED canon memories (tag `org-canon` — company identity,
    mission, positioning, ICP, team; filed by HyperAgents onboarding) via the core
    list endpoint. This is the GUARANTEED company-context lane: tag-filtered, not
    score-ranked, so the canon surfaces even when vector recall would bury it under
    a dense KB corpus. Best-effort: [] on any failure."""
    settings = get_settings()
    headers = _emulated_headers(api_key, user_id, org_id)
    try:
        async with httpx.AsyncClient(
            base_url=settings.hivemind_core_url,
            timeout=httpx.Timeout(12.0, connect=4.0),
            headers=headers,
        ) as c:
            r = await c.get("/api/memories", params={
                "tags": "org-canon", "is_latest": "true", "limit": max(1, min(int(limit or 8), 12)),
            })
            r.raise_for_status()
            j = r.json()
            return j.get("memories") or j.get("results") or []
    except Exception:
        return []


async def web_search_emulated(query: str, *, user_id: Optional[str], org_id: Optional[str],
                              api_key: str = "", limit: int = 6, timeout_s: float = 45.0) -> Dict[str, Any]:
    """Live web search via HIVEMIND core's Tavily-backed web-intel — the SAME engine
    behind the hivemind_web_search MCP tool (so the director reuses it, not a bespoke
    Tavily client). Submits a job, polls until terminal, returns the succeeded payload
    {status, results:[{title,url,snippet,score}], ...}. Best-effort: returns
    {"error": ...} instead of raising (web is optional gathering, never fatal)."""
    import asyncio
    settings = get_settings()
    headers = _emulated_headers(api_key, user_id, org_id)
    try:
        async with httpx.AsyncClient(
            base_url=settings.hivemind_core_url,
            timeout=httpx.Timeout(timeout_s, connect=5.0),
            headers=headers,
        ) as c:
            sub = await c.post("/api/web/search/jobs", json={"query": query, "limit": max(1, min(int(limit or 6), 10))})
            if sub.status_code not in (200, 202):
                return {"error": f"web submit {sub.status_code}", "detail": sub.text[:200]}
            job_id = (sub.json() or {}).get("job_id")
            if not job_id:
                return {"error": "no job_id"}
            for _ in range(max(6, int(timeout_s))):
                await asyncio.sleep(1)
                g = await c.get(f"/api/web/jobs/{job_id}")
                if g.status_code != 200:
                    continue
                p = g.json() or {}
                if p.get("status") in ("succeeded", "failed", "completed", "error", "done"):
                    return p
            return {"status": "timeout", "job_id": job_id}
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)[:200]}


async def org_members_emulated(
    query: str = "", *, user_id: Optional[str], org_id: Optional[str], api_key: str = ""
) -> Dict[str, Any]:
    """Fetch the org directory (org_name + members with email/role/projects),
    via master + emulation headers. Used for org-identity grounding + contact
    resolution. Never raises into the turn — returns {} on failure."""
    settings = get_settings()
    headers = _emulated_headers(api_key, user_id, org_id)
    try:
        async with httpx.AsyncClient(
            base_url=settings.hivemind_core_url,
            timeout=httpx.Timeout(15.0, connect=5.0),
            headers=headers,
        ) as c:
            r = await c.post("/api/org/members", json={"query": query})
            r.raise_for_status()
            return r.json()
    except Exception:  # noqa: BLE001
        return {}


async def google_exec_emulated(
    tool: str, arguments: Dict[str, Any], *, user_id: Optional[str], org_id: Optional[str], api_key: str = ""
) -> Dict[str, Any]:
    """Run a native Google tool (gmail_search / gmail_get / ...) via the core
    bridge with master + emulation headers. Used by the orchestrator to pre-fetch
    prior correspondence for voice/style grounding. Returns {} on failure."""
    settings = get_settings()
    headers = _emulated_headers(api_key, user_id, org_id)
    try:
        async with httpx.AsyncClient(
            base_url=settings.hivemind_core_url,
            timeout=httpx.Timeout(25.0, connect=5.0),
            headers=headers,
        ) as c:
            r = await c.post("/api/connectors/google/exec", json={"tool": tool, "arguments": arguments})
            if r.status_code >= 400:
                # Surface the failure (e.g. Google 403 insufficient scopes) so the
                # producer can report "re-authorize the connector" instead of a
                # silent no-artifact + opaque escalation.
                body = ""
                try:
                    body = (r.json() or {}).get("error") or r.text
                except Exception:  # noqa: BLE001
                    body = r.text
                return {"error": str(body)[:300], "status": r.status_code}
            j = r.json()
            return j.get("result") if isinstance(j.get("result"), dict) else j
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)[:200]}


async def connector_inspect_emulated(
    name: str, *, user_id: Optional[str], org_id: Optional[str], api_key: str = ""
) -> Dict[str, Any]:
    """List a Nango/MCP connector's available tools (names + inputSchema) via the
    core bridge, scoped to the tenant. Used to dynamically build the room
    director's connector toolkit. Returns {} on failure (never raises)."""
    settings = get_settings()
    headers = _emulated_headers(api_key, user_id, org_id)
    try:
        async with httpx.AsyncClient(
            base_url=settings.hivemind_core_url,
            timeout=httpx.Timeout(20.0, connect=5.0),
            headers=headers,
        ) as c:
            r = await c.post("/api/connectors/mcp/inspect", json={"name": name})
            if r.status_code >= 400:
                return {}
            return r.json()
    except Exception:  # noqa: BLE001
        return {}


async def connector_exec_emulated(
    name: str, tool: str, arguments: Dict[str, Any], *,
    user_id: Optional[str], org_id: Optional[str], api_key: str = ""
) -> Dict[str, Any]:
    """Execute one tool call on a granted Nango/MCP connector via the core bridge
    (token resolved server-side, never exposed). Tenant-scoped. Returns
    {"error": ...} on failure so the director can adapt rather than crash."""
    settings = get_settings()
    headers = _emulated_headers(api_key, user_id, org_id)
    # MCP runner expects operation.type "tool" (the tool name in operation.name, its
    # args in operation.arguments). "execute" → 400 "Unsupported MCP operation type".
    payload = {"name": name, "operation": {"type": "tool", "name": tool, "arguments": (arguments or {})}}
    try:
        async with httpx.AsyncClient(
            base_url=settings.hivemind_core_url,
            timeout=httpx.Timeout(30.0, connect=5.0),
            headers=headers,
        ) as c:
            r = await c.post("/api/connectors/mcp/exec", json=payload)
            if r.status_code >= 400:
                body = ""
                try:
                    body = (r.json() or {}).get("error") or r.text
                except Exception:  # noqa: BLE001
                    body = r.text
                return {"error": str(body)[:300], "status": r.status_code}
            j = r.json()
            return j.get("result") if isinstance(j.get("result"), dict) else j
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)[:200]}


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
        kwargs.setdefault("mode", "explain")
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
