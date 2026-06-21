"""Single-director HyperAgent engine (Groq native local tool-calling).

ONE director agent runs a room turn end-to-end:
  gather (recall / org_directory / drive_search / docs_get → a per-turn shared
  blackboard) → when a decision/discussion is warranted it calls the `debate`
  tool (the room's personas as INDEPENDENT sub-LLM-calls: stance → challenge /
  support, real skepticism) → conclude with a grounded synthesis.

The loop is the canonical Groq agentic pattern (tools=[…], tool_choice=auto →
parse tool_calls → execute locally → append role:tool → repeat until no
tool_calls). Genuinely multi-agent AT the debate; one cheap session elsewhere.
The blackboard is a per-instance list (NOT a module global) so concurrent turns
across tenants never share state.

This module imports NOTHING from `api_hyper_rooms` — it takes the resolved
tenant scope + an async `emit(event)` callable and returns a result dict the
orchestrator folds into the existing produce / verify / seal pipeline.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional

import httpx

from ..config import get_settings
from ..hivemind_client import (
    connector_exec_emulated,
    connector_inspect_emulated,
    google_exec_emulated,
    org_members_emulated,
    recall_emulated,
)

log = logging.getLogger(__name__)

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.\w+")

# Quality skills loaded WITHIN the call (model-driven, not pre-inserted) — the
# functional equivalent of a Claude skill for the gpt-oss director. Each is a
# concrete authoring CONTRACT the director writes to AFTER it calls load_skill;
# the producer then renders the markdown into the real connector artifact (Google
# Doc / Sheet / Gmail draft), so the markdown shape here drives the final quality.
_SKILLS: Dict[str, str] = {
    "polished-doc": (
        "POLISHED DOC — write a publish-ready Google Doc in markdown:\n"
        "• Open with '# <specific, descriptive Title>' (NOT the room goal), then a 2-3 sentence "
        "executive summary that states the answer/recommendation up front.\n"
        "• Structure with '## <Section>' (and '### ' sub-sections); lead each section with its point.\n"
        "• **Bold** every key term, name, figure, date, and decision.\n"
        "• For ANY numeric / comparative / cost / schedule / options data, USE A MARKDOWN TABLE — it "
        "is drawn as a REAL Google Docs table. Syntax: a header row, then a '|---|---|' rule line, "
        "then data rows. Prefer a table over inline figures.\n"
        "• '- ' bullets for lists, '1. ' for ordered steps/timelines.\n"
        "• Ground every specific in a recall/web/connector result; give a range if a figure is "
        "uncertain; mark anything you could not confirm 'UNVERIFIED' inline and gather the open "
        "items into a short '## Gaps to confirm' section.\n"
        "• End with a concrete '## Next steps' checklist (owner + action). NO process narration, "
        "NO placeholders, NO fabricated links — paste only REAL urls a tool returned."
    ),
    "polished-email": (
        "POLISHED EMAIL — write a tight, professional email:\n"
        "• 'Subject:' line — specific and informative (not generic like 'Update').\n"
        "• One-line greeting addressing the recipient BY NAME.\n"
        "• Body: 2-4 short sentences following context → value → the single ask. One clear CTA.\n"
        "• Professional sign-off.\n"
        "• Inline only REAL urls a tool returned — never invent a link, attachment, or 'see doc' "
        "reference that does not exist.\n"
        "• Do not state UNVERIFIED facts as certain; if a number is unconfirmed, soften or omit it. "
        "Keep it skimmable — no walls of text, no process narration."
    ),
    "decision-brief": (
        "DECISION BRIEF (DACI) — write a crisp decision memo in markdown:\n"
        "• '# <Decision title>' then a one-line **DECISION:** statement up top.\n"
        "• '## Context' — 1-2 sentences on why this decision, now.\n"
        "• '## Options considered' — a markdown TABLE: | Option | Pros | Cons | Cost / risk | (one row "
        "per real option, grounded).\n"
        "• '## Rationale' — 3-5 grounded bullets citing the debate + recall/web evidence (name who "
        "argued what when a debate happened).\n"
        "• '## Risks & UNVERIFIED' — honest open items / assumptions, each flagged.\n"
        "• '## Owners & next steps' — a TABLE: | Step | Owner | Timeline |. "
        "No fabrication; ground or flag every figure."
    ),
    "polished-sheet": (
        "POLISHED SHEET — output ONLY a single markdown table, nothing else:\n"
        "• First row = column headers chosen to directly answer the ask; then a '|---|' rule line; "
        "then one data row per item.\n"
        "• One fact per cell; keep cells short; no prose, no commentary around the table.\n"
        "• Ground every cell in a tool result; write '(UNVERIFIED)' in a cell you could not confirm "
        "rather than inventing a value."
    ),
    "status-update": (
        "STATUS UPDATE — concise, scannable, grounded:\n"
        "• Group by area or by DONE / IN PROGRESS / BLOCKED (or YESTERDAY / TODAY / BLOCKERS for a "
        "standup).\n"
        "• One '- ' bullet per item, each with the concrete fact + owner where relevant.\n"
        "• **Bold** blockers and dates. Flag anything UNVERIFIED. No filler, no narration."
    ),
    "notion-page": (
        "NOTION PAGE — write publish-ready content the producer will create as a Notion page:\n"
        "• Do NOT write a title line or '# Heading' first — the page title is set separately, so a "
        "leading title would duplicate. Open with a 1-2 sentence summary that states the answer up front.\n"
        "• Structure with '## <Section>' headings; lead each section with its point.\n"
        "• '- ' bullets for lists, '1. ' for ordered steps; **bold** key terms, names, figures, dates.\n"
        "• For ANY comparative / cost / options / schedule data, USE A MARKDOWN TABLE (header row, a "
        "'|---|---|' rule, then data rows) — Notion renders it as a real table.\n"
        "• Ground every specific in a recall/web/connector result; mark anything unconfirmed "
        "'(UNVERIFIED)' inline and collect open items under a short '## Gaps to confirm'.\n"
        "• NO process narration, NO placeholders, NO fabricated links — paste only REAL urls a tool returned."
    ),
}

_GOOGLE_CONNECTORS = ("google-docs", "google_docs", "googledrive", "google-drive", "gmail", "google")

# Curated READ tools per Google connector (the native google bridge has no param
# schemas, so we hand-spec the read surface). Writes (docs_create/gmail_send/…)
# are intentionally excluded — the centralized producer + HITL own those.
_GOOGLE_READ_TOOLS: Dict[str, List[tuple]] = {
    "gmail": [
        ("gmail_search", "Search the room owner's live Gmail. Gmail query syntax (e.g. 'from:rama after:2026/01/01').",
         {"query": {"type": "string"}, "max": {"type": "integer"}}, ["query"]),
        ("gmail_get", "Read one Gmail message (full body + headers) by its id.", {"id": {"type": "string"}}, ["id"]),
        ("gmail_get_thread", "Read a full Gmail thread by threadId.", {"threadId": {"type": "string"}}, ["threadId"]),
    ],
    "google-docs": [
        ("drive_search", "Find Google Drive files (docs/sheets) by name or content.", {"query": {"type": "string"}}, ["query"]),
        ("docs_get", "Read an existing Google Doc's text by documentId.", {"documentId": {"type": "string"}}, ["documentId"]),
    ],
    "google-drive": [
        ("drive_search", "Find Google Drive files (docs/sheets) by name or content.", {"query": {"type": "string"}}, ["query"]),
        ("docs_get", "Read an existing Google Doc's text by documentId.", {"documentId": {"type": "string"}}, ["documentId"]),
    ],
    "google-sheets": [
        ("sheets_get", "Read a Google Sheet's cell values by spreadsheetId (optional A1 range).",
         {"spreadsheetId": {"type": "string"}, "range": {"type": "string"}}, ["spreadsheetId"]),
    ],
    "google-calendar": [
        ("calendar_search", "Search the room owner's Google Calendar events.", {"query": {"type": "string"}}, ["query"]),
    ],
}
_GOOGLE_TOOL_NAMES = {n for tools in _GOOGLE_READ_TOOLS.values() for (n, *_rest) in tools}
# Tool-count discipline (Groq best-practice: keep the action space small). Total
# connector tools exposed to the director, and per-connector cap for MCP discovery.
_CONNECTOR_TOOL_CAP = max(0, int(os.environ.get("HYPER_CONNECTOR_TOOL_CAP", "8") or "8"))
_MCP_TOOLS_PER_CONNECTOR = max(1, int(os.environ.get("HYPER_MCP_TOOLS_PER_CONNECTOR", "4") or "4"))
_READ_TOOL_HINTS = ("search", "list", "get", "read", "fetch", "query", "find", "lookup", "describe", "recent", "view")


def _norm_connector(cid: str) -> str:
    return str(cid or "").strip().lower().replace("_", "-")


def _is_read_tool(name: str) -> bool:
    n = (name or "").lower()
    return any(h in n for h in _READ_TOOL_HINTS)


def _groq_key() -> str:
    s = get_settings()
    return (s.groq_api_key or os.environ.get("GROQ_API_KEY") or os.environ.get("LLM_API_KEY") or "")


def _tool(name: str, desc: str, props: Dict[str, Any], required: List[str]) -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": desc,
            "parameters": {"type": "object", "properties": props, "required": required},
        },
    }


def _persona_fields(emp: Dict[str, Any]) -> tuple[str, str, str]:
    name = emp.get("name") or emp.get("slug") or "Teammate"
    lane = emp.get("_lane") or emp.get("role_archetype") or "Communicator"
    apv = emp.get("active_prompt_version") or {}
    sysp = (apv.get("system_prompt") if isinstance(apv, dict) else None) or emp.get("persona") or ""
    return name, str(lane), str(sysp)[:1000]


class Director:
    """One director session for a single room turn. Stateful (blackboard +
    transcript) but instance-scoped — safe for concurrent multi-tenant turns."""

    def __init__(
        self,
        *,
        user_message: str,
        user_id: str,
        org_id: str,
        project_id: Optional[str],
        participants: List[Dict[str, Any]],
        room_template: str,
        room_goal: Optional[str],
        enabled_connectors: List[str],
        emit: Callable[[Dict[str, Any]], Awaitable[None]],
        director_model: Optional[str] = None,
        persona_model: Optional[str] = None,
        max_iters: int = 16,
        debate_max_rounds: int = 2,
        synth_model: Optional[str] = None,
    ) -> None:
        self.user_message = user_message
        self.user_id = user_id
        self.org_id = org_id
        self.project_id = project_id
        self.participants = participants
        self.roster = {(p.get("slug") or p.get("id")): p for p in participants}
        self.room_template = room_template or "debate"
        self.room_goal = room_goal or ""
        self.connectors = [str(c).lower() for c in (enabled_connectors or [])]
        self.has_google = any(c in self.connectors for c in _GOOGLE_CONNECTORS)
        self.emit = emit
        self.director_model = director_model or os.environ.get("HYPER_DIRECTOR_MODEL", "openai/gpt-oss-120b")
        self.persona_model = persona_model or os.environ.get("HYPER_PERSONA_MODEL", "openai/gpt-oss-120b")
        # Dedicated model for the FINAL deliverable. The gather loop + debate can run
        # on a cheap model (orchestration), but the synthesis is the product — so a
        # strong model writes it. When equal to director_model, no extra call (the
        # loop's own final IS the deliverable). Multi-model "Auto" = cheap gather + strong synth.
        self.synth_model = synth_model or self.director_model
        # Live public-web search uses Groq's built-in web search (only on the
        # `groq/compound*` systems — gpt-oss can't run it directly). compound-mini is
        # cheaper/faster and fine for in-room gathering; env-tunable.
        self.web_model = os.environ.get("HYPER_WEB_MODEL", "groq/compound-mini")
        self.max_iters = max_iters
        self.debate_max_rounds = max(1, min(3, debate_max_rounds))
        # per-turn state (NOT module globals)
        self.blackboard: List[str] = []
        self.transcript: List[Dict[str, Any]] = []
        self.tokens = 0
        self.gather_count = 0
        self._round_seq = 0
        self._web_calls = 0
        self._web_budget = max(0, int(os.environ.get("HYPER_WEB_BUDGET", "3") or "3"))
        # Connector tools (toggled on the room) registered dynamically at run() start:
        # JSON schemas the director sees + a route map name -> (bridge, provider, tool).
        self._connector_tools: List[Dict[str, Any]] = []
        self._connector_routes: Dict[str, tuple] = {}
        # Token accounting by pipeline phase (for cost analysis). director = the
        # gpt-oss-120b agentic loop (gather decisions + reading tool results +
        # synthesis — grows as context accumulates); debate = persona sub-calls;
        # web = compound web-search sub-calls. director_iters = per-loop-call totals.
        self.tok_by: Dict[str, int] = {"director": 0, "debate": 0, "web": 0}
        self.director_iters: List[int] = []
        self._last_tok = 0
        # Input/output split + Groq prompt-cache hits. cached = the slice of input
        # billed at 50% (auto on gpt-oss; the re-sent director-loop prefix caches).
        self.io: Dict[str, int] = {"input": 0, "output": 0, "cached": 0}
        # Email addresses the director encountered in connector (Gmail) reads — used to
        # resolve the recipient for a "send to <name>" task when the org/recall lookup
        # is empty (the director already searched to:<addr>, so it knows it).
        self.gathered_emails: set = set()

    # ── LLM ───────────────────────────────────────────────────────────
    async def _groq(
        self, messages: List[Dict[str, Any]], *, tools: Optional[List[Dict[str, Any]]] = None,
        model: Optional[str] = None, temp: float = 0.4, force_text: bool = False,
        bucket: str = "director",
    ) -> Optional[Dict[str, Any]]:
        """One Groq chat call. Retries a 400 (malformed tool-call generation) once
        at a lower temperature per Groq's guidance. Returns the message dict or
        None on a hard failure (the caller treats None as 'stop')."""
        key = _groq_key()
        if not key:
            log.error("[hyper-engine] no Groq API key configured")
            return None
        body: Dict[str, Any] = {"model": model or self.director_model, "messages": messages, "temperature": temp}
        if tools and not force_text:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        # force_text: OMIT tools entirely → the model writes text and physically
        # cannot emit a tool call. (Sending tools + tool_choice="none" makes gpt-oss
        # call a tool anyway → 400 "Tool choice is none, but model called a tool".)
        max_attempts = 3
        _nudged = False
        for attempt in range(max_attempts):
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(45.0, connect=5.0)) as c:
                    r = await c.post(GROQ_URL, headers={"Authorization": f"Bearer {key}"}, json=body)
                if r.status_code == 400 and attempt < max_attempts - 1:
                    body["temperature"] = max(0.1, float(body.get("temperature", temp)) - 0.2)
                    # gpt-oss harmony glitch: on a force_text (no-tools) call the decoder
                    # can still emit a spurious tool-call token → 400 "Tool choice is none,
                    # but model called a tool" / "tool_use_failed". Lowering temp alone often
                    # doesn't stop it — inject a hard prose-only directive once so the model
                    # writes the deliverable instead of (mis)calling a tool. (Only for
                    # force_text: the gather loop WANTS tools, so it just retries cooler.)
                    _txt = (r.text or "").lower()
                    if (force_text and not _nudged and
                            ("tool_use_failed" in _txt or "tool choice is none" in _txt
                             or "was not in request.tools" in _txt)):
                        body["messages"] = list(body["messages"]) + [{
                            "role": "system",
                            "content": ("Respond with the final deliverable as PLAIN TEXT only. "
                                        "Do NOT call any tool or function and do NOT emit an "
                                        "analysis/commentary channel — write the answer directly."),
                        }]
                        _nudged = True
                    log.warning("[hyper-engine] groq 400, retrying lower temp%s: %s",
                                " + prose-only nudge" if _nudged else "", r.text[:200])
                    continue
                if r.status_code in (429, 500, 502, 503) and attempt < max_attempts - 1:
                    ra = (r.headers.get("retry-after") or "").strip()
                    delay = float(ra) if ra.replace(".", "", 1).isdigit() else float(min(2 ** attempt, 8))
                    log.warning("[hyper-engine] groq %s — backoff %.1fs (attempt %d)", r.status_code, delay, attempt)
                    await asyncio.sleep(min(delay, 10.0))
                    continue
                if r.status_code != 200:
                    log.warning("[hyper-engine] groq %s: %s", r.status_code, r.text[:200])
                    return None
                j = r.json()
                u = j.get("usage") or {}
                t = int(u.get("total_tokens", 0) or 0)
                self.tokens += t
                self.tok_by[bucket] = self.tok_by.get(bucket, 0) + t
                self._last_tok = t
                self.io["input"] += int(u.get("prompt_tokens", 0) or 0)
                self.io["output"] += int(u.get("completion_tokens", 0) or 0)
                self.io["cached"] += int(((u.get("prompt_tokens_details") or {}).get("cached_tokens", 0)) or 0)
                return j["choices"][0]["message"]
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                log.warning("[hyper-engine] groq transport error (attempt %d): %s", attempt, exc)
                if attempt < max_attempts - 1:
                    await asyncio.sleep(float(min(2 ** attempt, 8)))
                    continue
                return None
            except Exception as exc:  # noqa: BLE001
                log.warning("[hyper-engine] groq call failed (attempt %d): %s", attempt, exc)
                return None
        return None

    # ── tools ─────────────────────────────────────────────────────────
    def _tools(self) -> List[Dict[str, Any]]:
        tools = [
            _tool("recall", "Search HIVEMIND (the company brain) for grounded facts. Call it as many "
                  "times as the task needs — once per distinct topic/entity.",
                  {"query": {"type": "string"}, "max": {"type": "integer"}}, ["query"]),
            _tool("org_directory", "Look up org members (name, email, role) — for contacts or "
                  "org-identity grounding.", {"query": {"type": "string"}}, []),
            _tool("debate", "Convene the room: the personas argue a topic (stance → challenge/support "
                  "each other, with real skepticism) over 1-2 rounds and return the transcript. Call "
                  "this when the task needs a decision or genuine discussion before you conclude.",
                  {"topic": {"type": "string"}, "rounds": {"type": "integer"}}, ["topic"]),
            _tool("load_skill", "Load a quality authoring skill (a concrete format contract) right "
                  "before you write the final output, then follow it exactly. Available: polished-doc, "
                  "polished-email, decision-brief, polished-sheet, status-update, notion-page.",
                  {"skill_name": {"type": "string"}}, ["skill_name"]),
        ]
        if self._web_budget > 0:
            tools.append(_tool(
                "web_search",
                "Search the LIVE PUBLIC WEB (news, market/industry data, public companies, "
                "current events, competitor info) via Groq's built-in web search. Use ONLY for "
                "facts that are genuinely EXTERNAL — public info the company brain (recall) would "
                "NOT hold. Returns a synthesized answer + real source links.",
                {"query": {"type": "string"}}, ["query"]))
        # Connector tools toggled on the room (read-only, registered at run() start).
        tools.extend(self._connector_tools)
        return tools

    async def _init_connector_tools(self) -> None:
        """Register the room's toggled connectors as READ-only director tools (the
        local-tool-calling pattern: schema → bridge exec → loop). Google connectors
        use a curated read surface; other Nango/MCP connectors are discovered via the
        bridge inspect (best-effort, only tools with a real input schema). Capped +
        read-only — writes stay with the centralized producer + HITL. Never raises."""
        registered: List[Dict[str, Any]] = []
        routes: Dict[str, tuple] = {}
        seen: set = set()

        def _add(tname: str, tdesc: str, props: Dict[str, Any], req: List[str], bridge: str, provider: str, real_tool: str) -> None:
            if tname in seen or len(registered) >= _CONNECTOR_TOOL_CAP:
                return
            seen.add(tname)
            registered.append(_tool(tname, tdesc, props, req))
            routes[tname] = (bridge, provider, real_tool)

        for cid in self.connectors:
            if len(registered) >= _CONNECTOR_TOOL_CAP:
                break
            norm = _norm_connector(cid)
            google = _GOOGLE_READ_TOOLS.get(norm)
            if google:
                for (n, d, p, rq) in google:
                    _add(n, d, p, rq, "google", norm, n)
                continue
            # Non-Google → discover the connector's read tools via the bridge.
            try:
                insp = await connector_inspect_emulated(norm, user_id=self.user_id, org_id=self.org_id)
            except Exception:  # noqa: BLE001
                insp = {}
            raw = (((insp or {}).get("inspection") or {}).get("tools")
                   or (insp or {}).get("tools") or [])
            count = 0
            for tspec in (raw if isinstance(raw, list) else []):
                if count >= _MCP_TOOLS_PER_CONNECTOR or len(registered) >= _CONNECTOR_TOOL_CAP:
                    break
                tname = str((tspec or {}).get("name") or "")
                if not tname or not _is_read_tool(tname):
                    continue
                schema = (tspec or {}).get("inputSchema") or (tspec or {}).get("input_schema") or {}
                if not isinstance(schema, dict) or not isinstance(schema.get("properties"), dict):
                    continue  # need a real schema to call the tool safely
                props = schema.get("properties") or {}
                req = schema.get("required") if isinstance(schema.get("required"), list) else []
                public = f"{norm.replace('-', '_')}__{tname}"
                desc = (str((tspec or {}).get("description") or tname)[:180]
                        + f" (live read from the {norm} connector).")
                _add(public, desc, props, req, "mcp", norm, tname)
                count += 1
        self._connector_tools = registered
        self._connector_routes = routes
        if registered:
            log.info("[hyper-engine] connector tools registered: %s",
                     [t["function"]["name"] for t in registered])

    async def _connector_read(self, name: str, args: Dict[str, Any]) -> str:
        bridge, provider, tool = self._connector_routes[name]
        try:
            if bridge == "google":
                r = await google_exec_emulated(tool, args or {}, user_id=self.user_id, org_id=self.org_id)
            else:
                r = await connector_exec_emulated(provider, tool, args or {}, user_id=self.user_id, org_id=self.org_id)
        except Exception as exc:  # noqa: BLE001
            return json.dumps({"error": str(exc)[:200], "is_error": True})
        res = r.get("result") if isinstance(r, dict) and isinstance(r.get("result"), dict) else (r or {})
        out = json.dumps(res)[:1500] if isinstance(res, (dict, list)) else str(res)[:1500]
        # Connector AUTH failure (expired/revoked token → 401/403). Surface a clean
        # "reconnect" signal instead of feeding the raw error to the agents as if it were
        # data — otherwise the room debates "API error logs" pointlessly. Tell the director
        # the connector is unavailable + emit a warning the FE renders as "reconnect X".
        _low = out.lower()
        _status = res.get("status") if isinstance(res, dict) else None
        if _status in (401, 403) or any(k in _low for k in (
                "unauthorized", "api token is invalid", "invalid_grant", "insufficient",
                "\"status\":401", "\"status\":403", "not authorized",
                "missing access token", "missing refresh token", "reconnect required",
                "reconnect it", "reauthorize", "re-authorize", "re-authenticate",
                "token expired", "token has expired")):
            await self.emit({"t": "warning", "code": "connector_reauth", "connector": provider,
                             "message": f"{provider} is not authorized — reconnect it in Connectors to use it here."})
            self.blackboard.append(
                f"- {provider}: NOT AUTHORIZED — its connection token is invalid/expired. The user "
                f"must RECONNECT {provider}. Do NOT treat this error as data or debate it; just note "
                f"{provider} is unavailable this turn.")
            self.gather_count += 1
            return json.dumps({"error": f"{provider} not authorized — reconnect required", "reconnect": provider})
        self.blackboard.append(f"- {provider}/{tool}: {out[:300]}")
        self.gather_count += 1
        # Harvest email addresses from gmail reads (result + the search args) so a
        # "send to <name>" task can resolve a real recipient the director already found.
        if "gmail" in provider:
            for blob in (out, json.dumps(args or {})):
                for addr in _EMAIL_RE.findall(blob or ""):
                    low = addr.lower()
                    if "noreply" not in low and "no-reply" not in low:
                        self.gathered_emails.add(low)
        q = ""
        for k in ("query", "id", "documentId", "spreadsheetId", "threadId"):
            if (args or {}).get(k):
                q = str(args[k]); break
        await self.emit({"t": "gather", "sources": [provider], "tool": tool, "query": q[:160],
                         "connector_hits": [tool], "memory_hits": 0})
        return out

    async def _emit_tool_start(self, fn: str, args: Dict[str, Any]) -> None:
        """Emit a 'what the room is doing right now' indicator the INSTANT a tool
        fires — BEFORE the (often 2–12s) network call — so the FE shows live activity
        instead of an idle gap while gather runs. Skips tools that emit their own
        progress (debate → round_start) or are instant (load_skill)."""
        if fn in ("debate", "load_skill"):
            return
        note = {
            "recall": "Recalling the company brain…",
            "org_directory": "Reading the org directory…",
            "web_search": "Searching the web…",
            "fetch_detail": "Fetching detail…",
        }.get(fn)
        if not note and fn in self._connector_routes:
            _, provider, _tool = self._connector_routes[fn]
            q = ""
            for k in ("query", "id", "documentId", "spreadsheetId", "threadId"):
                if (args or {}).get(k):
                    q = str(args[k])[:60]; break
            note = f"Reading {provider}" + (f" · “{q}”" if q else "…")
        if not note:
            return
        agent = self.participants[0].get("slug") if self.participants else "director"
        await self.emit({"t": "typing", "agent": agent, "note": note})

    async def _exec(self, name: str, args: Dict[str, Any]) -> str:
        try:
            if name == "recall":
                r = await recall_emulated(
                    str(args.get("query", "")), user_id=self.user_id, org_id=self.org_id,
                    project_id=self.project_id, max_memories=int(args.get("max", 6) or 6))
                mems = (r or {}).get("memories") or (r or {}).get("results") or (r or {}).get("context") or []
                facts = [
                    f"- {m.get('title') or m.get('name') or ''}: {str(m.get('content') or m.get('summary') or m.get('text') or '')[:200]}".strip(" -:")
                    for m in (mems if isinstance(mems, list) else [])[:6] if isinstance(m, dict)
                ]
                facts = [f for f in facts if f]
                self.blackboard.extend(facts)
                self.gather_count += 1
                await self.emit({"t": "gather", "sources": ["hivemind"], "memory_hits": len(facts),
                                 "connector_hits": [], "contacts": 0, "correspondence": 0})
                return json.dumps({"found": len(facts), "facts": facts})

            if name == "org_directory":
                r = await org_members_emulated(str(args.get("query", "")), user_id=self.user_id, org_id=self.org_id)
                members = (r or {}).get("members") or []
                trimmed = [{"name": m.get("name"), "email": m.get("email"), "role": m.get("role")}
                           for m in members[:25] if isinstance(m, dict)]
                if trimmed:
                    self.blackboard.append(f"- ORG MEMBERS: {json.dumps(trimmed)[:400]}")
                return json.dumps({"org_name": (r or {}).get("org_name"), "members": trimmed})

            if name in self._connector_routes:
                return await self._connector_read(name, args or {})

            if name == "web_search":
                return await self._web_search(str(args.get("query", "")))

            if name == "debate":
                return await self._debate(str(args.get("topic", "")), int(args.get("rounds", self.debate_max_rounds) or self.debate_max_rounds))

            if name == "load_skill":
                return _SKILLS.get(str(args.get("skill_name", "")),
                                   "unknown skill — choose one of: " + ", ".join(_SKILLS.keys()))

            return json.dumps({"error": f"unknown tool {name}"})
        except Exception as exc:  # noqa: BLE001 — surface as a tool error so the director adapts
            log.warning("[hyper-engine] tool %s failed: %s", name, exc)
            return json.dumps({"error": str(exc)[:200], "is_error": True})

    # ── live web search (Groq built-in, via a compound sub-call) ───────
    async def _web_search(self, query: str) -> str:
        """Search the live public web using Groq's BUILT-IN web search. The built-in
        runs only on the `groq/compound*` systems (not gpt-oss), so we make a separate
        sub-call (same pattern as the debate persona calls) and fold the result back
        onto the shared board — keeping the director's local tool-loop clean and
        avoiding the undocumented built-in×custom-tool mixing. Bounded per turn."""
        query = (query or "").strip()
        if not query:
            return json.dumps({"error": "empty query"})
        if self._web_calls >= self._web_budget:
            return json.dumps({"error": "web-search budget for this turn is used — rely on what you already gathered."})
        key = _groq_key()
        if not key:
            return json.dumps({"error": "web search unavailable (no key)"})
        self._web_calls += 1
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(45.0, connect=5.0)) as c:
                r = await c.post(GROQ_URL, headers={"Authorization": f"Bearer {key}"},
                                 json={"model": self.web_model,
                                       "messages": [{"role": "user", "content": query}]})
            if r.status_code != 200:
                log.warning("[hyper-engine] web_search %s: %s", r.status_code, r.text[:200])
                return json.dumps({"error": f"web search failed ({r.status_code})", "is_error": True})
            j = r.json()
            uw = j.get("usage") or {}
            wt = int(uw.get("total_tokens", 0) or 0)
            self.tokens += wt
            self.tok_by["web"] = self.tok_by.get("web", 0) + wt
            self.io["input"] += int(uw.get("prompt_tokens", 0) or 0)
            self.io["output"] += int(uw.get("completion_tokens", 0) or 0)
            self.io["cached"] += int(((uw.get("prompt_tokens_details") or {}).get("cached_tokens", 0)) or 0)
            msg = j["choices"][0]["message"]
            answer = str(msg.get("content") or "")[:1500]
            sources: List[Dict[str, str]] = []
            for et in (msg.get("executed_tools") or []):
                sr = et.get("search_results")
                # compound returns either a list, or a dict like {"results": [...]}.
                if isinstance(sr, dict):
                    sr = sr.get("results") or sr.get("search_results") or []
                if not isinstance(sr, list):
                    sr = []
                for s in sr[:5]:
                    if isinstance(s, dict) and s.get("url"):
                        sources.append({"title": str(s.get("title") or "")[:120], "url": str(s.get("url"))})
            self.blackboard.append(f"- WEB[{query[:60]}]: {answer[:300]}")
            self.gather_count += 1
            await self.emit({"t": "web_intel", "query": query[:200], "count": len(sources),
                             "sources": sources[:5], "summary": answer[:400]})
            return json.dumps({"answer": answer, "sources": sources[:5]})
        except Exception as exc:  # noqa: BLE001
            log.warning("[hyper-engine] web_search failed: %s", exc)
            return json.dumps({"error": str(exc)[:200], "is_error": True})

    # ── debate (the room) ─────────────────────────────────────────────
    async def _consult(self, emp: Dict[str, Any], prompt: str, round_no: int) -> Dict[str, Any]:
        name, lane, sysp = _persona_fields(emp)
        is_skeptic = "skeptic" in lane.lower()
        bias = (" You are the SKEPTIC of this room — find the single weakest claim and challenge it hard "
                "with specifics." if is_skeptic else "")
        ctx = "\n".join(self.blackboard)[:4000]
        msg = await self._groq([
            {"role": "system", "content": (
                f"You are {name}, a {lane} on this team.{bias} {sysp}\nRespond IN CHARACTER, CONCISELY "
                f"(3-5 sentences), grounded ONLY in the CONTEXT. If you disagree, challenge with specifics; "
                f"mark anything unverifiable as UNVERIFIED; never invent facts.")},
            {"role": "user", "content": f"CONTEXT (room's shared board):\n{ctx}\n\n[Debate round {round_no}] {prompt}"},
        ], model=self.persona_model, temp=min(0.7, 0.45 + 0.1 * round_no), bucket="debate")
        text = (msg or {}).get("content") or "(no reply)"
        return {"slug": emp.get("slug") or emp.get("id"), "name": name, "lane": lane,
                "is_skeptic": is_skeptic, "text": text}

    async def _debate(self, topic: str, rounds: int) -> str:
        rounds = max(1, min(self.debate_max_rounds, rounds))
        members = self.participants[:5]
        if not members:
            return json.dumps({"error": "no participants to debate"})

        # Round 1 — independent stances (parallel sub-calls = genuine independence)
        self._round_seq += 1
        await self.emit({"t": "round_start", "round": self._round_seq, "max_rounds": rounds})
        r1 = await asyncio.gather(*[
            self._consult(m, f"What is your stance on: {topic}? Give your view + your single biggest concern.", self._round_seq)
            for m in members
        ])
        for c in r1:
            self.transcript.append({"round": 1, "agent": c["name"], "text": c["text"]})
            await self.emit({"t": "react", "round": self._round_seq, "agent": c["slug"],
                             "name": c["name"], "lane": c["lane"],
                             "agreement": "challenge" if c["is_skeptic"] else "contribute",
                             "content": c["text"], "line": c["text"], "confidence": 0.7})

        # Round 2 — react/challenge each other on the shared board
        if rounds >= 2:
            self._round_seq += 1
            await self.emit({"t": "round_start", "round": self._round_seq, "max_rounds": rounds})
            prior = "\n".join(f"{c['name']}: {c['text']}" for c in r1)[:3500]
            r2 = await asyncio.gather(*[
                self._consult(m, (f"Your teammates said:\n{prior}\n\nREACT: whose point is weakest? Challenge "
                                  f"or build on it — be specific. Do you change your view on '{topic}'?"), self._round_seq)
                for m in members
            ])
            for c in r2:
                self.transcript.append({"round": 2, "agent": c["name"], "text": c["text"]})
                await self.emit({"t": "react", "round": self._round_seq, "agent": c["slug"],
                                 "name": c["name"], "lane": c["lane"],
                                 "agreement": "challenge" if c["is_skeptic"] else "support",
                                 "content": c["text"], "line": c["text"], "confidence": 0.7})

        await self.emit({"t": "swarm_verdict", "round": self._round_seq, "converged": True})
        return json.dumps({
            "rounds": rounds,
            "transcript": [{"r": x["round"], "agent": x["agent"], "said": x["text"][:400]} for x in self.transcript],
        })

    # ── main loop ─────────────────────────────────────────────────────
    def _system_prompt(self) -> str:
        roster = ", ".join(f"{p.get('name') or p.get('slug')} ({p.get('_lane') or 'Communicator'})" for p in self.participants)
        goal = f"\nROOM GOAL: {self.room_goal}" if self.room_goal else ""
        tmpl = (f"\nThis is a '{self.room_template}' room — frame the discussion and the final output to "
                f"fit that mode (debate=argued conclusion; decision=DACI; brainstorm=options; "
                f"council=vote; lean_coffee=per-topic; retrospective=worked/didn't/change; standup=status).")
        conn_names = [t["function"]["name"] for t in self._connector_tools]
        conn_line = (" Connected systems you can READ live via tools: " + ", ".join(conn_names)
                     + " — use them for live company data (these are reads; the room produces any"
                     " output once at the end).") if conn_names else ""
        return (
            "You are the facilitator of a HIVEMIND hyperagent room — sentinel agents that live inside the "
            "company brain and grow smarter over time. Your team: " + roster + "." + goal + tmpl + "\n"
            "GATHER grounded facts first (recall the company brain as many times as needed; org_directory "
            "for people)." + conn_line + " Use web_search for genuinely EXTERNAL/"
            "public facts the company brain would not hold (industry/market data, news, public companies, "
            "current events) — never for internal facts; and if the user EXPLICITLY asks to search the web / "
            "for the latest / current / public data, you MUST call web_search. When the task needs a decision or genuine "
            "discussion, call debate(topic) — the room's personas will argue it with real skepticism. "
            "Load a skill (load_skill) before writing the final output. Ground EVERYTHING in tool results; "
            "flag anything you cannot verify as UNVERIFIED; never invent facts, names, numbers, or links. "
            "When you are done gathering and debating, STOP calling tools and write the FINAL DELIVERABLE "
            "as your message: the publish-ready content only (no process narration, no placeholders). "
            "If the output is a document begin with '# <specific Title>'; if an email begin with "
            "'Subject:'; if a question, the direct grounded answer. Close with a one-line synthesis citing "
            "who argued what when a debate happened."
        )

    async def run(self) -> Dict[str, Any]:
        t0 = time.time()
        # Instant feedback from t=0: connector-tool init + the first model call run
        # with no event of their own, so without this the FE sits idle (only the
        # router showing) until the first tool fires. One typing note so the room
        # never looks frozen right after the query is sent.
        _lead = self.participants[0].get("slug") if self.participants else "director"
        await self.emit({"t": "typing", "agent": _lead, "note": "Reading the goal and gathering context…"})
        await self._init_connector_tools()  # register toggled connectors as read tools
        messages: List[Dict[str, Any]] = [
            {"role": "system", "content": self._system_prompt()},
            {"role": "user", "content": self.user_message},
        ]
        tools = self._tools()
        tool_calls_made = 0
        final_text = ""
        for it in range(self.max_iters):
            force_text = it == self.max_iters - 1  # last turn: force a synthesis, never another tool round
            msg = await self._groq(messages, tools=tools, force_text=force_text)
            self.director_iters.append(self._last_tok)
            if msg is None:
                break
            messages.append(msg)
            tcs = msg.get("tool_calls") or []
            if not tcs:
                final_text = msg.get("content") or ""
                break
            for tc in tcs:
                tool_calls_made += 1
                fn = (tc.get("function") or {}).get("name") or ""
                try:
                    a = json.loads((tc.get("function") or {}).get("arguments") or "{}")
                except Exception:  # noqa: BLE001
                    a = {}
                if not isinstance(a, dict):
                    a = {}
                await self._emit_tool_start(fn, a)
                result = await self._exec(fn, a)
                messages.append({"role": "tool", "tool_call_id": tc.get("id"), "name": fn, "content": result})
        else:
            # Loop exhausted without a no-tool-call finish — force one synthesis.
            msg = await self._groq(messages, tools=tools, force_text=True)
            final_text = (msg or {}).get("content") or final_text

        # FORCE the room to actually debate. The debate tool is the multi-agent
        # product, but the director (esp. the cheap gather model) often skips it. If
        # this is a multi-agent room (≥2 participants) on a substantive task and no
        # debate ran, convene it now so the deliverable reflects the team, not one voice.
        forced_debate = False
        if (self._round_seq == 0 and len(self.participants) >= 2
                and len((self.user_message or "").split()) >= 6):
            try:
                topic = (self.room_goal or self.user_message or "")[:400]
                transcript_json = await self._debate(topic, self.debate_max_rounds)
                messages.append({"role": "user", "content": (
                    "The room just debated this — transcript:\n" + str(transcript_json) + "\n\n"
                    "Now write the FINAL DELIVERABLE incorporating the debate; cite who argued what.")})
                forced_debate = True
            except Exception as exc:  # noqa: BLE001
                log.warning("[hyper-engine] forced debate failed: %s", exc)

        # Strong-model synthesis. Runs when (a) multi-model 'auto' (synth != director),
        # or (b) we just forced a debate that must be folded in. Writes the FINAL
        # deliverable from the full accumulated context. No tools (force_text) → no 400.
        if final_text and (self.synth_model != self.director_model or forced_debate):
            synth_msg = await self._groq(
                messages + [{"role": "user", "content": (
                    "Write the FINAL DELIVERABLE now — the publish-ready content only, FULLY grounded "
                    "in the tool results and debate above, with real markdown tables where they help. "
                    "No tool calls, no process narration, no placeholders.")}],
                force_text=True, model=self.synth_model, bucket="director")
            if synth_msg and (synth_msg.get("content") or "").strip():
                final_text = synth_msg["content"]

        if not final_text:
            # Defensive: never return empty. Synthesize from the board.
            board = "\n".join(self.blackboard)[:3000]
            msg = await self._groq([
                {"role": "system", "content": "Write the final grounded deliverable from the notes. No narration."},
                {"role": "user", "content": f"Task: {self.user_message}\n\nNotes:\n{board}"},
            ], temp=0.4)
            final_text = (msg or {}).get("content") or ""
        if not final_text:
            # Every LLM call (incl. the defensive synth) failed — honor "never return
            # empty" at the actual emit/return boundary so the FE never shows a blank
            # synthesis line and the verifier gets honest feedback, not "".
            final_text = ("(The room could not produce a grounded answer this turn — "
                          "the model was unreachable. Please retry, or add more context.)")

        await self.emit({"t": "line", "agent": (self.participants[0].get("slug") if self.participants else "director"),
                         "kind": "synthesis", "content": final_text})
        log.info("[hyper-engine] done calls=%d rounds=%d tokens=%d ms=%d gather=%d tok_by=%s iters=%s",
                 tool_calls_made, self._round_seq, self.tokens, int((time.time() - t0) * 1000),
                 self.gather_count, self.tok_by, self.director_iters)
        return {
            "cost_tokens": self.tokens,
            "final_text": final_text,
            "transcript": self.transcript,
            "gather_count": self.gather_count,
            "tool_calls": tool_calls_made,
            "tok_by": dict(self.tok_by),
            "director_iters": list(self.director_iters),
            "debate_rounds": self._round_seq,
            "web_calls": self._web_calls,
            "io": dict(self.io),
            "gathered_emails": sorted(self.gathered_emails),
            "gather_facts": list(self.blackboard),
        }


async def run_director(
    *,
    user_message: str,
    user_id: str,
    org_id: str,
    project_id: Optional[str],
    participants: List[Dict[str, Any]],
    room_template: str,
    room_goal: Optional[str],
    enabled_connectors: List[str],
    emit: Callable[[Dict[str, Any]], Awaitable[None]],
    director_model: Optional[str] = None,
    persona_model: Optional[str] = None,
    synth_model: Optional[str] = None,
    max_iters: int = 16,
) -> Dict[str, Any]:
    """Run one room turn through the single-director engine. Returns
    {cost_tokens, final_text, transcript, gather_count, tool_calls}."""
    director = Director(
        user_message=user_message, user_id=user_id, org_id=org_id, project_id=project_id,
        participants=participants, room_template=room_template, room_goal=room_goal,
        enabled_connectors=enabled_connectors, emit=emit,
        director_model=director_model, persona_model=persona_model, synth_model=synth_model,
        max_iters=max_iters,
    )
    return await director.run()
