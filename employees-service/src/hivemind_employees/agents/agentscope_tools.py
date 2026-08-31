"""HIVEMIND tools registered into an AgentScope Toolkit.

AgentScope's `Toolkit.register_tool_function(fn)` consumes plain Python
functions — type-annotated, with docstrings used for the tool schema.
We close each function over the employee's HIVEMIND API key so every
tool call is authenticated as that employee (same model as the slackagents
tools that already ship in `tools.py`).

Tools route through HIVEMIND core's `/api/employees/slack-action`,
`/api/recall`, and `/api/memories` endpoints so the policy gate +
audit + auto-ingest pipeline stays centralized.
"""

import contextvars
import json
import logging
import os
import re
import uuid
from typing import Any, Dict, List, Optional

import httpx
from agentscope.message._message_block import TextBlock
from agentscope.tool import ToolResponse, Toolkit

from ..hivemind_client import list_prospects_emulated, save_prospects_bulk_emulated

log = logging.getLogger(__name__)

HIVEMIND_TIMEOUT_S = 30.0


def _tool_response(payload: object) -> ToolResponse:
    text = json.dumps(payload)
    return ToolResponse(
        content=[TextBlock(type="text", text=text)],
        metadata=payload if isinstance(payload, dict) else {"value": payload},
    )


def _tool_response_text(text: str, metadata: Optional[dict] = None) -> ToolResponse:
    return ToolResponse(
        content=[TextBlock(type="text", text=text)],
        metadata=metadata or {},
    )


# ─── Phase 4 — pre-acting write-approval gate ──────────────────────────
# Side-effectful connector writes (docs_create/append, MCP non-read calls,
# and any future gmail.send/slack/CRM/PR) are HELD when the turn's policy is
# "ask": the tool records the proposed action and returns a "pending" result
# WITHOUT firing the side effect. Reads stay free. The orchestrator drains the
# queued writes after the turn and surfaces an approval card; the user approves
# via /internal/hyper/approve, which replays the bridge call.
#
# The orchestrator arms these contextvars per turn (begin_turn_write_gate).
# AgentScope calls sync tool functions directly in the turn coroutine, and the
# pending list is set once up-front as a shared mutable object, so appends from
# fanned-out child tasks (which copy the context) still land in the same list.
_WRITE_POLICY: "contextvars.ContextVar[str]" = contextvars.ContextVar(
    "hyper_write_policy", default="auto"
)
_PENDING_WRITES: "contextvars.ContextVar[Optional[list]]" = contextvars.ContextVar(
    "hyper_pending_writes", default=None
)

# ─── Consensus gate: produce the OUTPUT only after the swarm agrees ─────
# The user rule: "before touching anything to do output, make sure the swarm
# has approved the swarm intelligence so far and then decided to move forward."
# Output-producing tools (docs/sheets create+append, gmail_send) are HELD while
# the room is still debating; the orchestrator calls unlock_output() at the
# synthesis step (consensus reached), after which the agreed artifact is
# produced once. Default True so non-room toolkits are unaffected.
_OUTPUT_UNLOCKED: "contextvars.ContextVar[bool]" = contextvars.ContextVar(
    "hyper_output_unlocked", default=True
)
# Artifacts produced this turn (docs/sheets/etc.) — drained by the orchestrator
# to emit `connector_logo` "view in new tab" events to the FE.
_TURN_ARTIFACTS: "contextvars.ContextVar[Optional[list]]" = contextvars.ContextVar(
    "hyper_turn_artifacts", default=None
)
_AGENT_TOOL_RECEIPTS: "contextvars.ContextVar[Optional[list]]" = contextvars.ContextVar(
    "hyper_agent_tool_receipts", default=None
)
# P0 provenance: armed per turn by the orchestrator so every fact an agent saves to
# the company brain carries WHERE it came from (turn/room/org) — the audit trail that
# makes the closed-loop OS traceable. Default None → provenance fields are simply omitted.
_TURN_PROVENANCE: "contextvars.ContextVar[Optional[dict]]" = contextvars.ContextVar(
    "hyper_turn_provenance", default=None
)
_PLACES_SEARCH_COUNT: "contextvars.ContextVar[int]" = contextvars.ContextVar(
    "hq_places_search_count", default=0
)
_PLACES_SEARCH_TOTAL: "contextvars.ContextVar[int]" = contextvars.ContextVar(
    "hq_places_search_total", default=0
)
# The real CRM lead-persist path (save_prospects_bulk_emulated →
# /internal/hyper/prospects/bulk) requires a turn_id to resolve which Room/
# tenant owns the write. The debate pipeline (engine.py) always has one; the
# agentic task engine's tools are built once per turn too, so the caller sets
# this at the start of that turn. None → save_prospect/places_search's persist
# step reports the gap honestly instead of guessing a turn_id.
_CURRENT_TURN_ID: "contextvars.ContextVar[Optional[str]]" = contextvars.ContextVar(
    "hyper_current_turn_id", default=None
)


def set_current_turn_id(turn_id: Optional[str]) -> None:
    """Arm the turn_id used by real CRM lead-persist calls this turn."""
    _CURRENT_TURN_ID.set(str(turn_id) if turn_id else None)


# Fine-grained, per-action-type standing approval rules (Grok-Bot-style
# "always allow: create a doc" while a different action still asks) — the gap
# vs. the coarse per-room autoSend toggle. Loaded ONCE per turn (async DB read
# happens before the agent's tool loop starts, same as _CURRENT_TURN_ID) so
# the sync write-gate (_gate_write, called from inside sync tool functions)
# can check it without an async round-trip. Empty dict = no rules configured
# for this org = existing ask/deny policy applies exactly as before.
_APPROVAL_RULES: "contextvars.ContextVar[Dict[str, str]]" = contextvars.ContextVar(
    "hyper_approval_rules", default={}
)


def set_approval_rules(rules: Optional[Dict[str, str]]) -> None:
    """Arm this turn's org-level fine-grained approval rules."""
    _APPROVAL_RULES.set(dict(rules) if rules else {})


def get_places_search_count() -> int:
    return int(_PLACES_SEARCH_COUNT.get() or 0)


def get_places_search_total() -> int:
    return int(_PLACES_SEARCH_TOTAL.get() or 0)


def set_turn_provenance(turn_id: Optional[str] = None, room_id: Optional[str] = None,
                        org_id: Optional[str] = None, callback_url: Optional[str] = None) -> None:
    """Arm per-turn provenance so save_memory can stamp a fact's origin AND so propose_call
    can reach the control-plane (via callback_url's host) to propose a TARA call. Safe with
    partial info (a missing turn just yields null fields)."""
    _TURN_PROVENANCE.set({"turn_id": turn_id, "room_id": room_id, "org_id": org_id,
                          "callback_url": callback_url})


# P0 actionable-gate: only durable, actionable facts should enter the company brain.
# HYPER_PROVENANCE_GATE ∈ {off, log, enforce}. Default 'log' (SHADOW — records what it
# WOULD reject without blocking, so the gate can be tuned on real traffic before it is
# flipped to 'enforce'). This keeps the live room flow un-spoiled until a human enables it.
_ACTIONABLE_MIN_CHARS = int(os.environ.get("HYPER_MIN_FACT_CHARS", "15") or 15)


def _actionable_verdict(title: str, content: str):
    """Is this fact worth persisting? Conservative heuristic — rejects empty/near-empty
    content and bare clarifying questions (the chatter the gate exists to keep out).
    Returns (ok: bool, reason: str). Intentionally lenient: better to keep a marginal
    fact than to drop a real one; 'enforce' is opt-in."""
    c = (content or "").strip()
    if len(c) < _ACTIONABLE_MIN_CHARS:
        return False, f"content too short (<{_ACTIONABLE_MIN_CHARS} chars)"
    if c.endswith("?") and len(c) < 80 and "." not in c:
        return False, "reads as a question, not a durable fact"
    return True, "ok"


# Outward sends that ALWAYS need HITL approval even after consensus (they leave
# the org). Internal artifacts (docs/sheets) run without HITL once consensus is
# reached. gmail_send + MCP non-read calls are outward.
_OUTWARD_SENDS = ("gmail_send",)

# Read-intent name hints — MCP tools whose name matches are treated as reads
# (free); everything else on a connector is a potential write (gated).
_READ_HINTS = (
    "search", "list", "get", "read", "fetch", "query", "find", "inspect",
    "lookup", "describe", "view", "show", "preview", "summar", "count", "stat",
)


def _looks_like_read(name: str) -> bool:
    n = (name or "").lower()
    return any(h in n for h in _READ_HINTS)


def begin_turn_write_gate(policy: str) -> None:
    """Arm the write/consensus gates for the current turn.

    ``deny`` blocks every write, ``ask`` queues writes, ``auto`` preserves the
    ordinary Room policy (outbound sends still ask), and ``authorized`` means an
    exact upstream authority checkpoint already approved this turn.
    Output stays LOCKED until the orchestrator reaches consensus (synthesis)."""
    _WRITE_POLICY.set(policy if policy in ("deny", "ask", "auto", "authorized") else "ask")
    _PENDING_WRITES.set([])
    _OUTPUT_UNLOCKED.set(False)
    _TURN_ARTIFACTS.set([])


def unlock_output() -> None:
    """Consensus reached — let the synthesis step produce the agreed output."""
    _OUTPUT_UNLOCKED.set(True)


def reset_turn_outputs() -> None:
    """Goalkeeper rework — discard the prior round's queued writes + produced
    artifacts and re-lock output, so the NEXT round produces a fresh deliverable
    instead of `_produce_output`'s idempotency guard short-circuiting on the
    stale (recon-rejected) draft. Does NOT touch the write/consensus policy."""
    _PENDING_WRITES.set([])
    _TURN_ARTIFACTS.set([])
    _OUTPUT_UNLOCKED.set(False)


def drain_pending_writes() -> List[Dict[str, Any]]:
    """Return (a copy of) the writes queued for approval this turn."""
    pend = _PENDING_WRITES.get()
    return list(pend) if isinstance(pend, list) else []


def drain_artifacts() -> List[Dict[str, Any]]:
    """Return (a copy of) the artifacts (docs/sheets/...) produced this turn."""
    arts = _TURN_ARTIFACTS.get()
    return list(arts) if isinstance(arts, list) else []


def begin_agent_tool_receipts() -> None:
    """Start an assignment-scoped receipt ledger in the current async context."""
    _AGENT_TOOL_RECEIPTS.set([])


def drain_agent_tool_receipts() -> List[Dict[str, Any]]:
    receipts = _AGENT_TOOL_RECEIPTS.get()
    return list(receipts) if isinstance(receipts, list) else []


def _record_agent_tool_receipt(receipt: Dict[str, Any]) -> None:
    receipts = _AGENT_TOOL_RECEIPTS.get()
    if receipts is None:
        receipts = []
        _AGENT_TOOL_RECEIPTS.set(receipts)
    receipts.append(dict(receipt))


def queue_email_approval(to: str, subject: str, draft_id: str, url: str = "",
                         body_md: str = "") -> str:
    """Orchestrator-side: record a produced draft as an artifact AND queue its
    send for the user's approval. Used as a deterministic fallback when the
    agents composed an email but did not fire gmail_send themselves — so an
    email turn ALWAYS yields a draft + approval card. Returns the approval_id.
    body_md (the draft's markdown) rides the artifact + approval events so the
    FE can PREVIEW / edit / one-click-send in-app without opening Gmail."""
    _record_artifact("gmail", url or "https://mail.google.com/mail/u/0/#drafts",
                     title=subject or "Draft", label="Review draft", body_md=body_md)
    approval_id = uuid.uuid4().hex[:12]
    rec = {
        "approval_id": approval_id,
        "label": "gmail_send",
        "summary": f"Send email to {to} — “{subject}”",
        "bridge": "google",
        "descriptor": {"tool": "gmail_send_draft", "arguments": {"draftId": draft_id}},
        "to": to, "subject": subject, "body_md": str(body_md or "")[:20000],
    }
    pend = _PENDING_WRITES.get()
    if isinstance(pend, list):
        pend.append(rec)
    return approval_id


def _consensus_gate(label: str) -> Optional[ToolResponse]:
    """Hold an output-producing tool until the swarm has reached consensus.
    Returns a 'hold' ToolResponse while locked, else None (proceed)."""
    if _OUTPUT_UNLOCKED.get():
        return None
    return _tool_response_text(
        f"⏸ HOLD — '{label}' was NOT run. The team has not finished reaching "
        f"consensus yet. Do NOT produce the output now: keep contributing, "
        f"challenging, and peer-reviewing. The agreed result is produced ONCE at "
        f"the synthesis step, after the swarm aligns.",
        metadata={"status": "awaiting_consensus", "label": label},
    )


def _record_artifact(connector: str, url: str, title: str = "", label: str = "",
                     body_md: str = "") -> None:
    """Record a produced artifact (doc/sheet) so the orchestrator can emit a
    `connector_logo` 'view in new tab' event to the FE. After the FIRST artifact
    lands, RE-LOCK output so the turn produces ONE high-quality deliverable
    rather than a pile of near-duplicate drafts from racing agents/retries.
    body_md: the artifact's textual content (bounded) → in-app FE preview."""
    arts = _TURN_ARTIFACTS.get()
    if isinstance(arts, list) and url:
        arts.append({"connector": connector, "url": url, "title": title, "label": label,
                     "body_md": str(body_md or "")[:20000]})
        _OUTPUT_UNLOCKED.set(False)


def record_artifact(connector: str, url: str, title: str = "", label: str = "",
                    body_md: str = "") -> None:
    """Public: orchestrator records a produced doc/sheet artifact (→ connector_logo)."""
    _record_artifact(connector, url, title=title, label=label, body_md=body_md)


def _artifact_url(payload: object) -> str:
    """Pull a doc/sheet URL out of a bridge ToolResponse's underlying json."""
    if not isinstance(payload, dict):
        return ""
    res = payload.get("result") if isinstance(payload.get("result"), dict) else payload
    return str((res or {}).get("url") or "") if isinstance(res, dict) else ""


def _gate_write(
    label: str, summary: str, bridge: str, descriptor: dict, force: bool = False
) -> Optional[ToolResponse]:
    """Apply the active turn's write authority before connector execution.

    ``deny`` fails closed without queueing. ``ask`` (or force=True under an
    ordinary Room policy) queues the write for approval. ``authorized`` is used
    only for a checkpoint already approved by HQ and permits that exact turn's
    write without another generic approval prompt.

    return a "pending" ToolResponse WITHOUT executing. Returns None when the
    write may run now. `force` is for outward SENDS (gmail send/reply, trash),
    which ALWAYS require the user's approval regardless of policy. `descriptor`
    carries everything the approve endpoint needs to replay the bridge call.

    Fine-grained per-action rule check runs FIRST, ahead of the coarse turn
    policy: an org can explicitly stand a rule for one action LABEL (e.g.
    always_allow docs_create, always_deny gmail_send) via set_approval_rules.
    No rule for this label = falls through to the existing policy unchanged."""
    rule = _APPROVAL_RULES.get().get(label)
    if rule == "always_deny":
        return _tool_response_text(
            f"⛔ WRITE DENIED — '{label}' was NOT executed. This org has a standing "
            "rule denying this action type. Continue with evidence gathering and "
            "report the blocked write as an exact gap; do not retry it.",
            metadata={"status": "write_denied", "label": label, "reason": "org_approval_rule"},
        )
    if rule == "always_allow":
        return None
    policy = _WRITE_POLICY.get()
    if policy == "deny":
        return _tool_response_text(
            f"⛔ WRITE DENIED — '{label}' was NOT executed. This turn has read-only "
            "authority. Continue with evidence gathering and report the blocked write "
            "as an exact gap; do not retry it.",
            metadata={"status": "write_denied", "label": label},
        )
    if policy == "authorized":
        return None
    if not force and policy != "ask":
        return None
    approval_id = uuid.uuid4().hex[:12]
    rec = {
        "approval_id": approval_id,
        "label": label,
        "summary": summary,
        "bridge": bridge,
        "descriptor": descriptor,
    }
    pend = _PENDING_WRITES.get()
    if isinstance(pend, list):
        pend.append(rec)
    return _tool_response_text(
        f"⏸ APPROVAL REQUIRED — '{label}' was NOT executed. "
        f"Proposed action: {summary}. An approval card has been surfaced to the "
        f"user; this write runs only after they approve. Do NOT retry it — "
        f"continue with the rest of the plan and report this action as pending "
        f"the user's approval.",
        metadata={"status": "pending_approval", "approval_id": approval_id, "label": label},
    )


def execute_pending_write(
    rec: Dict[str, Any], user_id: Optional[str], org_id: Optional[str]
) -> dict:
    """Replay an approved write through the core bridge. Uses the master key +
    emulation headers (the room owner's Nango token is resolved server-side)."""
    bridge = rec.get("bridge")
    descriptor = rec.get("descriptor") or {}
    if bridge == "google":
        path = "/api/connectors/google/exec"
    elif bridge == "mcp":
        path = "/api/connectors/mcp/exec"
    else:
        raise ValueError(f"unknown bridge: {bridge}")
    with _client("", user_id, org_id) as c:
        r = c.post(path, json=descriptor)
        r.raise_for_status()
        return r.json()


def _client(
    api_key: str,
    user_id: Optional[str] = None,
    org_id: Optional[str] = None,
) -> httpx.Client:
    """Build an authenticated HIVEMIND client.

    Preferred path: per-employee scoped api_key (Bearer).
    Fallback (when employee row has no minted key): master key + emulation
    headers (X-HM-User-Id / X-HM-Org-Id) so tools still execute as the
    room owner. Empty-Bearer requests trip httpx 'Illegal header value'.
    """
    effective_key = api_key
    extra_headers: dict[str, str] = {}
    if not effective_key:
        master = (
            os.environ.get("HIVEMIND_MASTER_API_KEY")
            or os.environ.get("API_MASTER_KEY")
            or ""
        )
        if master:
            effective_key = master
            if user_id:
                extra_headers["X-HM-User-Id"] = user_id
            if org_id:
                extra_headers["X-HM-Org-Id"] = org_id
    base = os.environ.get("HIVEMIND_CORE_URL", "http://hm-core:3000")
    headers = {
        "Authorization": f"Bearer {effective_key}" if effective_key else "",
        "X-API-Key": effective_key,
        "Content-Type": "application/json",
    }
    # Strip empty-value headers — httpx rejects them at request time.
    headers = {k: v for k, v in headers.items() if v}
    headers.update(extra_headers)
    return httpx.Client(
        base_url=base,
        timeout=httpx.Timeout(HIVEMIND_TIMEOUT_S, connect=5.0),
        headers=headers,
    )


def _post_slack_action(
    api_key: str,
    action_type: str,
    payload: dict,
    user_id: Optional[str] = None,
    org_id: Optional[str] = None,
) -> dict:
    with _client(api_key, user_id, org_id) as c:
        r = c.post(
            "/api/employees/slack-action",
            json={"action_type": action_type, "payload": payload},
        )
        r.raise_for_status()
        return r.json()


# Static Personio v2 read-only tools — all reads, no writes; safe for agent use without approval
PERSONIO_STATIC_TOOLS: List[Dict[str, Any]] = [
    {
        "name": "personio_list_employees",
        "description": (
            "List employees from Personio HR. "
            "Returns name, role, department, work email. Read-only."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "updated_since": {
                    "type": "string",
                    "description": "ISO 8601 datetime — only return employees updated after this date",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results (default 50, max 200)",
                },
            },
            "required": [],
        },
    },
    {
        "name": "personio_get_employee",
        "description": (
            "Get a single Personio employee by ID. "
            "Returns name, role, department, work email. Read-only."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "id": {"type": "integer", "description": "Personio employee ID"},
            },
            "required": ["id"],
        },
    },
    {
        "name": "personio_list_departments",
        "description": "List departments from Personio. Read-only.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "personio_list_positions",
        "description": "List job positions/roles from Personio. Read-only.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
]

ATLASSIAN_STATIC_TOOLS: List[Dict[str, Any]] = [
    {
        "name": "atlassian_list_issues",
        "description": "List Jira issues matching a JQL query. Returns summary, status, priority, assignee. Read-only.",
        "parameters": {
            "type": "object",
            "properties": {
                "jql": {"type": "string", "description": "JQL query string (e.g. 'project=ENG AND status=Open')"},
                "limit": {"type": "integer", "description": "Max results (default 50, max 100)"},
            },
            "required": [],
        },
    },
    {
        "name": "atlassian_get_issue",
        "description": "Get full details of a single Jira issue by key (e.g. ENG-123). Read-only.",
        "parameters": {
            "type": "object",
            "properties": {
                "issue_key": {"type": "string", "description": "Jira issue key, e.g. ENG-123"},
            },
            "required": ["issue_key"],
        },
    },
    {
        "name": "atlassian_search_issues",
        "description": "Full-text search across Jira issues. Returns matching issue keys and summaries. Read-only.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Free-text search query"},
                "limit": {"type": "integer", "description": "Max results (default 20)"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "atlassian_list_pages",
        "description": "List Confluence pages in a space. Returns title, url, last modified. Read-only.",
        "parameters": {
            "type": "object",
            "properties": {
                "space_key": {"type": "string", "description": "Confluence space key (e.g. ENG, MARKETING)"},
                "limit": {"type": "integer", "description": "Max results (default 25)"},
            },
            "required": [],
        },
    },
    {
        "name": "atlassian_get_page",
        "description": "Get full content of a Confluence page by ID. Read-only.",
        "parameters": {
            "type": "object",
            "properties": {
                "page_id": {"type": "string", "description": "Confluence page ID"},
            },
            "required": ["page_id"],
        },
    },
]

GDRIVE_STATIC_TOOLS: List[Dict[str, Any]] = [
    {
        "name": "gdrive_list_files",
        "description": "List Google Drive files (Docs, Sheets, text). Returns name, mimeType, modifiedTime, webViewLink. Read-only.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Drive query string (e.g. \"name contains 'budget'\")"},
                "limit": {"type": "integer", "description": "Max results (default 25, max 100)"},
                "page_token": {"type": "string", "description": "Pagination token from previous call"},
            },
            "required": [],
        },
    },
    {
        "name": "gdrive_get_file",
        "description": "Get the text content of a Google Drive file by ID. Read-only.",
        "parameters": {
            "type": "object",
            "properties": {
                "file_id": {"type": "string", "description": "Google Drive file ID"},
            },
            "required": ["file_id"],
        },
    },
    {
        "name": "gdrive_search_files",
        "description": "Full-text search across Google Drive files. Returns matching files with snippets. Read-only.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "limit": {"type": "integer", "description": "Max results (default 20)"},
            },
            "required": ["query"],
        },
    },
]

MICROSOFT_STATIC_TOOLS: List[Dict[str, Any]] = [
    {
        "name": "microsoft_list_emails",
        "description": "List recent Outlook emails. Returns subject, from, date, preview. Read-only.",
        "parameters": {
            "type": "object",
            "properties": {
                "folder": {"type": "string", "description": "Folder name: inbox, sentItems, drafts (default: inbox)"},
                "limit": {"type": "integer", "description": "Max results (default 25, max 100)"},
                "since": {"type": "string", "description": "ISO 8601 datetime — only return emails after this date"},
            },
            "required": [],
        },
    },
    {
        "name": "microsoft_get_email",
        "description": "Get full content of an Outlook email by message ID. Read-only.",
        "parameters": {
            "type": "object",
            "properties": {
                "message_id": {"type": "string", "description": "Outlook message ID"},
            },
            "required": ["message_id"],
        },
    },
    {
        "name": "microsoft_search_emails",
        "description": "Full-text search across Outlook emails. Read-only.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "limit": {"type": "integer", "description": "Max results (default 20)"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "microsoft_list_calendar_events",
        "description": "List upcoming Calendar events from Outlook. Returns title, start, end, attendees. Read-only.",
        "parameters": {
            "type": "object",
            "properties": {
                "days_ahead": {"type": "integer", "description": "How many days ahead to fetch (default 14)"},
                "limit": {"type": "integer", "description": "Max results (default 25)"},
            },
            "required": [],
        },
    },
]

SALESFORCE_STATIC_TOOLS: List[Dict[str, Any]] = [
    {
        "name": "salesforce_list_accounts",
        "description": "List Salesforce Accounts. Returns name, industry, type, website. Read-only.",
        "parameters": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "Max results (default 25, max 100)"},
                "query": {"type": "string", "description": "Optional name filter"},
            },
            "required": [],
        },
    },
    {
        "name": "salesforce_list_contacts",
        "description": "List Salesforce Contacts. Returns name, email, title, account. Read-only.",
        "parameters": {
            "type": "object",
            "properties": {
                "account_id": {"type": "string", "description": "Filter by Salesforce Account ID"},
                "limit": {"type": "integer", "description": "Max results (default 25, max 100)"},
            },
            "required": [],
        },
    },
    {
        "name": "salesforce_list_opportunities",
        "description": "List Salesforce Opportunities. Returns name, stage, amount, close date, account. Read-only.",
        "parameters": {
            "type": "object",
            "properties": {
                "stage": {"type": "string", "description": "Filter by stage name (e.g. Prospecting, Closed Won)"},
                "limit": {"type": "integer", "description": "Max results (default 25, max 100)"},
            },
            "required": [],
        },
    },
    {
        "name": "salesforce_search_records",
        "description": "SOSL full-text search across Salesforce objects (Accounts, Contacts, Opportunities, Cases). Read-only.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search terms"},
                "objects": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Object types to search (default: all). e.g. [\"Account\",\"Contact\"]",
                },
                "limit": {"type": "integer", "description": "Max results per object (default 10)"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "salesforce_get_account",
        "description": "Get full details of a single Salesforce Account by ID. Read-only.",
        "parameters": {
            "type": "object",
            "properties": {
                "account_id": {"type": "string", "description": "Salesforce Account ID"},
            },
            "required": ["account_id"],
        },
    },
]


def _register_connector_tools(
    tk: Toolkit,
    connectors: List[str],
    api_key: str,
    user_id: Optional[str],
    org_id: Optional[str],
    read_only: bool = False,
) -> None:
    """Register each granted 3rd-party connector as an INACTIVE tool GROUP
    (Phase 2). The connector's tools are NOT in the action space until the
    agent activates the group via the `reset_equipped_tools` meta-tool
    (AgentScope-native MCPActivate). This keeps the default action space small
    — so pure reasoning / react-verdict steps see fewer tools and stop wrapping
    plain output as a fake `JSON` tool-call — and the agent only equips a
    connector when its task actually needs it. All calls POST the core bridge,
    which resolves the room owner's Nango token server-side.
    """
    # ── Connector Runtime V1 cutover (plan Phase 6) ──────────────────────
    # When CONNECTOR_RUNTIME_HYPER=true, register connectors through the Core
    # canonical runtime via the stateless MCP gateway (one capability token,
    # native AgentScope HttpStatelessClient — NO per-provider Python). Flag-off
    # (default) → the legacy per-provider path below runs unchanged. On any
    # runtime failure we fall through to the legacy path so a room never loses
    # its connectors.
    if os.getenv("CONNECTOR_RUNTIME_HYPER", "").lower() in ("1", "true", "yes", "on"):
        try:
            from ..connectors.mcp_projection import register_runtime_connectors
            handled = register_runtime_connectors(
                tk, api_key=api_key, user_id=user_id, org_id=org_id,
                connectors=connectors, read_only=read_only,
            )
            if handled:
                # Runtime handled ONLY the connectors it knows (gmail/gdocs/…).
                # Any remaining connectors (e.g. notion/github/linear not yet in
                # the runtime registry) MUST still be registered by the legacy
                # path — never drop a room's connector. Narrow the list and fall
                # through; return only if the runtime covered everything.
                remaining = [c for c in connectors if c not in set(handled)]
                if not remaining:
                    return
                connectors = remaining
        except Exception:
            pass  # any error → full legacy path (connectors unchanged)

    def _register_google(kind: str, read_only: bool = False):
        def _google(tool_name: str, arguments: Optional[dict] = None) -> ToolResponse:
            return _tool_response(_google_json(tool_name, arguments))
        def _google_json(tool_name: str, arguments: Optional[dict] = None) -> dict:
            with _client(api_key, user_id, org_id) as c:
                r = c.post("/api/connectors/google/exec", json={"tool": tool_name, "arguments": arguments or {}})
                r.raise_for_status()
                return r.json()
        if kind == "gmail":
            _gmail_notes_read = (
                "READ (free): gmail_search(query,max), gmail_get(id), gmail_get_thread(threadId), "
                "gmail_list_drafts(max), gmail_list_labels(). Use these to pull live context from "
                "the owner's mailbox; you do NOT have send/draft tools — the room produces any output once."
            )
            _gmail_notes_full = (
                "READ (free): gmail_search(query,max), gmail_get(id), gmail_get_thread(threadId), "
                "gmail_list_drafts(max), gmail_list_labels(). "
                "DRAFT (no approval): gmail_create_draft(to,subject,body,cc,threadId). "
                "ORGANIZE (no approval): gmail_modify(id, addLabelIds, removeLabelIds) — mark read = remove 'UNREAD', archive = remove 'INBOX'. "
                "OUTWARD (always saved as a draft, then needs the user's approval to actually go): "
                "gmail_send(to,subject,body,cc), gmail_reply(threadId,to,subject,body), gmail_trash(id)."
            )
            tk.create_tool_group(
                group_name="gmail",
                description=("Gmail READ for the room owner: search/read/threads (free)."
                             if read_only else
                             "Full Gmail for the room owner: search/read/threads (free), drafts + labels, and send/reply (saved as a draft, then user-approved)."),
                active=False,
                notes=(_gmail_notes_read if read_only else _gmail_notes_full),
            )

            def _recipient_verified(to: str) -> bool:
                """True only if `to` is a REAL address — an org member, or one that
                appears in the room owner's actual Gmail. Blocks fabricated
                addresses (firstname@company.com) at the tool boundary."""
                if not to or "@" not in to:
                    return False
                tol = to.strip().lower()
                try:
                    with _client(api_key, user_id, org_id) as c:
                        om = c.post("/api/org/members", json={"query": to})
                        om.raise_for_status()
                        if any((str(m.get("email", "")).lower() == tol) for m in (om.json().get("members") or [])):
                            return True
                except Exception:  # noqa: BLE001
                    pass
                try:
                    with _client(api_key, user_id, org_id) as c:
                        gr = c.post("/api/connectors/google/exec", json={
                            "tool": "gmail_search", "arguments": {"query": to, "max": 5}})
                        gr.raise_for_status()
                        for m in ((gr.json().get("result") or {}).get("messages") or []):
                            if tol in (str(m.get("from", "")) + str(m.get("to", ""))).lower():
                                return True
                except Exception:  # noqa: BLE001
                    pass
                return False

            def _send_via_draft(label, summary, draft_args):
                """Save a real Gmail DRAFT now (reviewable), then queue approval
                to SEND that draft. The draft is the preview; approve = it goes."""
                held = _consensus_gate(label)
                if held is not None:
                    return held
                _to = draft_args.get("to") or ""
                if _to and not _recipient_verified(_to):
                    return _tool_response_text(
                        f"⛔ '{_to}' is NOT a verified address — it is not an org member and "
                        f"does not appear in the mailbox, so it looks fabricated. Do NOT send "
                        f"to a guessed address. Call org_directory('<name>') to get the real "
                        f"address (it checks the directory AND Gmail), or ask the user. Then retry.",
                        metadata={"status": "unverified_recipient", "to": _to},
                    )
                # Strip fabricated CC addresses (keep only verified ones) so a guessed
                # cc like amar.gadde@brand.com never goes out.
                _cc = draft_args.get("cc") or ""
                if _cc:
                    kept = [a for a in re.split(r"[,;\s]+", _cc) if a and "@" in a and _recipient_verified(a)]
                    draft_args = {**draft_args, "cc": ", ".join(kept)}
                draft = _google_json("gmail_create_draft", draft_args)
                res = draft.get("result") if isinstance(draft.get("result"), dict) else draft
                draft_id = (res or {}).get("draftId")
                url = (res or {}).get("url") or "https://mail.google.com/mail/u/0/#drafts"
                if draft_id:
                    _record_artifact("gmail", url, title=draft_args.get("subject") or "Draft", label="Review draft")
                gated = _gate_write(
                    label, summary, "google",
                    {"tool": "gmail_send_draft", "arguments": {"draftId": draft_id}},
                    force=True,  # outward sends ALWAYS need approval
                )
                if gated is not None:
                    return gated
                return _google("gmail_send_draft", {"draftId": draft_id})

            def gmail_search(query: str = "", max: int = 5) -> ToolResponse:
                return _google("gmail_search", {"query": query, "max": max})
            gmail_search.__doc__ = "Search the room owner's Gmail. query = Gmail search syntax (e.g. 'from:acme newer_than:30d'); max ≤ 20. Returns id/threadId/subject/from/date/snippet."
            def gmail_get(id: str) -> ToolResponse:
                return _google("gmail_get", {"id": id})
            gmail_get.__doc__ = "Fetch one Gmail message in full by id. Returns subject/from/to/date/body."
            def gmail_get_thread(threadId: str) -> ToolResponse:
                return _google("gmail_get_thread", {"threadId": threadId})
            gmail_get_thread.__doc__ = "Fetch a full Gmail thread (all messages) by threadId. Use to read a whole conversation before replying."
            def gmail_list_drafts(max: int = 10) -> ToolResponse:
                return _google("gmail_list_drafts", {"max": max})
            gmail_list_drafts.__doc__ = "List saved Gmail drafts (draftId/subject/to/snippet)."
            def gmail_list_labels() -> ToolResponse:
                return _google("gmail_list_labels", {})
            gmail_list_labels.__doc__ = "List Gmail labels (id + name) — needed for gmail_modify."
            def gmail_create_draft(to: str = "", subject: str = "", body: str = "", cc: str = "", threadId: str = "") -> ToolResponse:
                held = _consensus_gate("gmail_create_draft")
                if held is not None:
                    return held
                if to and not _recipient_verified(to):
                    return _tool_response_text(
                        f"⛔ '{to}' is NOT a verified address (not an org member, not in the "
                        f"mailbox) — it looks fabricated. Call org_directory('<name>') for the "
                        f"real address; never guess one.",
                        metadata={"status": "unverified_recipient", "to": to})
                j = _google_json("gmail_create_draft", {"to": to, "subject": subject, "body": body, "cc": cc, "threadId": threadId})
                _record_artifact("gmail", _artifact_url(j), title=subject or "Draft", label="Review draft")
                return _tool_response(j)
            gmail_create_draft.__doc__ = "Save an email as a Gmail DRAFT (not sent, no approval needed). to/subject/body/cc; threadId for a reply draft. Returns draftId."
            def gmail_modify(id: str, addLabelIds: str = "", removeLabelIds: str = "") -> ToolResponse:
                held = _consensus_gate("gmail_modify")
                if held is not None:
                    return held
                add = [x.strip() for x in (addLabelIds or "").split(",") if x.strip()]
                rem = [x.strip() for x in (removeLabelIds or "").split(",") if x.strip()]
                return _google("gmail_modify", {"id": id, "addLabelIds": add, "removeLabelIds": rem})
            gmail_modify.__doc__ = "Organize a message (no approval). id; addLabelIds/removeLabelIds = comma-separated label ids. Mark read = removeLabelIds='UNREAD'; archive = removeLabelIds='INBOX'."
            def gmail_send(to: str, subject: str, body: str = "", cc: str = "") -> ToolResponse:
                return _send_via_draft("gmail_send", f"Send email to {to} — “{subject}”",
                                       {"to": to, "subject": subject, "body": body, "cc": cc})
            gmail_send.__doc__ = "Send an email. to/subject/body/cc. It is SAVED AS A DRAFT and surfaced for the user's approval — on approve it sends. Runs only after the team agrees."
            def gmail_reply(threadId: str, to: str = "", subject: str = "", body: str = "") -> ToolResponse:
                subj = subject if subject.lower().startswith("re:") else (f"Re: {subject}" if subject else "Re:")
                return _send_via_draft("gmail_reply", f"Reply in thread {threadId} to {to} — “{subj}”",
                                       {"to": to, "subject": subj, "body": body, "threadId": threadId})
            gmail_reply.__doc__ = "Reply within an existing thread. threadId (from search/get); to = recipient; body. Saved as a draft reply + surfaced for approval; on approve it sends."
            def gmail_trash(id: str) -> ToolResponse:
                held = _consensus_gate("gmail_trash")
                if held is not None:
                    return held
                gated = _gate_write("gmail_trash", f"Move message {id} to Trash (reversible)", "google",
                                    {"tool": "gmail_trash", "arguments": {"id": id}}, force=True)
                if gated is not None:
                    return gated
                return _google("gmail_trash", {"id": id})
            gmail_trash.__doc__ = "Move a message to Trash (reversible). id. Needs the user's approval."
            _gmail_read = (gmail_search, gmail_get, gmail_get_thread, gmail_list_drafts, gmail_list_labels)
            # read_only (searcher agents): register ONLY the read tools — no
            # drafts/send/modify/trash → the small owner model cannot queue a
            # spurious write-approval while gathering context. The centralized
            # producer still owns all writes.
            _gmail_write = () if read_only else (gmail_create_draft, gmail_modify, gmail_send, gmail_reply, gmail_trash)
            for _fn in (*_gmail_read, *_gmail_write):
                tk.register_tool_function(_fn, group_name="gmail")
        elif kind == "google_docs" and read_only:
            # Searcher agents: READ Drive/Docs for context — find files + read doc
            # text. No create/append (the producer owns writes).
            tk.create_tool_group(
                group_name="google_docs",
                description="Read Google Drive/Docs for context: search files, read a doc's text.",
                active=False,
                notes=("drive_search(query, max) finds Drive files (docs/sheets/slides) by name/content "
                       "→ id/name/type/url. docs_get(documentId) reads a Google Doc's full text. Use these "
                       "to pull context from the company's existing documents; you cannot create/edit docs "
                       "— the room produces any output once."),
            )
            def drive_search(query: str = "", max: int = 8) -> ToolResponse:
                return _google("drive_search", {"query": query, "max": max})
            drive_search.__doc__ = "Search Google Drive for files (docs/sheets/slides) by name/content. query = keywords; max ≤ 20. Returns id/name/type/url per file. Then call docs_get(id) to read a doc's text."
            def docs_get(documentId: str) -> ToolResponse:
                return _google("docs_get", {"documentId": documentId})
            docs_get.__doc__ = "Read the full text of an existing Google Doc by documentId (from drive_search). Returns the document's plain text — use it to ground your subtask in the company's real documents."
            tk.register_tool_function(drive_search, group_name="google_docs")
            tk.register_tool_function(docs_get, group_name="google_docs")
        elif kind == "google_docs":
            tk.create_tool_group(
                group_name="google_docs",
                description="Create or extend Google Docs (internal artifact — no approval needed).",
                active=False,
                notes="docs_create(title, content) → new doc + shareable url; docs_append(documentId, text). Use when the agreed output is a document (report, pitch deck, brief). Produced once the team reaches consensus; runs WITHOUT the user's approval (it's an internal artifact).",
            )
            def docs_create(title: str, content: str = "") -> ToolResponse:
                held = _consensus_gate("docs_create")
                if held is not None:
                    return held
                j = _google_json("docs_create", {"title": title, "content": content})
                _record_artifact("google-docs", _artifact_url(j), title=title, label=f"Open “{title}”")
                return _tool_response(j)
            docs_create.__doc__ = "Create a new Google Doc (e.g. a pitch deck or report). title = doc title; content = the full body in MARKDOWN (# / ## / ### headings, **bold**, - bullets, 1. numbered lists, | tables |) — it is rendered into a polished, formatted document, so structure it well. Returns documentId + shareable url. Produced after the team agrees; no approval needed."
            def docs_append(documentId: str, text: str) -> ToolResponse:
                held = _consensus_gate("docs_append")
                if held is not None:
                    return held
                j = _google_json("docs_append", {"documentId": documentId, "text": text})
                _record_artifact("google-docs", _artifact_url(j), label="Open document")
                return _tool_response(j)
            docs_append.__doc__ = "Append text to an existing Google Doc by documentId (from docs_create). No approval needed."
            tk.register_tool_function(docs_create, group_name="google_docs")
            tk.register_tool_function(docs_append, group_name="google_docs")
        elif kind == "google_sheets" and read_only:
            # Searcher agents: READ sheet values for context (find sheets via Drive,
            # read their cells). No create/append (the producer owns writes).
            tk.create_tool_group(
                group_name="google_sheets",
                description="Read Google Sheets for context: find sheets, read their cell values.",
                active=False,
                notes=("drive_search(query, max) finds Drive files incl. sheets → id/name/type/url. "
                       "sheets_get(spreadsheetId, range) reads a sheet's cell values (default first sheet "
                       "A1:Z500) → rows. Use to ground in the company's real spreadsheets; you cannot "
                       "create/edit sheets — the room produces any output once."),
            )
            # Only sheets_get here — drive_search (which finds sheets too) is
            # registered once in the google_docs group; registering it again would
            # collide on the tool name. If a room has sheets but not docs, the agent
            # finds sheet ids via recall/gmail and reads them with sheets_get.
            def sheets_get(spreadsheetId: str, range: str = "") -> ToolResponse:
                return _google("sheets_get", {"spreadsheetId": spreadsheetId, "range": range})
            sheets_get.__doc__ = "Read an existing Google Sheet's cell values by spreadsheetId (from drive_search or a known id). Optional range (default first sheet A1:Z500). Returns rows for grounding."
            tk.register_tool_function(sheets_get, group_name="google_sheets")
        elif kind == "google_sheets":
            tk.create_tool_group(
                group_name="google_sheets",
                description="Create or extend Google Sheets (internal artifact — no approval needed).",
                active=False,
                notes="sheets_create(title, rows_json) builds a spreadsheet — rows_json is a JSON 2-D array string, e.g. '[[\"Year\",\"Revenue\"],[\"2026\",\"100000\"]]' (first row = headers). sheets_append(spreadsheetId, rows_json) adds rows. Use when the agreed output is a table/financial plan. Produced after consensus; no approval needed.",
            )
            def sheets_create(title: str, rows_json: str = "") -> ToolResponse:
                held = _consensus_gate("sheets_create")
                if held is not None:
                    return held
                try:
                    rows = json.loads(rows_json) if rows_json else []
                except Exception:  # noqa: BLE001 — bad JSON → empty sheet, agent retries
                    rows = []
                j = _google_json("sheets_create", {"title": title, "rows": rows})
                _record_artifact("google-sheets", _artifact_url(j), title=title, label=f"Open “{title}”")
                return _tool_response(j)
            sheets_create.__doc__ = "Create a new Google Sheet (e.g. a financial plan). title = sheet title; rows_json = a JSON 2-D array string of rows (first row = headers), e.g. '[[\"Year\",\"ARR\"],[\"2026\",\"120000\"]]'. Returns spreadsheetId + url. Produced after the team agrees; no approval needed."
            def sheets_append(spreadsheetId: str, rows_json: str = "") -> ToolResponse:
                held = _consensus_gate("sheets_append")
                if held is not None:
                    return held
                try:
                    rows = json.loads(rows_json) if rows_json else []
                except Exception:  # noqa: BLE001
                    rows = []
                j = _google_json("sheets_append", {"spreadsheetId": spreadsheetId, "rows": rows})
                _record_artifact("google-sheets", _artifact_url(j), label="Open sheet")
                return _tool_response(j)
            sheets_append.__doc__ = "Append rows to an existing Google Sheet by spreadsheetId (from sheets_create). rows_json = JSON 2-D array string. No approval needed."
            tk.register_tool_function(sheets_create, group_name="google_sheets")
            tk.register_tool_function(sheets_append, group_name="google_sheets")

    def _register_nango_connector(provider_key: str, tools_list: List[Dict[str, Any]]) -> None:
        """Generic Nango connector tool registrar. Routes all calls to /api/connectors/mcp/exec.
        All tools are read-only by default; write tools MUST go through _gate_write().
        Token is resolved server-side — never exposed to the agent process.
        """
        safe_group: str = provider_key.replace("-", "_")
        tk.create_tool_group(
            group_name=safe_group,
            description=f"{provider_key} connector (Nango-backed, read-only).",
            active=False,
            notes=(
                ", ".join(t["name"] for t in tools_list)
                + " — all reads, no writes; safe for agent use without approval."
            ),
        )
        for tool_spec in tools_list:
            tool_name: str = tool_spec["name"]

            def _make_nango_tool(name: str, spec: Dict[str, Any]) -> Any:
                def tool_fn(**kwargs: Any) -> ToolResponse:
                    payload = {
                        "name": provider_key,
                        "operation": {
                            "type": "execute",
                            "arguments": {"tool": name, **kwargs},
                        },
                    }
                    try:
                        with _client(api_key, user_id, org_id) as c:
                            resp = c.post("/api/connectors/mcp/exec", json=payload)
                            resp.raise_for_status()
                            return _tool_response(resp.json().get("result", ""))
                    except Exception as exc:  # noqa: BLE001
                        log.warning("Nango connector tool %s failed: %s", name, exc)
                        return _tool_response_text(f"Error calling {name}: {exc}")

                tool_fn.__name__ = name
                tool_fn.__doc__ = spec.get("description", f"Nango connector tool: {name}")
                return tool_fn

            tk.register_tool_function(
                _make_nango_tool(tool_name, tool_spec),
                group_name=safe_group,
            )

    def _register_personio() -> None:
        """Register Personio v2 HR tools for agent use. All tools are read-only."""
        _register_nango_connector("personio-v2", PERSONIO_STATIC_TOOLS)

    for raw in connectors or []:
        conn = str(raw or "").strip()
        if not conn:
            continue
        if conn in ("gmail", "google_docs", "google_sheets"):
            _register_google(conn, read_only)
            continue
        if conn == "personio-v2":
            _register_personio()
            continue
        if conn in ("atlassian", "jira", "confluence"):
            _register_nango_connector("atlassian", ATLASSIAN_STATIC_TOOLS)
            continue
        if conn in ("gdrive", "google-drive"):
            _register_nango_connector("gdrive", GDRIVE_STATIC_TOOLS)
            continue
        if conn in ("microsoft", "microsoft365", "microsoft-365"):
            _register_nango_connector("microsoft", MICROSOFT_STATIC_TOOLS)
            continue
        if conn in ("salesforce", "salesforce-sandbox"):
            _register_nango_connector("salesforce", SALESFORCE_STATIC_TOOLS)
            continue
        safe = conn.replace("-", "_")
        tk.create_tool_group(
            group_name=safe,
            description=f"{conn} connector (3rd-party MCP).",
            active=False,
            notes=f"{safe}_list_tools() to discover available tools, then {safe}_call(tool_name, arguments) to invoke.",
        )

        def _make(conn_name: str, safe_name: str):
            def _list() -> ToolResponse:
                with _client(api_key, user_id, org_id) as c:
                    r = c.post("/api/connectors/mcp/inspect", json={"name": conn_name})
                    r.raise_for_status()
                    return _tool_response(r.json())

            def _call(tool_name: str, arguments: Optional[dict] = None) -> ToolResponse:
                descriptor = {
                    "name": conn_name,
                    "operation": {"type": "tool", "name": tool_name, "arguments": arguments or {}},
                }
                # Reads (search/list/get/...) run free; anything else on the
                # connector is a potential outward side effect → hold for
                # consensus first, then require the user's approval.
                if not _looks_like_read(tool_name):
                    held = _consensus_gate(f"{conn_name}.{tool_name}")
                    if held is not None:
                        return held
                    gated = _gate_write(
                        f"{conn_name}.{tool_name}",
                        f"Call {conn_name} tool '{tool_name}'",
                        "mcp",
                        descriptor,
                    )
                    if gated is not None:
                        return gated
                with _client(api_key, user_id, org_id) as c:
                    r = c.post("/api/connectors/mcp/exec", json=descriptor)
                    r.raise_for_status()
                    return _tool_response(r.json())

            _list.__name__ = f"{safe_name}_list_tools"
            _list.__doc__ = (
                f"List the tools available on the {conn_name} connector. Call this "
                f"FIRST to see what {conn_name} tool_name values {safe_name}_call accepts."
            )
            _call.__name__ = f"{safe_name}_call"
            _call.__doc__ = (
                f"Invoke a tool on the {conn_name} connector. tool_name must be one "
                f"returned by {safe_name}_list_tools; arguments is that tool's input object."
            )
            return _list, _call

        lst, cll = _make(conn, safe)
        tk.register_tool_function(lst, group_name=safe)
        tk.register_tool_function(cll, group_name=safe)


def register_experience_tool(tk: Toolkit, org_id: Optional[str], slug: Optional[str]) -> None:
    """Register `recall_experience` — the LAZY, read-only accessor for an agent's
    GLOBAL learned playbook (operating lessons distilled across ALL rooms, stored on
    digital_employees.evo_playbook). Surfaced as a TOOL — not injected wholesale every
    turn — so it stays token-lean and scales as the playbook grows, loaded only when
    the agent decides it's relevant. The agent reads its OWN lessons on demand; this
    path NEVER writes (a private chat is not journalised — only a sealed room turn's
    post-verify reflection appends). Org-scoped by (org_id, slug); no-op if either is
    missing. Uniform across personal/managed/self-host: reads the deployment-local
    digital_employees row, the same relational anchor every org type uses."""
    if not org_id or not slug:
        return

    async def recall_experience(topic: str = "") -> ToolResponse:
        """Recall YOUR own learned operating lessons from past work across every room
        (your global playbook). Call this when a task resembles one you have handled
        before and you want to apply what you learned. `topic` narrows to the most
        relevant lessons by keyword; empty returns your most recent. These are lessons
        to APPLY, not facts to cite to the user."""
        try:
            from ..db import get_employee_playbook
            lessons = await get_employee_playbook(str(org_id), str(slug))
        except Exception as exc:  # noqa: BLE001 — experience is optional, never fatal
            return _tool_response_text(f"(could not load your experience: {str(exc)[:120]})")
        lessons = [str(l).strip() for l in (lessons or []) if str(l).strip()]
        if not lessons:
            return _tool_response_text("You have no learned lessons yet.")
        t = (topic or "").lower().strip()
        if t:
            toks = [w for w in re.split(r"\W+", t) if len(w) > 2]
            hits = [l for l in lessons if any(w in l.lower() for w in toks)]
            chosen = (hits or lessons[-8:])[:8]
        else:
            chosen = lessons[-8:]
        body = "\n".join(f"- {l}" for l in chosen)
        return _tool_response_text(
            "YOUR LEARNED LESSONS (apply these, do not cite as facts):\n" + body,
            metadata={"count": len(lessons), "returned": len(chosen)},
        )

    try:
        tk.register_tool_function(recall_experience)
    except Exception as exc:  # noqa: BLE001
        log.warning("register_experience_tool failed: %s", exc)


def register_load_skill_tool(tk: Toolkit, room_kind: str) -> None:
    """Register `load_skill` — the domain's own strategy/method playbooks,
    loaded ON DEMAND mid-task instead of dumped upfront. Reuses the SAME
    skill catalogs the debate pipeline already uses (`hyper/domains/<slug>/
    skills/*.md`, one per domain: campaign, seo, marketing, outreach,
    branding, fundraising, research, product, design, legal_finance) — no
    new skills, no duplication. A no-op for room kinds with no domain pack
    (e.g. "general") — the tool is simply never registered.
    """
    from ..hyper.domains import domain_skill_catalog, load_domain_skill
    catalog = domain_skill_catalog(room_kind)
    if not catalog:
        return
    catalog_line = "\n".join(f"- {name}: {when}" for name, when in catalog)

    async def load_skill(name: str) -> ToolResponse:
        """Load one of this domain's strategy/method playbooks by name, at the
        point in the task where that method actually applies — not upfront,
        and not every skill "just in case". Call this when you reach the step
        it's meant for.

        Available skills for this domain:
        {catalog}
        """
        body = load_domain_skill(str(name or "").strip())
        if not body:
            names = ", ".join(n for n, _ in catalog)
            return _tool_response_text(f"No skill named '{name}' in this domain. Available: {names}")
        return _tool_response_text(body)

    load_skill.__doc__ = (load_skill.__doc__ or "").format(catalog=catalog_line)
    try:
        tk.register_tool_function(load_skill)
    except Exception as exc:  # noqa: BLE001
        log.warning("register_load_skill_tool failed: %s", exc)


def register_delegate_to_tool(
    tk: Toolkit,
    participants: List[Dict[str, Any]],
    build_sub_agent: Any,  # async Callable[[Dict[str, Any]], ReActAgent]
    max_delegations: int,
) -> None:
    """Register `delegate_to` — hand off ONE bounded subtask to a real
    teammate's OWN agent (their persona, their tools/connectors, their own
    reasoning loop), instead of faking their voice with a single-shot text
    call. `build_sub_agent` is injected by the caller (api_hyper_rooms.py
    owns `_build_agent_for_room`) so this module never imports upward and
    stays free of a circular dependency.

    Bounded by `max_delegations` per turn — a runaway plan can't fan out an
    unbounded number of real sub-agent loops, each its own LLM+tool cost.
    """
    roster = {
        str(p.get("slug") or p.get("id")): p
        for p in (participants or []) if p.get("slug") or p.get("id")
    }
    if not roster:
        return
    state = {"used": 0}
    roster_line = ", ".join(
        f"{slug} ({p.get('_lane') or p.get('role_archetype') or 'Communicator'})"
        for slug, p in roster.items()
    )

    async def delegate_to(employee_slug: str, subtask: str) -> ToolResponse:
        """Delegate ONE bounded subtask to a specific real teammate, who
        works it with THEIR OWN persona and tool access (recall, connectors)
        in their own reasoning loop, and returns their result to you. Use
        this when a subtask genuinely needs a different specialist's
        expertise or tool grants — not for trivial steps you can do
        yourself, and not to simulate a debate. `employee_slug` MUST be one
        of this room's real participants (see the roster below); `subtask`
        should be a clear, bounded ask — not the whole task.

        Available teammates (slug — lane): {roster}
        """
        if state["used"] >= max_delegations:
            return _tool_response_text(
                f"Delegation budget exhausted ({max_delegations} max this turn) — "
                "handle the remaining work yourself or wrap up with what you have."
            )
        target = roster.get(str(employee_slug or "").strip())
        if not target:
            return _tool_response_text(
                f"No teammate named '{employee_slug}' in this room. Real teammates: {roster_line}"
            )
        state["used"] += 1
        try:
            sub_agent = await build_sub_agent(target)
            from agentscope.message import Msg  # local import — avoid a module-load-order dependency
            reply = await sub_agent(Msg("user", str(subtask or "")[:2000], role="user"))
            content = reply.content if reply is not None else None
            if isinstance(content, list):
                text = "\n".join(
                    (blk.get("text") or "") if isinstance(blk, dict) else str(blk)
                    for blk in content
                ).strip()
            else:
                text = str(content or "").strip()
            return _tool_response_text(
                text or f"({target.get('name') or employee_slug} returned no result)",
                metadata={"delegated_to": employee_slug},
            )
        except Exception as exc:  # noqa: BLE001 — a failed delegation never kills the lead's loop
            log.warning("delegate_to(%s) failed: %s", employee_slug, exc)
            return _tool_response_text(f"Delegation to {employee_slug} failed: {str(exc)[:200]}")

    delegate_to.__doc__ = (delegate_to.__doc__ or "").format(roster=roster_line)
    try:
        tk.register_tool_function(delegate_to)
    except Exception as exc:  # noqa: BLE001
        log.warning("register_delegate_to_tool failed: %s", exc)


def register_cloudflare_browser_tool(
    tk: Toolkit, org_id: str, user_id: str, runtime_mode: str,
) -> None:
    """Expose the feature-gated Cloudflare Browser Run adapter to one Agent.

    The Worker repeats flag evaluation and SSRF validation. No Worker secret is
    shown to the model, and the returned page body is bounded by the Worker.
    """
    runtime_url = str(os.environ.get("HYPER_GROK_WORKFLOW_URL") or "").rstrip("/")
    runtime_secret = str(os.environ.get("HYPER_GROK_WORKFLOW_SECRET") or "")
    if not runtime_url or not runtime_secret:
        return

    async def cloudflare_browser_visit(url: str) -> ToolResponse:
        """Open one public HTTPS page in an isolated Cloudflare Browser Run
        session. Returns the rendered title, URL, visible text, and a live-view
        target when available. Use APIs/connectors first; use this for pages
        that require a real rendered browser. Private/local URLs are rejected.
        """
        try:
            async with httpx.AsyncClient(timeout=45.0) as client:
                response = await client.post(
                    f"{runtime_url}/browser/execute",
                    headers={"Authorization": f"Bearer {runtime_secret}"},
                    json={"org_id": org_id, "user_id": user_id, "mode": runtime_mode, "url": url},
                )
            response.raise_for_status()
            payload = response.json()
            page = payload.get("page") or {}
            links = [row for row in (page.get("links") or []) if isinstance(row, dict)][:250]
            price_evidence = [str(row)[:1200] for row in (page.get("price_evidence") or []) if str(row).strip()][:80]
            price_meta = [row for row in (page.get("price_meta") or []) if isinstance(row, dict)][:50]
            structured = [str(row)[:6000] for row in (page.get("structured") or []) if str(row).strip()][:10]
            link_text = "\n".join(
                f"- {str(row.get('text') or '')[:240]}: {str(row.get('url') or '')[:1000]}"
                for row in links
                if str(row.get("text") or "").strip() and str(row.get("url") or "").strip()
            )
            pricing_text = "\n".join(f"- {row}" for row in price_evidence)
            meta_text = "\n".join(
                f"- {str(row.get('key') or 'price')[:120]}: {str(row.get('content') or '')[:500]}"
                for row in price_meta
            )
            structured_text = "\n".join(structured)
            receipt_excerpt = (
                f"Rendered price evidence:\n{pricing_text}\nPrice metadata:\n{meta_text}\n\n"
                f"{str(page.get('text') or '')[:4000]}"
            )[:8000]
            _record_agent_tool_receipt({
                "adapter": "cloudflare_browser",
                "status": "completed",
                "provider_id": str(payload.get("session_id") or ""),
                "url": str(page.get("url") or url)[:1000],
                "title": str(page.get("title") or "")[:300],
                "excerpt": receipt_excerpt,
                "live_view_url": str(payload.get("live_view_url") or "")[:1000],
            })
            return _tool_response_text(
                f"Title: {page.get('title') or ''}\nURL: {page.get('url') or ''}\n\n"
                f"Rendered price evidence:\n{pricing_text}\n\nPrice metadata:\n{meta_text}\n\n"
                f"Structured product data:\n{structured_text}\n\nVisible page text:\n{page.get('text') or ''}"
                f"\n\nRendered links:\n{link_text}",
                metadata={
                    "adapter": "cloudflare_browser", "status": "completed",
                    "provider_id": payload.get("session_id"),
                    "session_id": payload.get("session_id"),
                    "live_view_url": payload.get("live_view_url"),
                },
            )
        except Exception as exc:  # noqa: BLE001
            return _tool_response_text(f"Cloudflare Browser failed safely: {str(exc)[:240]}")

    try:
        tk.create_tool_group(
            group_name="cloudflare_browser",
            description="Isolated Cloudflare Browser Run for public HTTPS pages.",
            active=True,
            notes="Use only when an API or connector cannot provide the required rendered page evidence.",
        )
    except Exception as exc:  # the per-employee toolkit is intentionally cached
        if "already registered" not in str(exc).lower():
            log.warning("register_cloudflare_browser_tool group failed: %s", exc)
    try:
        tk.register_tool_function(cloudflare_browser_visit, group_name="cloudflare_browser")
    except Exception as exc:  # noqa: BLE001
        if "already registered" not in str(exc).lower():
            log.warning("register_cloudflare_browser_tool failed: %s", exc)


def build_hivemind_toolkit(
    api_key: str,
    enabled_tool_names: List[str],
    user_id: Optional[str] = None,
    org_id: Optional[str] = None,
    project_id: Optional[str] = None,
    connectors: Optional[List[str]] = None,
    connectors_read_only: bool = False,
) -> Toolkit:
    """Return an AgentScope Toolkit populated with HIVEMIND tools.

    enabled_tool_names mirrors the schema used by `tools.py`:
        hivemind_slack_post, hivemind_slack_react, hivemind_slack_search,
        hivemind_slack_history, hivemind_recall, hivemind_save_memory.
    """
    tk = Toolkit()

    # Org directory — ALWAYS available (internal). Lets the lead resolve a person
    # by name to their email/role/projects, so "send to <name>" works without the
    # user spelling out an address.
    def org_directory(query: str = "") -> ToolResponse:
        """Resolve a person to their real email/role/projects. Searches the org
        directory AND, if the org has no match, Gmail in parallel — so you find a
        REAL address instead of inventing one. Pass a name (or part); empty lists
        everyone. Use this BEFORE gmail_send when a recipient is named but no
        address was given. If neither source has them, ASK — never fabricate."""
        with _client(api_key, user_id, org_id) as c:
            r = c.post("/api/org/members", json={"query": query})
            r.raise_for_status()
            data = r.json()
        members = data.get("members") or []
        gmail_candidates = []
        # No org hit for a named person → search Gmail for a real address.
        if query and not members:
            try:
                with _client(api_key, user_id, org_id) as c:
                    gr = c.post("/api/connectors/google/exec", json={
                        "tool": "gmail_search", "arguments": {"query": query, "max": 8}})
                    gr.raise_for_status()
                    gmsgs = ((gr.json().get("result") or {}).get("messages")) or []
                seen = set()
                ql = query.lower()
                for msg in gmsgs:
                    for field in (msg.get("from", ""), msg.get("to", "")):
                        if ql not in (field or "").lower():
                            continue
                        for addr in re.findall(r"[\w.+-]+@[\w.-]+\.\w+", field or ""):
                            al = addr.lower()
                            if addr in seen or "noreply" in al or "no-reply" in al or "notifications@" in al:
                                continue
                            seen.add(addr)
                            gmail_candidates.append({"email": addr, "seen_in": str(msg.get("subject", ""))[:60]})
            except Exception:  # noqa: BLE001 — gmail may be off; org result still stands
                pass
        return _tool_response({
            "org_name": data.get("org_name"),
            "members": members,
            "gmail_candidates": gmail_candidates,
            "note": ("Use a member email if present, else a gmail_candidate. If BOTH are "
                     "empty, ask the user for the address — do NOT invent one."),
        })
    # Gate registration so the TOOL-LESS planner (enabled_tool_names=['_plan_noop'])
    # gets an EMPTY toolkit — an unconditional tool reintroduces the fake-`JSON`
    # tool-call 400 that breaks planning. Room agents get it via DEFAULT_HYPER_TOOLS.
    if "org_directory" in enabled_tool_names:
        tk.register_tool_function(org_directory)

    # propose_call — the agent's decision to place a TARA outbound CALL. ALWAYS available:
    # it is safe by construction (only QUEUES a call contract for the user's popup approval;
    # flag-gated on the control side + first-contact HITL — it NEVER dials on its own).
    def propose_call(company: str, phone: str, why: str = "", lead_id: str = "",
                     personal_notes: str = "") -> ToolResponse:
        """Propose an outbound phone CALL to a prospect when a live voice call is the right next
        move (a warm lead, a meeting opportunity, a time-sensitive follow-up) — NOT for routine
        info. This does NOT dial: it queues a call CONTRACT (goal + conversation strategy +
        auto-selected voice & language) that POPS UP for the user's one-click approval; TARA calls
        only after they approve. Args: company (who to call), phone (E.164, e.g. '+49151234567'),
        why (the exact outcome or special instruction for this call), lead_id (the durable
        Your Leads identifier when available), personal_notes (verified lead-specific context)."""
        prov = _TURN_PROVENANCE.get() or {}
        cb = str(prov.get("callback_url") or "")
        room_id = prov.get("room_id")
        turn_id = prov.get("turn_id")
        if not (cb and room_id and turn_id):
            return _tool_response_text("Cannot propose a call outside a live room turn.")
        ph = str(phone or "").strip().replace(" ", "")
        if not ph.startswith("+") or len(ph) < 8:
            return _tool_response_text("A valid E.164 phone (e.g. +49151234567) is required to propose a call.")
        # control-plane base = the callback host (…/internal/hyper/turn-event → base)
        base = cb.split("/internal/")[0] if "/internal/" in cb else cb.rstrip("/")
        mk = os.environ.get("HIVEMIND_MASTER_API_KEY", "")
        try:
            with httpx.Client(timeout=httpx.Timeout(90.0, connect=5.0)) as c:
                r = c.post(
                    f"{base}/internal/hyper/outreach/propose",
                    headers={"X-API-Key": mk, "Content-Type": "application/json"},
                    json={"room_id": room_id, "turn_id": turn_id, "channel": "call",
                          "callback_url": cb, "prospect": {
                              "company": company or ph, "phone": ph,
                              "lead_id": lead_id or None,
                              "notes": personal_notes or None,
                              "special_instruction": why or None,
                          }},
                )
            if r.status_code == 403:
                return _tool_response_text("Call proposals are disabled for this deployment.")
            r.raise_for_status()
            ct = (r.json() or {}).get("contract") or {}
            return _tool_response_text(
                f"Queued a call to {company} for the user's approval — a popup will ask them to "
                f"approve before TARA dials. Goal: {ct.get('goal') or 'set'}; "
                f"language: {ct.get('language') or 'en'}; voice: {ct.get('voice_style') or 'auto'}.")
        except Exception as exc:  # noqa: BLE001
            log.warning("[propose_call] failed: %s", exc)
            return _tool_response_text(f"Could not queue the call proposal ({str(exc)[:120]}).")
    tk.register_tool_function(propose_call)

    # ── Shared LEAD BOOK — the company's persistent prospects/leads (org-scoped memories,
    # tagged 'prospect'). Every room sees the same book, so agents REUSE leads instead of
    # re-discovering/re-generating (expensive Places calls). Each lead carries a PERSONAL NOTE
    # captured when it was added (the memory's createdAt records WHEN). ALWAYS registered.
    async def places_search(query: str, limit: int = 20) -> ToolResponse:
        """Discover real local businesses for a location-grounded outreach assignment.
        Use only after checking list_prospects. Query format must be '<category> in <city>'.
        Results come from Google Places and are saved into the shared lead book."""
        clean = re.sub(r"\s+", " ", str(query or "").strip())[:180]
        key = os.environ.get("GOOGLE_MAPS_API_KEY") or os.environ.get("HYPER_PLACES_KEY") or ""
        if not key:
            return _tool_response({"status": "blocked", "reason": "google_maps_unavailable"})
        if len(clean.split()) < 2:
            return _tool_response({"status": "blocked", "reason": "query_requires_category_and_location"})
        _PLACES_SEARCH_COUNT.set(get_places_search_count() + 1)
        try:
            with httpx.Client(timeout=httpx.Timeout(30.0, connect=5.0)) as c:
                response = c.post(
                    "https://places.googleapis.com/v1/places:searchText",
                    headers={
                        "Content-Type": "application/json", "X-Goog-Api-Key": key,
                        "X-Goog-FieldMask": "places.displayName,places.internationalPhoneNumber,places.websiteUri,places.formattedAddress",
                    },
                    json={"textQuery": clean, "maxResultCount": min(max(int(limit or 20), 1), 20)},
                )
                response.raise_for_status()
                places = (response.json() or {}).get("places") or []
        except Exception as exc:  # noqa: BLE001
            log.warning("[places_search] failed: %s", exc)
            return _tool_response({"status": "blocked", "reason": str(exc)[:180]})
        rows = []
        for place in places:
            name = str((place.get("displayName") or {}).get("text") or "").strip()
            if not name:
                continue
            row = {"company": name, "phone": str(place.get("internationalPhoneNumber") or ""),
                   "website": str(place.get("websiteUri") or ""), "address": str(place.get("formattedAddress") or "")}
            rows.append(row)
        # Persist through the SAME real CRM lead-persist path the debate
        # pipeline uses (save_prospects_bulk_emulated → outreach_targets) —
        # not the deprecated memory writer. Needs a turn_id; without one
        # (armed by set_current_turn_id at turn start) results are still
        # returned but not saved, reported honestly rather than silently lost.
        turn_id = _CURRENT_TURN_ID.get()
        persisted_count = 0
        if rows and turn_id:
            payload = []
            for row in rows:
                contactability = "direct phone or website is available" if row.get("phone") or row.get("website") else "contact route still needs verification"
                fit_reason = f"{row['company']} matches the requested '{clean}' segment; {contactability}."
                outreach_angle = f"Open with the relevance of {row['company']} to the requested market, then validate its current need before proposing a solution."
                payload.append({
                    **row, "note": f"Discovered via Google Places for '{clean}'. {fit_reason}",
                    "fit_reason": fit_reason,
                    "distinctive_signal": f"Verified listing at {row['address'] or 'the requested location'} with "
                                          f"{'a direct contact route' if row.get('phone') or row.get('website') else 'contact enrichment pending'}.",
                    "outreach_angle": outreach_angle, "source": "google-places",
                })
            persisted = await save_prospects_bulk_emulated(
                prospects=payload, user_id=user_id, org_id=org_id, turn_id=turn_id, api_key=api_key,
            )
            persisted_count = int(persisted.get("persisted") or 0) if isinstance(persisted, dict) else 0
        _PLACES_SEARCH_TOTAL.set(get_places_search_total() + len(rows))
        return _tool_response({
            "status": "completed", "query": clean, "found": len(rows), "prospects": rows,
            "source": "Google Places", "saved_to_leads": persisted_count,
            **({} if turn_id else {"save_skipped_reason": "no active turn context to attach the lead to"}),
        })
    tk.register_tool_function(places_search)

    async def list_prospects(query: str = "", limit: int = 30) -> ToolResponse:
        """See the company's EXISTING prospects/leads (with the note captured when each was added)
        BEFORE you discover or generate new ones — reuse what's already there, don't re-search.
        Call this ONLY when you actually need leads (it's not free). Optional `query` narrows by
        company or keyword. Returns company + contact (phone/email/website) + the note + when-added."""
        payload = await list_prospects_emulated(
            user_id=user_id, org_id=org_id, query=query,
            limit=min(max(int(limit or 30), 1), 60), api_key=api_key,
        )
        if payload.get("error") and not payload.get("records"):
            return _tool_response_text(f"Could not read the lead book ({str(payload['error'])[:120]}).")
        rows = [row for row in (payload.get("records") or []) if isinstance(row, dict)]
        out = [{"company": row.get("company"), "phone": row.get("phone"), "email": row.get("email"),
                "website": row.get("website"), "address": row.get("address"),
                "fit_reason": row.get("fit_reason"), "outreach_angle": row.get("outreach_angle"),
                "note": row.get("note"), "added": row.get("updated_at")} for row in rows]
        return _tool_response({"count": len(out), "prospects": out,
                               "hint": "Reuse these before discovering new leads."})
    tk.register_tool_function(list_prospects)

    async def save_prospect(company: str, note: str, phone: str = "", email: str = "", website: str = "",
                            address: str = "", fit_reason: str = "", distinctive_signal: str = "",
                            outreach_angle: str = "") -> ToolResponse:
        """Add a prospect/lead to the company's shared lead book with a PERSONAL NOTE about why
        they matter right now — the reason/angle/signal, captured at THIS moment. Use when you
        identify a lead worth tracking so the whole company can reuse it later without re-searching.
        Args: company (required), note (why this lead matters — required), phone (E.164), email, website."""
        turn_id = _CURRENT_TURN_ID.get()
        if not turn_id:
            return _tool_response_text(
                "Could not save this lead — no active turn context to attach it to. "
                "This is a system gap, not something you can fix by retrying."
            )
        res = await save_prospects_bulk_emulated(
            prospects=[{
                "company": company, "note": note, "phone": phone, "email": email,
                "website": website, "address": address, "fit_reason": fit_reason or "verified prospect",
                "distinctive_signal": distinctive_signal, "outreach_angle": outreach_angle or note,
                "source": "agent",
            }],
            user_id=user_id, org_id=org_id, turn_id=turn_id, api_key=api_key,
        )
        return _tool_response(res) if isinstance(res, dict) else _tool_response_text(str(res))
    tk.register_tool_function(save_prospect)

    if "hivemind_slack_post" in enabled_tool_names:
        def slack_post(channel: str, text: str, thread_ts: Optional[str] = None) -> ToolResponse:
            """Post a message to a Slack channel or thread.

            Args:
                channel: Slack channel ID (e.g. C01ABCDEF).
                text: Message body.
                thread_ts: Optional thread timestamp to reply in-thread.
            """
            res = _post_slack_action(api_key,"slack_post", {
                "channel": channel, "text": text, "thread_ts": thread_ts,
            })
            return _tool_response(res)
        tk.register_tool_function(slack_post)

    if "hivemind_slack_react" in enabled_tool_names:
        def slack_react(channel: str, ts: str, emoji: str) -> ToolResponse:
            """Add an emoji reaction to a Slack message.

            Args:
                channel: Slack channel ID.
                ts: Message timestamp to react to.
                emoji: Emoji name without colons (e.g. "thumbsup").
            """
            res = _post_slack_action(api_key,"slack_react", {
                "channel": channel, "ts": ts, "emoji": emoji,
            })
            return _tool_response(res)
        tk.register_tool_function(slack_react)

    if "hivemind_slack_search" in enabled_tool_names:
        def slack_search(query: str, count: int = 10) -> ToolResponse:
            """Search Slack workspace messages.

            Args:
                query: Search query string.
                count: Max results (default 10).
            """
            res = _post_slack_action(api_key,"slack_search", {
                "query": query, "count": count,
            })
            return _tool_response(res)
        tk.register_tool_function(slack_search)

    if "hivemind_slack_history" in enabled_tool_names:
        def slack_history(channel: str, limit: int = 50, since: Optional[str] = None) -> ToolResponse:
            """Fetch recent Slack channel history.

            Args:
                channel: Slack channel ID.
                limit: Max messages (default 50).
                since: Optional ISO-8601 timestamp lower bound.
            """
            res = _post_slack_action(api_key,"slack_history", {
                "channel": channel, "limit": limit, "since": since,
            })
            return _tool_response(res)
        tk.register_tool_function(slack_history)

    # ── Helper: coerce string-int params (Groq sometimes returns strings) ─
    def _ci(v, default):
        if v is None: return default
        try: return int(v)
        except Exception:
            try: return int(float(v))
            except Exception: return default

    if "hivemind_recall" in enabled_tool_names:
        def recall(query: str, max_memories: int = 5) -> ToolResponse:
            """Search HIVEMIND — the company's memory / knowledge graph. This is the
            company brain: prior decisions, product and feature context, past
            conversations, documents, named people and entities the org already
            knows about. IMPORTANT — call this whenever the task names a specific
            product, feature, decision, person, or topic, even if you think you
            already have enough context from the current conversation alone. A
            quick recall check beats reasoning from assumption or from training
            knowledge about what a product "probably" does — this org's own
            record is the authority on its own products. Call it more than once
            with different focused queries when the task spans several distinct
            topics or named entities.

            Args:
                query: short, focused search phrase — one topic/entity per call.
                max_memories: Max memories to return (default 5).
            """
            with _client(api_key, user_id, org_id) as c:
                body = {"query_context": query, "max_memories": max_memories, "mode": "explain"}
                # Room scope: when the room belongs to a project HIVEMIND, every
                # agent recall is scoped to that project so the room stays on-topic.
                # project_id is the hard tenant-validated scope. The legacy
                # project/preferred_project fields remain ranking hints only.
                if project_id:
                    body["project_id"] = project_id
                    body["project"] = project_id
                    body["preferred_project"] = project_id
                r = c.post("/api/recall", json=body)
                r.raise_for_status()
                return _tool_response(r.json())
        tk.register_tool_function(recall)

    if "hivemind_save_memory" in enabled_tool_names:
        def save_memory(title: str, content: str, tags: Optional[str] = None) -> ToolResponse:
            """Save a fact or note to HIVEMIND persistent memory.

            Args:
                title: Short descriptive title.
                content: The content to remember.
                tags: Comma-separated tags (e.g. "decision,pricing,q1").
            """
            tag_list = [t.strip() for t in (tags or "").split(",") if t.strip()]
            # P0 actionable-gate (shadow by default). Junk facts never help the brain.
            gate_mode = os.environ.get("HYPER_PROVENANCE_GATE", "log").lower()
            ok, reason = _actionable_verdict(title, content)
            if not ok and gate_mode == "enforce":
                log.info("[provenance-gate] rejected save (%s): %s", reason, (title or "")[:60])
                return _tool_response_text(
                    f"Not saved — the actionable gate rejected this ({reason}). "
                    "Save a concrete, durable fact (a decision, number, name, or commitment), not a question or filler."
                )
            if not ok and gate_mode == "log":
                log.warning("[provenance-gate] SHADOW would-reject (%s): %s", reason, (title or "")[:60])
            prov = _TURN_PROVENANCE.get() or {}
            with _client(api_key, user_id, org_id) as c:
                body = {"title": title, "content": content, "tags": tag_list, "sync": True}
                # Room scope: project-scoped rooms save into the project HIVEMIND.
                if project_id:
                    body["project_id"] = project_id
                # P0 provenance: stamp origin so the company brain is auditable (stored via
                # the existing source_platform column + source_metadata JSON — no schema change).
                body["source_platform"] = "hyperagents"
                _sm = {"source_type": "hyperagents_room", "source_platform": "hyperagents",
                       "produced_by": "hyperagents-agent", "actionable": bool(ok)}
                if prov.get("turn_id"):
                    _sm["source_session_id"] = str(prov["turn_id"])
                if prov.get("room_id"):
                    _sm["room_id"] = str(prov["room_id"])
                body["source_metadata"] = _sm
                r = c.post("/api/memories", json=body)
                r.raise_for_status()
                return _tool_response(r.json())
        tk.register_tool_function(save_memory)

    # ── Read-only graph + temporal tools ─────────────────────────────

    if "hivemind_list_memories" in enabled_tool_names:
        def list_memories(tags: Optional[str] = None, memory_type: Optional[str] = None, limit: int = 20) -> ToolResponse:
            """List recent memories with optional filters.

            Args:
                tags: Comma-separated tag filter (any-match).
                memory_type: e.g. 'fact'|'decision'|'preference'|'goal'|'summary'.
                limit: Max rows (default 20, max 100).
            """
            params: dict = {"limit": min(max(limit, 1), 100)}
            if tags: params["tags"] = tags
            if memory_type: params["memory_type"] = memory_type
            with _client(api_key, user_id, org_id) as c:
                r = c.get("/api/memories", params=params)
                r.raise_for_status()
                return _tool_response(r.json())
        tk.register_tool_function(list_memories)

    if "hivemind_get_memory" in enabled_tool_names:
        def get_memory(memory_id: str) -> ToolResponse:
            """Fetch one memory's full content + metadata by id."""
            with _client(api_key, user_id, org_id) as c:
                r = c.get(f"/api/memories/{memory_id}")
                r.raise_for_status()
                return _tool_response(r.json())
        tk.register_tool_function(get_memory)

    if "hivemind_traverse_graph" in enabled_tool_names:
        def traverse_graph(memory_id: str, depth: int = 2, relationship: str = "all") -> ToolResponse:
            """Walk the relationship graph from a starting memory.

            Args:
                memory_id: Start node.
                depth: 1-3 hops.
                relationship: 'all'|'Updates'|'Extends'|'Derives'|'Contradicts'|'PartOf'|'Mentions'.
            """
            with _client(api_key, user_id, org_id) as c:
                r = c.post("/api/memories/traverse", json={
                    "memory_id": memory_id,
                    "depth": min(max(depth, 1), 3),
                    "relationship": relationship,
                })
                r.raise_for_status()
                return _tool_response(r.json())
        tk.register_tool_function(traverse_graph)

    if "hivemind_query_with_ai" in enabled_tool_names:
        def query_with_ai(question: str, context_limit: int = 8) -> ToolResponse:
            """Ask a natural-language question; HIVEMIND retrieves + synthesizes.

            Use for complex multi-hop questions. Cheaper to use hivemind_recall
            for narrow lookups.
            """
            with _client(api_key, user_id, org_id) as c:
                r = c.post("/api/query", json={
                    "question": question, "context_limit": context_limit,
                })
                r.raise_for_status()
                return _tool_response(r.json())
        tk.register_tool_function(query_with_ai)

    if "hivemind_recall_bugs" in enabled_tool_names:
        def recall_bugs(context: str, limit: int = 5) -> ToolResponse:
            """Recall past bugs / gotchas matching the context."""
            with _client(api_key, user_id, org_id) as c:
                r = c.post("/api/recall_bugs", json={"context": context, "limit": limit})
                r.raise_for_status()
                return _tool_response(r.json())
        tk.register_tool_function(recall_bugs)

    if "hivemind_why_code" in enabled_tool_names:
        def why_code(query: str, file_path: Optional[str] = None) -> ToolResponse:
            """Explain why a piece of code/decision exists (links to past decisions)."""
            body: dict = {"query": query}
            if file_path: body["file_path"] = file_path
            with _client(api_key, user_id, org_id) as c:
                r = c.post("/api/why_code", json=body)
                r.raise_for_status()
                return _tool_response(r.json())
        tk.register_tool_function(why_code)

    # Per-connector live-MCP toolkits (granted to this agent for this room).
    if connectors:
        _register_connector_tools(tk, connectors, api_key, user_id, org_id, read_only=connectors_read_only)

    if "hivemind_at" in enabled_tool_names:
        def hivemind_at(transaction_time: Optional[str] = None, valid_time: Optional[str] = None, memory_query: Optional[str] = None) -> ToolResponse:
            """Time-travel — return memory state as it was known/true at a timestamp."""
            body = {k: v for k, v in {"transaction_time": transaction_time, "valid_time": valid_time, "memory_query": memory_query}.items() if v}
            with _client(api_key, user_id, org_id) as c:
                r = c.post("/api/time/at", json=body)
                r.raise_for_status()
                return _tool_response(r.json())
        tk.register_tool_function(hivemind_at)

    if "hivemind_list_projects" in enabled_tool_names:
        def list_projects() -> ToolResponse:
            """List projects (sub-HIVEMINDs) accessible to the caller's org."""
            with _client(api_key, user_id, org_id) as c:
                r = c.get("/api/projects")
                r.raise_for_status()
                return _tool_response(r.json())
        tk.register_tool_function(list_projects)

    # ── Web intelligence (use only when info isn't in HIVEMIND) ───────

    if "hivemind_web_search" in enabled_tool_names:
        def web_search(query: str, limit: int = 5) -> ToolResponse:
            """Search the live web. USE SPARINGLY — try hivemind_recall first.
            Submits a Tavily search job, polls for result, returns top hits.

            Args:
                query: Search query (be specific, 5-10 words).
                limit: Max results (default 5, max 10).
            """
            import time
            with _client(api_key, user_id, org_id) as c:
                r = c.post("/api/web/search/jobs", json={"query": query, "limit": min(max(limit, 1), 10)})
                r.raise_for_status()
                job_id = r.json().get("job_id")
                if not job_id: return _tool_response({"error": "no job_id"})
                # Poll up to ~20s
                for _ in range(20):
                    time.sleep(1)
                    g = c.get(f"/api/web/jobs/{job_id}")
                    if g.status_code != 200: continue
                    payload = g.json()
                    if payload.get("status") in {"succeeded", "failed"}:
                        return _tool_response(payload)
                return _tool_response({"status": "timeout", "job_id": job_id})
        tk.register_tool_function(web_search)

    if "hivemind_web_research" in enabled_tool_names:
        def web_research(input: str, model: str = "mini") -> ToolResponse:
            """Comprehensive Tavily Research report with citations. Use for
            broad, multi-source questions where a single search isn't enough.
            Heavier than hivemind_web_search — use sparingly.

            Args:
                input: Research question / task.
                model: 'mini' (fast, narrow) | 'pro' (deep, multi-subtopic) | 'auto'.
            """
            import time
            with _client(api_key, user_id, org_id) as c:
                r = c.post("/api/web/research/jobs", json={"input": input, "model": model})
                r.raise_for_status()
                job_id = r.json().get("job_id")
                if not job_id: return _tool_response({"error": "no job_id"})
                # Poll up to 4 min for pro mode
                for _ in range(120):
                    time.sleep(2)
                    g = c.get(f"/api/web/jobs/{job_id}")
                    if g.status_code != 200: continue
                    payload = g.json()
                    if payload.get("status") in {"succeeded", "failed"}:
                        return _tool_response(payload)
                return _tool_response({"status": "timeout", "job_id": job_id})
        tk.register_tool_function(web_research)

    if "hivemind_web_crawl" in enabled_tool_names:
        def web_crawl(url: str, depth: int = 1, capture_screenshot: bool = False, session: str = "") -> ToolResponse:
            """Render and crawl a specific public URL with a real browser (not a
            static fetch) — page text, links, SEO meta, and optionally a screenshot.

            Use when a task names a specific page (not a general question —
            that's hivemind_web_search) and needs its actual rendered content,
            or a visual of it.

            Args:
                url: The page to render and crawl.
                depth: How many link-hops to follow from this page (0 = just this page).
                capture_screenshot: Take a screenshot of the page.
                session: Reuse a pre-authorized session for a gated platform —
                    "linkedin" | "x" | "instagram" — if one has been captured
                    (see services/hm-playwright/sessions/README.md). Falls back
                    to an anonymous view if none exists; never fails the request.
            """
            import time
            body = {"urls": [url], "depth": max(0, min(depth, 4)), "page_limit": 1,
                    "capture_screenshot": bool(capture_screenshot)}
            if session:
                body["session"] = session
            with _client(api_key, user_id, org_id) as c:
                r = c.post("/api/web/crawl/jobs", json=body)
                r.raise_for_status()
                job_id = r.json().get("job_id")
                if not job_id:
                    return _tool_response({"error": "no job_id"})
                for _ in range(60):
                    time.sleep(2)
                    result = c.get(f"/api/web/jobs/{job_id}")
                    if result.status_code != 200:
                        continue
                    payload = result.json()
                    if payload.get("status") in {"succeeded", "failed"}:
                        return _tool_response(payload)
                return _tool_response({"status": "timeout", "job_id": job_id})
        tk.register_tool_function(web_crawl)

    if "hivemind_seo_audit" in enabled_tool_names:
        def seo_audit(url: str, page_limit: int = 25) -> ToolResponse:
            """Audit a public website with deterministic SEO rules.

            Use in SEO Rooms when the task names a website URL. Returns crawl
            coverage, page/template findings, evidence, severity and limitations.
            It does not infer rankings, traffic, Search Console state or CWV.
            """
            import time
            with _client(api_key, user_id, org_id) as c:
                r = c.post("/api/web/seo-audit/jobs", json={
                    "url": url, "page_limit": min(max(page_limit, 1), 50), "depth": 2,
                })
                r.raise_for_status()
                job_id = r.json().get("job_id")
                if not job_id:
                    return _tool_response({"error": "no job_id"})
                for _ in range(90):
                    time.sleep(2)
                    result = c.get(f"/api/web/jobs/{job_id}")
                    if result.status_code != 200:
                        continue
                    payload = result.json()
                    if payload.get("status") in {"succeeded", "failed"}:
                        return _tool_response(payload)
                return _tool_response({"status": "timeout", "job_id": job_id})
        tk.register_tool_function(seo_audit)

    log.info("Built AgentScope toolkit (tools=%s)", enabled_tool_names)
    return tk
