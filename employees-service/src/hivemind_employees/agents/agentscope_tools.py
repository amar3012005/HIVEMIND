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
    """Arm the write/consensus gates for the current turn. policy ∈ {"ask","auto"}.
    Output stays LOCKED until the orchestrator reaches consensus (synthesis)."""
    _WRITE_POLICY.set(policy if policy in ("ask", "auto") else "auto")
    _PENDING_WRITES.set([])
    _OUTPUT_UNLOCKED.set(False)
    _TURN_ARTIFACTS.set([])


def unlock_output() -> None:
    """Consensus reached — let the synthesis step produce the agreed output."""
    _OUTPUT_UNLOCKED.set(True)


def drain_pending_writes() -> List[Dict[str, Any]]:
    """Return (a copy of) the writes queued for approval this turn."""
    pend = _PENDING_WRITES.get()
    return list(pend) if isinstance(pend, list) else []


def drain_artifacts() -> List[Dict[str, Any]]:
    """Return (a copy of) the artifacts (docs/sheets/...) produced this turn."""
    arts = _TURN_ARTIFACTS.get()
    return list(arts) if isinstance(arts, list) else []


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


def _record_artifact(connector: str, url: str, title: str = "", label: str = "") -> None:
    """Record a produced artifact (doc/sheet) so the orchestrator can emit a
    `connector_logo` 'view in new tab' event to the FE. After the FIRST artifact
    lands, RE-LOCK output so the turn produces ONE high-quality deliverable
    rather than a pile of near-duplicate drafts from racing agents/retries."""
    arts = _TURN_ARTIFACTS.get()
    if isinstance(arts, list) and url:
        arts.append({"connector": connector, "url": url, "title": title, "label": label})
        _OUTPUT_UNLOCKED.set(False)


def _artifact_url(payload: object) -> str:
    """Pull a doc/sheet URL out of a bridge ToolResponse's underlying json."""
    if not isinstance(payload, dict):
        return ""
    res = payload.get("result") if isinstance(payload.get("result"), dict) else payload
    return str((res or {}).get("url") or "") if isinstance(res, dict) else ""


def _gate_write(
    label: str, summary: str, bridge: str, descriptor: dict, force: bool = False
) -> Optional[ToolResponse]:
    """When policy is "ask" (or force=True), queue the write for approval and
    return a "pending" ToolResponse WITHOUT executing. Returns None when the
    write may run now. `force` is for outward SENDS (gmail send/reply, trash),
    which ALWAYS require the user's approval regardless of policy. `descriptor`
    carries everything the approve endpoint needs to replay the bridge call."""
    if not force and _WRITE_POLICY.get() != "ask":
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


def _register_connector_tools(
    tk: Toolkit,
    connectors: List[str],
    api_key: str,
    user_id: Optional[str],
    org_id: Optional[str],
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
    def _register_google(kind: str):
        def _google(tool_name: str, arguments: Optional[dict] = None) -> ToolResponse:
            return _tool_response(_google_json(tool_name, arguments))
        def _google_json(tool_name: str, arguments: Optional[dict] = None) -> dict:
            with _client(api_key, user_id, org_id) as c:
                r = c.post("/api/connectors/google/exec", json={"tool": tool_name, "arguments": arguments or {}})
                r.raise_for_status()
                return r.json()
        if kind == "gmail":
            tk.create_tool_group(
                group_name="gmail",
                description="Full Gmail for the room owner: search/read/threads (free), drafts + labels, and send/reply (saved as a draft, then user-approved).",
                active=False,
                notes=(
                    "READ (free): gmail_search(query,max), gmail_get(id), gmail_get_thread(threadId), "
                    "gmail_list_drafts(max), gmail_list_labels(). "
                    "DRAFT (no approval): gmail_create_draft(to,subject,body,cc,threadId). "
                    "ORGANIZE (no approval): gmail_modify(id, addLabelIds, removeLabelIds) — mark read = remove 'UNREAD', archive = remove 'INBOX'. "
                    "OUTWARD (always saved as a draft, then needs the user's approval to actually go): "
                    "gmail_send(to,subject,body,cc), gmail_reply(threadId,to,subject,body), gmail_trash(id)."
                ),
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
            for _fn in (gmail_search, gmail_get, gmail_get_thread, gmail_list_drafts, gmail_list_labels,
                        gmail_create_draft, gmail_modify, gmail_send, gmail_reply, gmail_trash):
                tk.register_tool_function(_fn, group_name="gmail")
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

    for raw in connectors or []:
        conn = str(raw or "").strip()
        if not conn:
            continue
        if conn in ("gmail", "google_docs", "google_sheets"):
            _register_google(conn)
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


def build_hivemind_toolkit(
    api_key: str,
    enabled_tool_names: List[str],
    user_id: Optional[str] = None,
    org_id: Optional[str] = None,
    project_id: Optional[str] = None,
    connectors: Optional[List[str]] = None,
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
            """Recall memories from HIVEMIND knowledge graph.

            Args:
                query: What to search for.
                max_memories: Max memories to return (default 5).
            """
            with _client(api_key, user_id, org_id) as c:
                body = {"query_context": query, "max_memories": max_memories}
                # Room scope: when the room belongs to a project HIVEMIND, every
                # agent recall is scoped to that project so the room stays on-topic.
                # core /api/recall reads `project`/`preferred_project` (NOT
                # `project_id`) — same keys recall_emulated sends — so the agents
                # hit the exact project-scoped recall path the grounding pass uses.
                if project_id:
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
            with _client(api_key, user_id, org_id) as c:
                body = {"title": title, "content": content, "tags": tag_list, "sync": True}
                # Room scope: project-scoped rooms save into the project HIVEMIND.
                if project_id:
                    body["project_id"] = project_id
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
        _register_connector_tools(tk, connectors, api_key, user_id, org_id)

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

    log.info("Built AgentScope toolkit (tools=%s)", enabled_tool_names)
    return tk
