"""HTTP client to HIVEMIND core + control-plane.

This is how the sidecar invokes Slack actions, recall, and memory
saves — via the existing REST endpoints (and the policy-gated
/api/employees/slack-action). NO direct Slack tokens here.
"""
from __future__ import annotations

import os
import re
import httpx
import logging
from typing import Any, Dict, List, Optional

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


async def save_prospect_emulated(*, company: str, note: str, user_id: Optional[str], org_id: Optional[str],
                                 phone: str = "", email: str = "", website: str = "",
                                 address: str = "", fit_reason: str = "",
                                 distinctive_signal: str = "", outreach_angle: str = "",
                                 project_id: Optional[str] = None, api_key: str = "",
                                 source: str = "discovery") -> Dict[str, Any]:
    """Persist a prospect/lead as an org-scoped memory (tag 'prospect') with a PERSONAL NOTE,
    via master+emulation headers. The company-wide lead book list_prospects reads. Idempotent-ish
    (memory claim-key dedup). Returns the created memory JSON (or {} on any failure — never raises
    into a turn)."""
    # DISABLED BY DEFAULT — prospects are CRM records, not memories. This is the
    # SECOND of two writers; agentscope_tools._save_prospect_memory was guarded in
    # 3ab5356db but this one was missed, so prospect dumping continued unabated:
    # 115 rows reappeared within hours of a 119-row cleanup, newest 19:48, while the
    # other guard sat live in the deployed image. Guarding one door is guarding none.
    #
    # Same reasoning as the other site: every intelligence step is switched off
    # below (smartIngest False, skipProcessing, skip_relationship_classification,
    # skip_contradiction_detection, defer_entity_linking), so these were never
    # processed as memories — they used the memory table as a lead store, 0%
    # anchored, and they compete with real memories in semantic recall. Observed in
    # a live /chat answer: "Prospect: Hannover Re" cited as a source for a question
    # about Solvis heat-pump documentation.
    #
    # Same env flag as the other writer so one switch controls both.
    if str(os.getenv("HYPER_PROSPECTS_TO_MEMORY", "false")).lower() != "true":
        return {}
    company = str(company or "").strip()
    note = str(note or "").strip()
    if not company or not note:
        return {}
    lines = [f"PROSPECT: {company}"]
    if phone:
        lines.append(f"PHONE: {phone}")
    if email:
        lines.append(f"EMAIL: {email}")
    if website:
        lines.append(f"WEBSITE: {website}")
    if address:
        lines.append(f"ADDRESS: {address}")
    if fit_reason:
        lines.append(f"FIT_REASON: {fit_reason}")
    if distinctive_signal:
        lines.append(f"DISTINCTIVE_SIGNAL: {distinctive_signal}")
    if outreach_angle:
        lines.append(f"OUTREACH_ANGLE: {outreach_angle}")
    lines.append(f"NOTE: {note}")
    slug = re.sub(r"[^a-z0-9]+", "-", company.lower()).strip("-")[:60]
    tags = ["prospect", "lead", f"company:{slug}"] + (["has-phone"] if phone else []) + (["has-email"] if email else [])
    body: Dict[str, Any] = {
        "title": f"Prospect: {company}"[:120], "content": "\n".join(lines), "tags": tags,
        "sync": True, "smartIngest": False, "skipProcessing": True,
        "skipPredictCalibrate": True, "skipAdvisoryLock": True,
        "skip_relationship_classification": True, "skip_contradiction_detection": True,
        "defer_entity_linking": True,
        "memory_type": "fact", "source_platform": "hyperagents-prospect",
        "source_metadata": {"source_type": "prospect", "source_platform": "hyperagents-prospect",
                            "prospect_source": source, "company": company,
                            "phone": phone or None, "email": email or None, "website": website or None,
                            "address": address or None, "fit_reason": fit_reason or None,
                            "distinctive_signal": distinctive_signal or None,
                            "outreach_angle": outreach_angle or None},
    }
    if project_id:
        body["project_id"] = project_id
    settings = get_settings()
    headers = _emulated_headers(api_key, user_id, org_id)
    try:
        async with httpx.AsyncClient(base_url=settings.hivemind_core_url,
                                     timeout=httpx.Timeout(20.0, connect=5.0), headers=headers) as c:
            r = await c.post("/api/memories", json=body)
            r.raise_for_status()
            return r.json()
    except Exception:
        return {}


async def save_prospects_bulk_emulated(*, prospects: List[Dict[str, Any]], user_id: Optional[str],
                                        org_id: Optional[str], turn_id: Optional[str] = None,
                                        api_key: str = "") -> Dict[str, Any]:
    """Persist a qualified Room result atomically through the shared Leads boundary."""
    if not prospects or not user_id or not org_id:
        return {"error": "prospects, user_id and org_id are required"}
    key = api_key or os.environ.get("HIVEMIND_MASTER_API_KEY") or os.environ.get("API_MASTER_KEY") or ""
    # Service-to-service writes stay on the private Compose network. The public
    # URL is only a fallback for non-Compose development environments.
    base = (os.environ.get("HIVEMIND_CP_URL")
            or os.environ.get("HIVEMIND_CONTROL_PLANE_URL") or "http://hm-control:3000").rstrip("/")
    headers = {"Authorization": f"Bearer {key}", "X-API-Key": key, "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=5.0)) as client:
            response = await client.post(f"{base}/internal/hyper/prospects/bulk", headers=headers, json={
                "org_id": org_id, "user_id": user_id, "turn_id": turn_id,
                "prospects": prospects[:50],
            })
        response.raise_for_status()
        return response.json()
    except Exception as exc:  # noqa: BLE001
        log.warning("[prospects.bulk] failed: %s", exc)
        return {"error": str(exc)[:200]}


async def list_prospects_emulated(*, user_id: Optional[str], org_id: Optional[str],
                                  query: str = "", limit: int = 50,
                                  api_key: str = "") -> Dict[str, Any]:
    """Read the tenant CRM lead book through the same private boundary used for writes."""
    if not user_id or not org_id:
        return {"error": "user_id and org_id are required", "records": []}
    key = api_key or os.environ.get("HIVEMIND_MASTER_API_KEY") or os.environ.get("API_MASTER_KEY") or ""
    base = (os.environ.get("HIVEMIND_CP_URL")
            or os.environ.get("HIVEMIND_CONTROL_PLANE_URL") or "http://hm-control:3000").rstrip("/")
    headers = {"Authorization": f"Bearer {key}", "X-API-Key": key}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=5.0)) as client:
            response = await client.get(f"{base}/internal/hyper/prospects", headers=headers, params={
                "org_id": org_id, "user_id": user_id, "query": str(query or "")[:240],
                "limit": max(1, min(int(limit or 50), 100)),
            })
        response.raise_for_status()
        return response.json()
    except Exception as exc:  # noqa: BLE001
        log.warning("[prospects.list] failed: %s", exc)
        return {"error": str(exc)[:200], "records": []}


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


async def seo_audit_emulated(url: str, *, user_id: Optional[str], org_id: Optional[str],
                             api_key: str = "", page_limit: int = 25,
                             timeout_s: float = 180.0, on_progress=None) -> Dict[str, Any]:
    """Run the deterministic Core SEO audit as the current tenant and poll its web job.

    The returned payload contains one seo-audit-v1 result. It is crawler evidence,
    not an LLM interpretation, and remains subject to Core URL policy and quotas.
    """
    import asyncio
    settings = get_settings()
    headers = _emulated_headers(api_key, user_id, org_id)
    try:
        async with httpx.AsyncClient(
            base_url=settings.hivemind_core_url,
            timeout=httpx.Timeout(timeout_s, connect=5.0),
            headers=headers,
        ) as c:
            sub = await c.post("/api/web/seo-audit/jobs", json={
                "url": str(url or "").strip(),
                "page_limit": max(1, min(int(page_limit or 25), 50)),
                "depth": 2,
            })
            if sub.status_code not in (200, 202):
                return {"error": f"seo audit submit {sub.status_code}", "detail": sub.text[:300]}
            job_id = (sub.json() or {}).get("job_id")
            if not job_id:
                return {"error": "no job_id"}
            last_stage = None
            for _ in range(max(12, int(timeout_s / 2))):
                await asyncio.sleep(2)
                try:
                    response = await c.get(f"/api/web/jobs/{job_id}")
                except (httpx.TimeoutException, httpx.TransportError) as exc:
                    log.warning("SEO audit poll transient failure job=%s: %s", job_id, exc)
                    continue
                if response.status_code != 200:
                    continue
                payload = response.json() or {}
                stage = payload.get("capability_stage")
                stage_key = (stage or {}).get("stage") if isinstance(stage, dict) else None
                stage_status = (stage or {}).get("status") if isinstance(stage, dict) else None
                current_stage = (stage_key, stage_status)
                if on_progress and stage_key and current_stage != last_stage:
                    await on_progress(stage)
                    last_stage = current_stage
                if payload.get("status") in ("succeeded", "failed", "completed", "error", "done"):
                    return payload
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


async def campaign_create_emulated(
    brief: Dict[str, Any], *, user_id: Optional[str], org_id: Optional[str],
    room_id: str, turn_id: str, api_key: str = "",
) -> Dict[str, Any]:
    """Start the canonical Core campaign pipeline from any non-campaign Room.

    Identity and organization are injected through the existing server-side
    emulation boundary; the model never supplies them. The originating turn is
    the idempotency key, so retries cannot create duplicate Campaign Rooms.
    """
    settings = get_settings()
    headers = _emulated_headers(api_key, user_id, org_id)
    payload = dict(brief or {})
    payload["idempotency_key"] = f"hyper-room:{room_id}:turn:{turn_id}"[:160]
    payload["source_room_id"] = room_id
    payload["source_turn_id"] = turn_id
    payload["trigger_surface"] = "hyperagents"
    try:
        async with httpx.AsyncClient(
            base_url=settings.hivemind_core_url,
            timeout=httpx.Timeout(35.0, connect=5.0),
            headers=headers,
        ) as c:
            r = await c.post("/api/campaigns", json=payload)
            data: Dict[str, Any]
            try:
                data = r.json() or {}
            except Exception:  # noqa: BLE001
                data = {"message": r.text[:300]}
            if r.status_code >= 400:
                return {
                    "error": str(data.get("message") or data.get("error") or f"campaign create {r.status_code}")[:300],
                    "code": data.get("error") or "campaign_create_failed",
                    "status": r.status_code,
                }
            return data
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)[:300], "code": "campaign_create_unavailable"}


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
