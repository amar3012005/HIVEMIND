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
from collections import Counter
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

# ── Population-Sim (ADDITIONAL, opt-in) — a cheap many-voice social simulation that runs
# AFTER gather and feeds its report into the synthesis. Modeled on MiroFish CSI. Bursts on
# the cheap model with a fallback chain; the report on the strong synth model. All bounded +
# wrapped so a failure NEVER breaks the main turn.
_SIM_AGENT_MODEL = os.environ.get("HYPER_SIM_AGENT_MODEL", "llama-3.1-8b-instant")
_SIM_FALLBACKS = [m.strip() for m in os.environ.get(
    "HYPER_SIM_FALLBACKS", "openai/gpt-oss-20b,llama-3.3-70b-versatile").split(",") if m.strip()]
_SIM_PERSONAS = max(4, min(150, int(os.environ.get("HYPER_SIM_PERSONAS", "24") or "24")))
_SIM_TYPES = max(3, min(20, int(os.environ.get("HYPER_SIM_TYPES", "8") or "8")))
_SIM_CONCURRENCY = max(2, int(os.environ.get("HYPER_SIM_CONCURRENCY", "10") or "10"))
_SIM_ON = {"on", "simulation", "additional", "true", "1", "yes"}


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


def _parse_json_loose(text: str) -> Any:
    """Best-effort JSON from a model message (handles ```json fences + surrounding prose).
    Used by the Population-Sim where 8b returns JSON without strict-schema enforcement."""
    if not text:
        return None
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t, flags=re.MULTILINE).strip()
    try:
        return json.loads(t)
    except Exception:  # noqa: BLE001
        m = re.search(r"(\{.*\}|\[.*\])", t, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(1))
            except Exception:  # noqa: BLE001
                return None
    return None


def _flatten_for_text(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Convert tool-call STRUCTURE (assistant.tool_calls + role:tool) into plain text.
    A force_text synthesis fed the raw tool-call transcript primes gpt-oss's harmony
    decoder to keep emitting tool calls → repeated 400 'Tool choice is none, but model
    called a tool', which no prose instruction overrides. Flattening keeps the
    information (results as context) but removes the structure that triggers the tool
    channel, so the model writes the deliverable as prose."""
    out: List[Dict[str, Any]] = []
    for m in messages:
        role = m.get("role")
        if role == "tool":
            out.append({"role": "user",
                        "content": f"[tool result · {m.get('name') or 'tool'}] {str(m.get('content') or '')[:1600]}"})
        elif role == "assistant" and m.get("tool_calls"):
            names = ", ".join((tc.get("function") or {}).get("name", "?") for tc in (m.get("tool_calls") or []))
            txt = (m.get("content") or "").strip()
            out.append({"role": "assistant", "content": (txt + "\n" if txt else "") + f"[called: {names}]"})
        else:
            out.append(m)
    return out


# Connector tool-schema inspect is the SAME across tenants (it's the MCP server's tool
# list, not tenant data) and rarely changes — but a COLD inspect (a fresh mcp.notion.com
# connection from hm-core) can block ~20s at run() start, stalling the whole turn before
# any gathering. Cache the tool list per connector so only the first turn pays it;
# every later turn (within the TTL) skips the inspect entirely and starts instantly.
_INSPECT_CACHE: Dict[str, tuple] = {}
_INSPECT_TTL = float(os.environ.get("HYPER_CONNECTOR_INSPECT_TTL", "900") or "900")


async def _inspect_connector_tools(norm: str, *, user_id: str, org_id: str) -> List[Dict[str, Any]]:
    """Cached connector tool-list inspect. Returns the raw tools list. Caches only a
    non-empty success (an empty/failed inspect — e.g. a not-connected connector or a
    cold timeout — is retried next turn rather than cached as 'no tools')."""
    now = time.time()
    cached = _INSPECT_CACHE.get(norm)
    if cached and cached[0] > now:
        return cached[1]
    try:
        insp = await connector_inspect_emulated(norm, user_id=user_id, org_id=org_id)
    except Exception:  # noqa: BLE001
        insp = {}
    raw = (((insp or {}).get("inspection") or {}).get("tools")
           or (insp or {}).get("tools") or [])
    if isinstance(raw, list) and raw:
        _INSPECT_CACHE[norm] = (now + _INSPECT_TTL, raw)
    return raw if isinstance(raw, list) else []


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
        sim_mode: str = "off",
        sim_agents: int = 0,
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
        # Population-Sim (additional, opt-in). Default off — the main flow is untouched.
        self.sim_mode = str(sim_mode or "off").strip().lower()
        # How many synthetic voices to simulate (FE slider 10-100; 0 → env default). Clamped.
        self.sim_agents = max(10, min(100, int(sim_agents or _SIM_PERSONAS)))
        self._sim_report: Optional[str] = None       # folded into the synthesis when present
        self._sim_payload: Optional[Dict[str, Any]] = None  # emitted to the FE as sim_report
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
        bucket: str = "director", schema: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """One Groq chat call. Retries a 400 (malformed tool-call generation) once
        at a lower temperature per Groq's guidance. Returns the message dict or
        None on a hard failure (the caller treats None as 'stop')."""
        key = _groq_key()
        if not key:
            log.error("[hyper-engine] no Groq API key configured")
            return None
        # force_text: OMIT tools AND flatten the tool-call transcript to plain text.
        # gpt-oss's harmony decoder, primed by assistant.tool_calls/role:tool messages,
        # keeps emitting tool calls on a no-tools call → repeated 400 "Tool choice is
        # none, but model called a tool"; removing the structure (not just the tools) is
        # what actually stops it.
        msgs = _flatten_for_text(messages) if force_text else messages
        body: Dict[str, Any] = {"model": model or self.director_model, "messages": msgs, "temperature": temp}
        if tools and not force_text:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        elif schema is not None:
            # Structured output (the gather PLAN): a JSON-schema response, NOT native
            # tool-calling — sidesteps the gpt-oss harmony tool-call glitch entirely.
            body["response_format"] = {"type": "json_schema",
                                       "json_schema": {"name": "gather_plan", "schema": schema, "strict": True}}
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
            # Non-Google → discover the connector's read tools via the bridge (cached:
            # the cold inspect is ~20s and was stalling every turn at run() start).
            raw = await _inspect_connector_tools(norm, user_id=self.user_id, org_id=self.org_id)
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
        return (
            "You are the facilitator of a HIVEMIND hyperagent room — sentinel agents that live inside the "
            "company brain and grow smarter over time. Your team: " + roster + "." + goal + tmpl + "\n"
            "FORMAT THE DELIVERABLE FOR QUALITY:\n"
            "• Lead with the answer / recommendation up front, then support it.\n"
            "• Structure with '## <Section>' headings; '- ' bullets for lists, '1. ' for ordered steps.\n"
            "• **Bold** every key term, name, figure, date, and decision.\n"
            "• For ANY comparative / numeric / cost / options / schedule data, USE A REAL MARKDOWN TABLE "
            "(a header row, a '|---|---|' rule line, then data rows).\n"
            "• VISUALS / INFOGRAPHICS — when a TIMELINE/ROADMAP, FLOW/PROCESS, ARCHITECTURE, SEQUENCE, or "
            "DISTRIBUTION would be clearer as a diagram, include ONE fenced mermaid block. Emit it EXACTLY "
            "as: a line with ```mermaid, then the diagram on ITS OWN lines (gantt | flowchart TD | "
            "sequenceDiagram | pie), then a line with ```. It MUST be valid mermaid with REAL newlines "
            "(never collapse to one line, never use single backticks): quote labels containing spaces/colons, "
            "use 'dateFormat YYYY-MM' for a gantt, 'flowchart TD' with 'A[\"Label\"] --> B[\"Label\"]' for a "
            "flow. Use a diagram ONLY where it genuinely adds clarity (at most one or two), never for prose.\n"
            "• If the deliverable is a document, begin with '# <specific Title>' (NOT the room goal); if an "
            "email, begin with 'Subject:'; if a question, give the direct grounded answer.\n"
            "• Ground EVERY specific in the gathered context; never invent facts, names, numbers, or links; "
            "flag anything you cannot verify as UNVERIFIED and collect open items under a short "
            "'## Gaps to confirm'.\n"
            "• When a debate happened, close with a one-line synthesis citing who argued what.\n"
            "• Publish-ready content only — no process narration, no placeholders, no fabricated URLs."
        )

    # ── plan → parallel-gather → synth (the fast path) ────────────────
    async def _plan_gather(self) -> Dict[str, Any]:
        """ONE structured-output call that plans the gather: which company-brain recalls,
        which connector reads, whether web + debate are needed. JSON schema, NOT native
        tool-calling — reliable on gpt-oss + a single round-trip (replaces the old 15-call
        sequential agentic loop)."""
        conn = list(self._connector_routes.keys())
        conn_line = (f"Connector READ tools available (use these EXACT names): {conn}."
                     if conn else "No external connectors are connected.")
        web_line = ("Web search IS available (external/public facts only)." if self._web_budget > 0
                    else "Web search is NOT available.")
        schema = {
            "type": "object",
            "properties": {
                "recall_queries": {"type": "array", "items": {"type": "string"}},
                "connector_calls": {"type": "array", "items": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}, "args_json": {"type": "string"}},
                    "required": ["name", "args_json"], "additionalProperties": False}},
                "web_query": {"type": ["string", "null"]},
                "needs_debate": {"type": "boolean"},
            },
            "required": ["recall_queries", "connector_calls", "web_query", "needs_debate"],
            "additionalProperties": False,
        }
        sysp = (
            "You plan the GATHER step for a HIVEMIND room turn. " + conn_line + " " + web_line + " "
            "Output a JSON gather plan:\n"
            "- recall_queries: 1-3 SHORT focused company-brain searches, one per distinct entity/topic in the "
            "task (fewer, sharper beats many).\n"
            "- connector_calls: reads from the listed connector tools. Each item is {name, args_json} where "
            "args_json is a JSON STRING of the tool's arguments, e.g. {\"name\":\"notion__notion-search\","
            "\"args_json\":\"{\\\"query\\\":\\\"HIVEMIND Amar\\\"}\"}. ONLY listed names; [] if none help.\n"
            "- web_query: a single query ONLY for genuinely EXTERNAL/public facts the company brain would not "
            "hold; otherwise null.\n"
            "- needs_debate: true ONLY if the task needs a decision, judgment, trade-off, or genuine discussion; "
            "false for a pure lookup / factual answer."
        )
        user = f"ROOM GOAL: {self.room_goal or '(none)'}\nTASK: {self.user_message}"
        msg = await self._groq([{"role": "system", "content": sysp}, {"role": "user", "content": user}],
                               model=self.director_model, temp=0.3, schema=schema, bucket="director")
        self.director_iters.append(self._last_tok)
        try:
            plan = json.loads((msg or {}).get("content") or "{}")
        except Exception:  # noqa: BLE001
            plan = {}
        if not isinstance(plan, dict):
            plan = {}
        rq = [q for q in (plan.get("recall_queries") or []) if isinstance(q, str) and q.strip()][:3]
        plan["recall_queries"] = rq or [(self.user_message or self.room_goal or "")[:200]]
        ccs: List[Dict[str, Any]] = []
        for c in (plan.get("connector_calls") or []):
            if not (isinstance(c, dict) and c.get("name") in self._connector_routes):
                continue
            try:
                a = json.loads(c.get("args_json") or "{}")
            except Exception:  # noqa: BLE001
                a = {}
            ccs.append({"name": c["name"], "args": a if isinstance(a, dict) else {}})
        plan["connector_calls"] = ccs[:4]
        wq = plan.get("web_query")
        plan["web_query"] = wq if (isinstance(wq, str) and wq.strip() and self._web_budget > 0) else None
        plan["needs_debate"] = bool(plan.get("needs_debate"))
        log.info("[hyper-engine] plan recalls=%d connectors=%d web=%s debate=%s",
                 len(plan["recall_queries"]), len(plan["connector_calls"]),
                 bool(plan["web_query"]), plan["needs_debate"])
        return plan

    async def _gather_one(self, fn: str, args: Dict[str, Any]) -> None:
        try:
            await self._emit_tool_start(fn, args)
            await self._exec(fn, args)
        except Exception as exc:  # noqa: BLE001 — one failed gather never fails the turn
            log.warning("[hyper-engine] gather %s failed: %s", fn, exc)

    async def _run_gather(self, plan: Dict[str, Any]) -> int:
        """Run every planned recall / connector read / web search CONCURRENTLY — gather
        wall-time is the slowest single call, not the sum of 7 sequential ones."""
        tasks: List[Awaitable[None]] = []
        for q in plan["recall_queries"]:
            tasks.append(self._gather_one("recall", {"query": q, "max": 6}))
        for c in plan["connector_calls"]:
            tasks.append(self._gather_one(c["name"], dict(c.get("args") or {})))
        if plan["web_query"]:
            tasks.append(self._gather_one("web_search", {"query": plan["web_query"]}))
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        return len(tasks)

    async def _synthesize(self, forced_debate: bool, transcript_json: str) -> str:
        """Write the final deliverable from the gathered board (+ debate). Clean context
        on the synth model — no tool-call transcript → no harmony glitch, full quality."""
        board = "\n".join(self.blackboard)[:6000] or "(no grounded facts were gathered)"
        debate_ctx = (f"\n\nThe room DEBATED this — transcript:\n{transcript_json}\nCite who argued what."
                      if forced_debate else "")
        # Additional: a population simulation's report (if it ran) is folded in so the final
        # deliverable reflects the simulated stakeholder population — not just the room.
        sim_ctx = (f"\n\nA POPULATION SIMULATION of synthetic stakeholder voices produced this report — "
                   f"incorporate its consensus + fault lines where relevant:\n{self._sim_report[:2500]}"
                   if self._sim_report else "")
        sysp = (self._system_prompt() + "\n\nYou are now WRITING THE FINAL DELIVERABLE from the gathered "
                "context below — publish-ready content only, plain text, no tool calls, no process narration, "
                "no placeholders. Real markdown tables where they help. Ground every specific in the context; "
                "flag anything unverifiable as UNVERIFIED.")
        user = (f"TASK: {self.user_message}\n\nGATHERED CONTEXT (the room's shared board):\n{board}{debate_ctx}{sim_ctx}\n\n"
                "Write the final, publish-ready deliverable now.")
        msg = await self._groq([{"role": "system", "content": sysp}, {"role": "user", "content": user}],
                               force_text=True, model=self.synth_model, bucket="synth")
        self.director_iters.append(self._last_tok)
        return (msg or {}).get("content") or ""

    # ── Population-Sim (ADDITIONAL, opt-in) ───────────────────────────
    async def _groq_fb(self, messages: List[Dict[str, Any]], models: List[str], **kw: Any) -> Optional[Dict[str, Any]]:
        """Try each model until one returns usable content — the sim's rate-limit fallback
        (8b → gpt-oss-20b → 70b). Metered under bucket 'sim'."""
        msg = None
        for m in models:
            msg = await self._groq(messages, model=m, bucket="sim", **kw)
            if msg and ((msg.get("content") or "").strip()):
                return msg
        return msg

    async def _sim_ontology(self, topic: str, ctx: str) -> List[Dict[str, str]]:
        sysp = ("Design the ONTOLOGY for a social-opinion simulation: the distinct TYPES of voices that "
                "would realistically weigh in on the topic (stakeholders/archetypes — supporters, skeptics, "
                "domain experts, investors, regulators, builders, journalists, affected end-users, "
                "competitors). Maximize coverage of the opinion space; ground in the context. "
                'Return ONLY JSON: {"entity_types":[{"name":str,"description":str,"typical_stance":str}]}')
        user = f"TOPIC: {topic}\n\nCONTEXT:\n{ctx}\n\nDesign {_SIM_TYPES} distinct voice-types."
        msg = await self._groq_fb([{"role": "system", "content": sysp}, {"role": "user", "content": user}],
                                  [_SIM_AGENT_MODEL] + _SIM_FALLBACKS, temp=0.7)
        data = _parse_json_loose((msg or {}).get("content") or "") or {}
        raw = data.get("entity_types") if isinstance(data, dict) else (data if isinstance(data, list) else [])
        types = [{"name": str(t.get("name"))[:50], "description": str(t.get("description") or "")[:160],
                  "typical_stance": str(t.get("typical_stance") or "")[:120]}
                 for t in (raw or []) if isinstance(t, dict) and t.get("name")]
        return types[:_SIM_TYPES] or [{"name": "Stakeholder", "description": "a general participant", "typical_stance": "mixed"}]

    async def _sim_cast(self, topic: str, ctx: str, ontology: List[Dict[str, str]], total: int) -> List[Dict[str, str]]:
        n_types = max(1, len(ontology))
        per, rem = divmod(total, n_types)

        async def batch(etype: Dict[str, str], k: int) -> List[Dict[str, str]]:
            if k <= 0:
                return []
            sysp = (f"Create {k} DISTINCT personas of the voice-type \"{etype['name']}\" "
                    f"({etype['description']}; tends to: {etype['typical_stance']}) for a social simulation. "
                    "They share the type but DIFFER (names, background, stance shade, voice). "
                    'Return ONLY JSON: {"personas":[{"name":str,"stance":str,"background":str,"voice":str,'
                    '"memory":str(prior take on this topic)}]}')
            user = f"TOPIC: {topic}\n\nCONTEXT:\n{ctx[:1800]}\n\nCreate {k} distinct '{etype['name']}' personas."
            msg = await self._groq_fb([{"role": "system", "content": sysp}, {"role": "user", "content": user}],
                                      [_SIM_AGENT_MODEL] + _SIM_FALLBACKS, temp=0.9)
            data = _parse_json_loose((msg or {}).get("content") or "") or {}
            raw = data.get("personas") if isinstance(data, dict) else (data if isinstance(data, list) else [])
            return [{"name": str(p["name"])[:40], "role": etype["name"], "stance": str(p.get("stance") or "")[:120],
                     "background": str(p.get("background") or "")[:240], "voice": str(p.get("voice") or "")[:120],
                     "memory": str(p.get("memory") or "")[:240]}
                    for p in (raw or []) if isinstance(p, dict) and p.get("name")]

        quotas = [per + (1 if i < rem else 0) for i in range(n_types)]
        batches = await asyncio.gather(*[batch(t, q) for t, q in zip(ontology, quotas)], return_exceptions=True)
        cast: List[Dict[str, str]] = []
        for res in batches:
            if isinstance(res, list):
                cast.extend(res)
        return cast

    async def _sim_burst(self, topic: str, ctx: str, cast: List[Dict[str, str]], sem: asyncio.Semaphore
                         ) -> List[Dict[str, Any]]:
        async def one(p: Dict[str, str]) -> Optional[Dict[str, Any]]:
            sysp = (f"You are {p['name']}, a {p['role']}. Background: {p['background']} Stance: {p['stance']}. "
                    f"Voice: {p['voice']}. Your prior take: {p['memory']}. Stay fully IN CHARACTER.")
            user = (f"TOPIC: {topic}\n\nSHARED CONTEXT (ground your take in it):\n{ctx[:2000]}\n\n"
                    "Post your view in-character — one sharp, specific, grounded take (2-3 sentences), then on a "
                    "NEW final line exactly: SENTIMENT: positive | negative | neutral (your overall sentiment "
                    "toward the proposal/topic). No preamble.")
            async with sem:
                msg = await self._groq_fb([{"role": "system", "content": sysp}, {"role": "user", "content": user}],
                                          [_SIM_AGENT_MODEL] + _SIM_FALLBACKS, temp=0.7)
            txt = (msg or {}).get("content") or ""
            if not txt.strip():
                return None
            m = re.search(r"sentiment:\s*(positive|negative|neutral)", txt, re.IGNORECASE)
            sentiment = m.group(1).lower() if m else "neutral"
            clean = re.sub(r"\n*\s*sentiment:\s*(positive|negative|neutral)\s*$", "", txt,
                           flags=re.IGNORECASE).strip() or txt
            return {"name": p["name"], "role": p["role"], "stance": p["stance"],
                    "text": clean, "sentiment": sentiment}

        results = await asyncio.gather(*[one(p) for p in cast], return_exceptions=True)
        return [r for r in results if isinstance(r, dict) and r.get("text")]

    async def _sim_report_call(self, topic: str, ontology: List[Dict[str, str]], posts: List[Dict[str, Any]]) -> str:
        roles = Counter(p["role"] for p in posts)
        sample = "\n".join(f"- [{p['name']} · {p['role']} · {p['stance']}] {p['text'][:200]}" for p in posts[:50])
        digest = {"n_voices": len(posts), "role_distribution": dict(roles.most_common(12)),
                  "voice_types": [t["name"] for t in ontology]}
        sysp = ("You are the lead analyst writing the report on a large-scale opinion simulation — a synthetic "
                "population debated a question. Write a HIGH-LEVEL, decision-grade report:\n"
                "1. **Executive read** — the net of what the population thinks.\n"
                "2. **Consensus** — where they converge (+ which factions).\n"
                "3. **Fault lines** — the real disagreements (a markdown table: faction vs position).\n"
                "4. **Strongest argument per major faction.**\n"
                "5. **Net signal + open gaps.**\nBe specific, no fluff, no process narration.")
        user = (f"QUESTION: {topic}\n\nDIGEST: {json.dumps(digest, ensure_ascii=False)}\n\n"
                f"REPRESENTATIVE VOICES ({min(50, len(posts))} of {len(posts)}):\n{sample}\n\nWrite the report.")
        msg = await self._groq_fb([{"role": "system", "content": sysp}, {"role": "user", "content": user}],
                                  [self.synth_model] + _SIM_FALLBACKS, temp=0.4, force_text=True)
        return ((msg or {}).get("content") or "").strip()

    async def _population_sim(self, topic: str) -> Optional[Dict[str, Any]]:
        """ontology → population → parallel burst → strong-model report. Bounded + fully wrapped —
        any failure returns None and the MAIN turn proceeds untouched (additive guarantee)."""
        try:
            ctx = "\n".join(self.blackboard)[:3000] or (self.room_goal or topic)
            sem = asyncio.Semaphore(_SIM_CONCURRENCY)
            await self.emit({"t": "typing", "agent": "swarm",
                             "note": f"Simulating a population of ~{self.sim_agents} voices…"})
            ontology = await self._sim_ontology(topic, ctx)
            cast = await self._sim_cast(topic, ctx, ontology, self.sim_agents)
            if len(cast) < 3:
                log.warning("[hyper-engine] population-sim: too few personas (%d) — skipping", len(cast))
                return None
            posts = await self._sim_burst(topic, ctx, cast, sem)
            if not posts:
                return None
            report = await self._sim_report_call(topic, ontology, posts)
            if not report:
                return None
            payload = {"report": report, "ontology": [t["name"] for t in ontology],
                       "n_personas": len(cast), "n_posts": len(posts),
                       "role_mix": dict(Counter(p["role"] for p in posts).most_common(12)),
                       # sentiment tally (positive/negative/neutral) → FE gauge + distribution.
                       "sentiment_tally": dict(Counter(p.get("sentiment", "neutral") for p in posts)),
                       # ALL posts (capped) so the FE popup shows the whole simulation, not a teaser.
                       "posts": [{"name": p["name"], "role": p["role"], "stance": p.get("stance", ""),
                                  "sentiment": p.get("sentiment", "neutral"), "text": p["text"][:400]}
                                 for p in posts[:120]],
                       "sample": [{"name": p["name"], "role": p["role"], "text": p["text"][:240]} for p in posts[:8]]}
            log.info("[hyper-engine] population-sim ok: %d personas, %d posts, report %d chars",
                     len(cast), len(posts), len(report))
            return payload
        except Exception as exc:  # noqa: BLE001 — additive: never break the main turn
            log.warning("[hyper-engine] population-sim failed (skipped): %s", exc)
            return None

    async def run(self) -> Dict[str, Any]:
        t0 = time.time()
        # Instant feedback from t=0: connector-tool init + the first model call run
        # with no event of their own, so without this the FE sits idle (only the
        # router showing) until the first tool fires. One typing note so the room
        # never looks frozen right after the query is sent.
        _lead = self.participants[0].get("slug") if self.participants else "director"
        await self.emit({"t": "typing", "agent": _lead, "note": "Reading the goal and gathering context…"})
        await self._init_connector_tools()  # register toggled connectors as read tools
        # PHASE 1 — STRUCTURED GATHER PLAN. One JSON-schema call (NOT native tool-calling)
        # decides what to recall / which connectors to read / web + debate. Replaces the
        # old 15-round sequential agentic loop: one round-trip, no harmony tool glitch.
        plan = await self._plan_gather()
        # PHASE 2 — PARALLEL GATHER. Every recall + connector read + web runs CONCURRENTLY.
        tool_calls_made = await self._run_gather(plan)
        # PHASE 2.5 — POPULATION SIM (ADDITIONAL, opt-in). Runs on the gathered context, emits a
        # report the FE shows as a hideable popup, and feeds that report into the synthesis. Fully
        # wrapped — a failure just skips it; the main turn (debate + synth) is never affected.
        if self.sim_mode in _SIM_ON:
            self._sim_payload = await self._population_sim(self.room_goal or self.user_message or "")
            if self._sim_payload:
                self._sim_report = self._sim_payload.get("report")
                await self.emit({"t": "sim_report", **self._sim_payload})
        # PHASE 3 — DEBATE (the multi-agent product). Convene only when the plan judges the
        # task needs a decision/judgment/discussion — a pure lookup skips it (faster, on-point).
        forced_debate = False
        transcript_json = ""
        if len(self.participants) >= 2 and plan.get("needs_debate"):
            try:
                topic = (self.room_goal or self.user_message or "")[:400]
                transcript_json = await self._debate(topic, self.debate_max_rounds)
                forced_debate = True
            except Exception as exc:  # noqa: BLE001
                log.warning("[hyper-engine] debate failed: %s", exc)
        # PHASE 4 — STRONG-MODEL SYNTHESIS from the gathered board + debate. Clean context
        # (no tool-call transcript) on the synth model → no harmony glitch, full quality.
        final_text = await self._synthesize(forced_debate, transcript_json)
        if not final_text:
            # Every synthesis attempt failed — never return empty at the emit boundary.
            final_text = ("(The room could not produce a grounded answer this turn — "
                          "the model was unreachable. Please retry, or add more context.)")

        await self.emit({"t": "line", "agent": (self.participants[0].get("slug") if self.participants else "director"),
                         "kind": "synthesis", "content": final_text})
        log.info("[hyper-engine] done plan+gather=%d rounds=%d tokens=%d ms=%d gather=%d tok_by=%s iters=%s",
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
            "sim_report": self._sim_payload,  # the population-sim dashboard (None unless sim_mode on)
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
    sim_mode: str = "off",
    sim_agents: int = 0,
) -> Dict[str, Any]:
    """Run one room turn through the single-director engine. Returns
    {cost_tokens, final_text, transcript, gather_count, tool_calls, sim_report}."""
    director = Director(
        user_message=user_message, user_id=user_id, org_id=org_id, project_id=project_id,
        participants=participants, room_template=room_template, room_goal=room_goal,
        enabled_connectors=enabled_connectors, emit=emit,
        director_model=director_model, persona_model=persona_model, synth_model=synth_model,
        max_iters=max_iters, sim_mode=sim_mode, sim_agents=sim_agents,
    )
    return await director.run()
