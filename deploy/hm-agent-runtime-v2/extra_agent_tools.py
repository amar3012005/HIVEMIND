# -*- coding: utf-8 -*-
"""HIVE-MIND capabilities as AgentScope tools.

This is the `extra_agent_tools` factory. AgentScope calls it once per agent
assembly with `(user_id, agent_id, session_id)` and merges the returned tools
into the toolkit's basic group. That is the *only* supported injection point —
building a second context-injection path would race with `InboxMiddleware`,
which is the sole owner of hint injection.

Design rules, in order of importance:

1. **hm-core stays the authority.** Every tool calls hm-core with the resolved
   principal and lets hm-core decide what that principal may see. Nothing here
   re-implements tenancy, policy, or permissions — a tool that filtered results
   itself would be a second, divergent authority.

2. **Tenant scoping is enforced inside each tool.** The factory receives
   `user_id`, but nothing else stops a tool from reading another tenant's data.
   Every call carries the principal; hm-core scopes on it.

3. **Tools are thin.** A tool is a typed wrapper over one hm-core endpoint. If a
   tool needs business logic, that logic belongs in hm-core, not here — the
   runtime must stay domain-agnostic (see the GENERALITY CONTRACT in AGENTS.md).

4. **No fabricated results.** A tool that cannot reach hm-core returns an error
   the model can see. It never returns a plausible-looking empty success, because
   the model will treat that as a fact and build on it.

Contract notes (verified against `~/agentscope/src/agentscope/tool/`):

- The override point is ``call``, **not** ``__call__``. ``ToolBase.__call__``
  layers middlewares around ``call``; overriding ``__call__`` would bypass every
  registered middleware, including the permission and audit ones.
- ``input_schema`` is a required class attribute. It is derived from a pydantic
  params model so the schema and the signature cannot drift apart.
- The return type is ``ToolChunk`` (or an async generator of them). ``ToolChunk``
  carries ``state``, so a failure is reported as ``ToolResultState.ERROR`` rather
  than as a successful chunk containing the word "error" — the model and the
  permission layer both read that field.

The tool set is deliberately small — the capabilities the first vertical slice
needs. Adding a capability means adding one class here plus one hm-core
endpoint, not a new framework.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Optional

import httpx
from pydantic import BaseModel, Field

from agentscope.message import TextBlock, ToolResultState
from agentscope.permission import (
    PermissionBehavior,
    PermissionContext,
    PermissionDecision,
)
from agentscope.tool import ToolBase, ToolChunk

_log = logging.getLogger("hm-agent-runtime.tools")

HM_CORE_URL = os.getenv("HM_CORE_URL", "").strip().rstrip("/")
MASTER_API_KEY = os.getenv("HIVEMIND_MASTER_API_KEY", "").strip()

# Tool calls are on the agent's critical path. A hung hm-core must surface as a
# tool error the model can react to, not as a stalled run.
_TOOL_TIMEOUT = float(os.getenv("HM_TOOL_TIMEOUT", "60"))


_TENANCY_RE = re.compile(
    r"^org:([0-9a-f-]{36}):user:([0-9a-f-]{36})$",
    re.I,
)


def _split_principal(user_id: str, org_id: Optional[str] = None) -> tuple[str, Optional[str]]:
    """AgentScope may key tenants as org:{org}:user:{user}. hm-core wants UUIDs."""
    match = _TENANCY_RE.match(str(user_id or "").strip())
    if match:
        return match.group(2), org_id or match.group(1)
    return str(user_id or "").strip(), org_id


def _headers(user_id: str, org_id: Optional[str] = None) -> dict[str, str]:
    """hm-core's internal-auth headers.

    Mirrors `buildInternalHeaders()` in `core/src/internal/internal-fetch.js`:
    the master key plus the resolved principal. hm-core treats the principal as
    authoritative only because the key proves the caller is a trusted service.
    """
    user_uuid, org_uuid = _split_principal(user_id, org_id)
    headers = {
        "X-API-Key": MASTER_API_KEY,
        "X-HM-User-Id": user_uuid,
        "Content-Type": "application/json",
    }
    if org_uuid:
        headers["X-HM-Org-Id"] = org_uuid
    return headers


async def _call_hm_core(
    path: str,
    *,
    user_id: str,
    org_id: Optional[str] = None,
    method: str = "POST",
    body: Optional[dict] = None,
) -> dict[str, Any]:
    """One hm-core call. Raises on failure so the caller can report it."""
    if not HM_CORE_URL:
        raise RuntimeError(
            "HM_CORE_URL is not configured; HIVE-MIND tools cannot reach hm-core",
        )
    url = f"{HM_CORE_URL}{path}"
    async with httpx.AsyncClient(timeout=_TOOL_TIMEOUT) as client:
        resp = await client.request(
            method,
            url,
            headers=_headers(user_id, org_id),
            json=body,
        )
    if resp.status_code >= 400:
        raise RuntimeError(f"hm-core {path} returned {resp.status_code}: {resp.text[:500]}")
    try:
        return resp.json()
    except ValueError:
        return {"raw": resp.text[:2000]}


def _compat_schema(schema: dict) -> dict:
    """DeepSeek/OpenAI-style tools reject JSON Schema anyOf [string, null]."""
    import copy

    node = copy.deepcopy(schema or {})

    def walk(obj: Any) -> None:
        if isinstance(obj, dict):
            if "anyOf" in obj and isinstance(obj["anyOf"], list):
                types = [x.get("type") for x in obj["anyOf"] if isinstance(x, dict)]
                if "string" in types:
                    obj.pop("anyOf", None)
                    obj["type"] = "string"
                elif "integer" in types:
                    obj.pop("anyOf", None)
                    obj["type"] = "integer"
            for val in obj.values():
                walk(val)
        elif isinstance(obj, list):
            for item in obj:
                walk(item)

    walk(node)
    return node


def _ok(payload: Any) -> ToolChunk:
    """A successful tool result.

    JSON, not prose: the model reasons over structure far more reliably than
    over a sentence it has to parse, and a structured result cannot be
    paraphrased into a claim the data does not support.
    """
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False, default=str)
    return ToolChunk(
        content=[TextBlock(type="text", text=text)],
        state=ToolResultState.SUCCESS,
    )


def _err(message: str, **context: Any) -> ToolChunk:
    """A failed tool result.

    ``state=ERROR`` is what the agent and the permission layer read. Returning a
    success chunk whose text happens to say "error" would let the model treat a
    failed lookup as an empty-but-valid answer.
    """
    payload = {"error": message}
    payload.update({k: v for k, v in context.items() if v is not None})
    return ToolChunk(
        content=[TextBlock(type="text", text=json.dumps(payload, ensure_ascii=False, default=str))],
        state=ToolResultState.ERROR,
    )


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


class _HiveMindToolBase(ToolBase):
    """Shared plumbing: the resolved principal, permissions, and the error boundary.

    Every tool is read-only with respect to the workspace and concurrency-safe
    (they are independent HTTP calls), so those flags are set once here rather
    than repeated — and repeated wrongly — in each subclass.
    """

    is_concurrency_safe: bool = True
    is_read_only: bool = True
    is_external_tool: bool = False

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        schema = getattr(cls, "input_schema", None)
        if isinstance(schema, dict):
            cls.input_schema = _compat_schema(schema)

    def __init__(
        self,
        user_id: str,
        org_id: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> None:
        super().__init__()
        self._user_id = user_id
        self._org_id = org_id
        # This is minted by AgentScope, not supplied by the model.  It lets
        # hm-core link a registered workspace artifact to the caller's durable
        # WorkRun without making the WorkRun id part of a tool schema.
        self._session_id = session_id

    async def check_permissions(
        self,
        tool_input: dict[str, Any],
        context: PermissionContext,
    ) -> PermissionDecision:
        """Defer to the engine's rule matching.

        ``PASSTHROUGH`` is the correct answer for a tool that has no
        tool-specific safety check of its own: the engine still applies the
        configured allow/deny/ask rules and the active permission mode. The
        builtin read-only tools answer exactly this way.

        Returning ``ALLOW`` here would be wrong — it would let this tool
        override a deny rule the operator configured for it. Returning ``ASK``
        would be wrong too: it would prompt on every recall, and a prompt that
        fires constantly is a prompt the operator learns to approve blindly.

        The one thing this method must NOT do is decide tenancy. hm-core is the
        authority on what the principal may read; a permission check here that
        tried to scope data would be a second, weaker authority.
        """
        return PermissionDecision(
            behavior=PermissionBehavior.PASSTHROUGH,
            message="HIVE-MIND tools defer to engine rule matching.",
        )


class RecallTool(_HiveMindToolBase):
    """Search HIVE-MIND memory for facts relevant to the current task."""

    name: str = "hivemind_recall"

    description: str = """Search the organization's HIVE-MIND memory for facts, \
decisions, people, projects, and prior work relevant to a query.

Use this BEFORE researching anything externally — the answer is often already \
known, and a fact recalled from memory is authoritative in a way a web result \
is not.

Returns ranked memories with their content and tags."""

    class Params(BaseModel):
        query: str = Field(description="What to look for, in natural language.")
        limit: int = Field(default=8, description="Maximum number of memories to return.")

    input_schema: dict = Params.model_json_schema()

    async def call(self, query: str, limit: int = 8) -> ToolChunk:
        try:
            data = await _call_hm_core(
                "/internal/hivemind/recall",
                user_id=self._user_id,
                org_id=self._org_id,
                body={"query": query, "limit": max(1, min(int(limit), 25))},
            )
        except Exception as exc:  # noqa: BLE001 - the model must see the failure
            return _err(str(exc), query=query)
        return _ok(data)


class SaveMemoryTool(_HiveMindToolBase):
    """Persist a durable fact, decision, or finding into HIVE-MIND."""

    name: str = "hivemind_save_memory"

    description: str = """Save a durable fact, decision, or finding to the \
organization's HIVE-MIND memory so it is available to every future run.

Use for conclusions and verified findings — not for intermediate reasoning, \
which is already in the transcript."""

    is_read_only: bool = False

    class Params(BaseModel):
        title: str = Field(description="Short, specific, scannable title.")
        content: str = Field(description="The durable claim, in one to three sentences.")
        tags: list[str] = Field(default_factory=list, description="Tags for later retrieval.")

    input_schema: dict = Params.model_json_schema()

    async def call(
        self,
        title: str,
        content: str,
        tags: Optional[list[str]] = None,
    ) -> ToolChunk:
        try:
            data = await _call_hm_core(
                "/internal/hivemind/memories",
                user_id=self._user_id,
                org_id=self._org_id,
                body={"title": title, "content": content, "tags": tags or []},
            )
        except Exception as exc:  # noqa: BLE001
            return _err(str(exc), title=title)
        return _ok(data)


class CompanyContextTool(_HiveMindToolBase):
    """Read the organization's company profile and operating context."""

    name: str = "hivemind_company_context"

    description: str = """Read the organization's company profile AND the \
operator (the human you are talking to): full name, given/preferred name, \
email, plus what the company does, ICP, positioning, and operating context.

Call this FIRST on any identity question ("what is my name") and on any task \
that depends on who the company is. The `operator` object is authoritative \
for the user's name — do not invent a preferred name if it is present, and \
do not leave it blank in your reply."""

    class Params(BaseModel):
        """Optional note so the JSON schema is not an empty object (some models reject that)."""

        note: Optional[str] = Field(default=None, description="Optional. Do not set.")

    input_schema: dict = Params.model_json_schema()

    async def call(self, note: Optional[str] = None) -> ToolChunk:
        try:
            data = await _call_hm_core(
                "/internal/hivemind/company-context",
                user_id=self._user_id,
                org_id=self._org_id,
                method="GET",
            )
        except Exception as exc:  # noqa: BLE001
            return _err(str(exc))
        return _ok(data)


class SaveProspectTool(_HiveMindToolBase):
    """Add a qualified prospect to the organization's shared lead book."""

    name: str = "hivemind_save_prospect"

    description: str = """Save a qualified prospect to the organization's shared \
lead book so every future run reuses it instead of re-discovering it.

Include a personal note explaining why this prospect qualifies — the note is \
what a later run reads to decide whether to act on the lead."""

    is_read_only: bool = False

    class Params(BaseModel):
        company: str = Field(description="The prospect company name.")
        note: str = Field(description="Why this prospect qualifies — the personal note.")
        website: Optional[str] = Field(default=None, description="Optional website.")
        email: Optional[str] = Field(default=None, description="Optional contact email.")
        phone: Optional[str] = Field(default=None, description="Optional contact phone.")

    input_schema: dict = Params.model_json_schema()

    async def call(
        self,
        company: str,
        note: str,
        website: Optional[str] = None,
        email: Optional[str] = None,
        phone: Optional[str] = None,
    ) -> ToolChunk:
        try:
            data = await _call_hm_core(
                "/internal/hyper/prospects",
                user_id=self._user_id,
                org_id=self._org_id,
                body={
                    "company": company,
                    "note": note,
                    "website": website,
                    "email": email,
                    "phone": phone,
                },
            )
        except Exception as exc:  # noqa: BLE001
            return _err(str(exc), company=company)
        return _ok(data)


class ListProspectsTool(_HiveMindToolBase):
    """List prospects already in the organization's shared lead book."""

    name: str = "hivemind_list_prospects"

    description: str = """List prospects already saved in the organization's \
shared lead book.

Call this BEFORE searching for new prospects — the lead book may already \
contain what you need, and re-discovering a known lead wastes the run."""

    class Params(BaseModel):
        query: Optional[str] = Field(
            default=None,
            description="Optional filter on company name or note.",
        )

    input_schema: dict = Params.model_json_schema()

    async def call(self, query: Optional[str] = None) -> ToolChunk:
        try:
            path = "/internal/hyper/prospects"
            if query:
                from urllib.parse import quote

                path = f"{path}?q={quote(query)}"
            data = await _call_hm_core(
                path,
                user_id=self._user_id,
                org_id=self._org_id,
                method="GET",
            )
        except Exception as exc:  # noqa: BLE001
            return _err(str(exc))
        return _ok(data)


class WebSearchTool(_HiveMindToolBase):
    """Search the live web for information not held in HIVE-MIND."""

    name: str = "hivemind_web_search"

    description: str = """Search the live web for external information: company \
websites, public records, recent news.

Use ONLY for facts about the outside world — never for facts about this \
organization, which live in HIVE-MIND memory (use hivemind_recall instead). \
Searching the web for internal facts returns plausible strangers."""

    class Params(BaseModel):
        query: str = Field(description="The search query.")
        limit: int = Field(default=10, description="Maximum number of results.")

    input_schema: dict = Params.model_json_schema()

    async def call(self, query: str, limit: int = 10) -> ToolChunk:
        try:
            data = await _call_hm_core(
                "/internal/hivemind/web-search",
                user_id=self._user_id,
                org_id=self._org_id,
                body={"query": query, "limit": max(1, min(int(limit), 25))},
            )
        except Exception as exc:  # noqa: BLE001
            return _err(str(exc), query=query)
        return _ok(data)


class RecordArtifactTool(_HiveMindToolBase):
    """Register a produced artifact back into HIVE-MIND.

    The workspace owns the bytes; HIVE-MIND owns the pointer. Registering only
    after the file is flushed and non-zero is what makes an artifact claim
    evidence rather than prose.
    """

    name: str = "hivemind_record_artifact"

    description: str = """Register a file you produced in the workspace back into \
HIVE-MIND so it becomes a durable deliverable.

Call this AFTER the file is written and non-empty. Pass the workspace-relative \
path. Registering a path that does not exist is rejected — a claim of an \
artifact is not an artifact."""

    is_read_only: bool = False

    class Params(BaseModel):
        path: str = Field(description="Workspace-relative path of the produced file.")
        title: str = Field(description="Human-readable title for the artifact.")
        content_type: Optional[str] = Field(default=None, description="Optional MIME type.")

    input_schema: dict = Params.model_json_schema()

    async def call(
        self,
        path: str,
        title: str,
        content_type: Optional[str] = None,
    ) -> ToolChunk:
        try:
            data = await _call_hm_core(
                "/internal/hivemind/artifacts",
                user_id=self._user_id,
                org_id=self._org_id,
                body={
                    "path": path,
                    "title": title,
                    "content_type": content_type,
                    "agentscope_session_id": self._session_id,
                },
            )
        except Exception as exc:  # noqa: BLE001
            return _err(str(exc), path=path)
        return _ok(data)


class PlaybookListTool(_HiveMindToolBase):
    """Compact catalog of global, org, and WorkRun-local playbooks. No keyword routing."""

    name: str = "PlaybookList"
    description: str = """List available playbooks (id, name, description, scope).
Call this when the WorkRun playbook is General, then PlaybookGet the one you choose."""

    class Params(BaseModel):
        note: str = Field(default="", description="Unused.")

    input_schema: dict = Params.model_json_schema()

    async def call(self, note: str = "") -> ToolChunk:
        try:
            data = await _call_hm_core(
                "/internal/hivemind/playbooks",
                user_id=self._user_id,
                org_id=self._org_id,
                body={"agentscope_session_id": self._session_id},
            )
        except Exception as exc:  # noqa: BLE001
            return _err(str(exc))
        return _ok(data)


class PlaybookGetTool(_HiveMindToolBase):
    """Full playbook instructions after the agent chooses an id."""

    name: str = "PlaybookGet"
    description: str = """Load full instructions for one playbook id from PlaybookList."""

    class Params(BaseModel):
        id: str = Field(description="Playbook id, e.g. global:prospect-discovery")

    input_schema: dict = Params.model_json_schema()

    async def call(self, id: str) -> ToolChunk:
        try:
            data = await _call_hm_core(
                "/internal/hivemind/playbooks/get",
                user_id=self._user_id,
                org_id=self._org_id,
                body={"id": id, "agentscope_session_id": self._session_id},
            )
        except Exception as exc:  # noqa: BLE001
            return _err(str(exc), id=id)
        return _ok(data)


class ComposioToolsTool(_HiveMindToolBase):
    """List the third-party toolkits this organization has connected."""

    name: str = "hivemind_composio_tools"

    description: str = """List the third-party toolkits this organization has \
connected (Gmail, Sheets, and others).

Call this BEFORE hivemind_composio_execute. It returns only toolkits that \
actually have a grant behind them, so you do not attempt a call the \
organization has not authorized."""

    class Params(BaseModel):
        note: Optional[str] = Field(default=None, description="Optional. Do not set.")

    input_schema: dict = Params.model_json_schema()

    async def call(self, note: Optional[str] = None) -> ToolChunk:
        try:
            data = await _call_hm_core(
                "/internal/hivemind/composio/tools",
                user_id=self._user_id,
                org_id=self._org_id,
                method="GET",
            )
        except Exception as exc:  # noqa: BLE001
            return _err(str(exc))
        if isinstance(data, dict) and not data.get("connected_toolkits"):
            data = {
                **data,
                "need_connect": True,
                "note": "No third-party apps are connected. If the user named an app, they must connect it before you can read it.",
            }
        return _ok(data)


class ComposioExecuteTool(_HiveMindToolBase):
    """Run a tool on one of the organization's connected third-party accounts."""

    name: str = "hivemind_composio_execute"

    description: str = """Execute a tool on one of the organization's connected \
third-party accounts (send an email, append a row, create a document).

The organization's OAuth grants live in Composio; you never see or handle a \
credential. Call hivemind_composio_tools first to learn which toolkits are \
connected and what their tool slugs are.

This performs a REAL action on a real account. Do not call it to check whether \
something would work."""

    is_read_only: bool = False

    class Params(BaseModel):
        tool: str = Field(
            description="The provider tool slug, e.g. 'GMAIL_SEND_EMAIL'.",
        )
        args: dict = Field(
            default_factory=dict,
            description="Arguments for the provider tool, matching its schema.",
        )

    input_schema: dict = Params.model_json_schema()

    async def call(self, tool: str, args: Optional[dict] = None) -> ToolChunk:
        try:
            data = await _call_hm_core(
                "/internal/hivemind/composio/execute",
                user_id=self._user_id,
                org_id=self._org_id,
                body={"tool": tool, "args": args or {}},
            )
        except Exception as exc:  # noqa: BLE001
            msg = str(exc)
            toolkit = tool.split("_")[0].lower() if tool else None
            if any(s in msg.lower() for s in ("not connected", "no grant", "409", "unauthorized", "no connected")):
                return _err(msg, tool=tool, need_connect=True, toolkit=toolkit)
            return _err(msg, tool=tool)
        return _ok(data)


# ---------------------------------------------------------------------------
# The factory
# ---------------------------------------------------------------------------

# The capability set for the first vertical slice. Deliberately small: every
# tool here is one the prospect-research acceptance test actually needs. Adding
# a capability is adding a class above and a line here.
_TOOL_CLASSES = (
    CompanyContextTool,
    RecallTool,
    ListProspectsTool,
    SaveProspectTool,
    WebSearchTool,
    SaveMemoryTool,
    RecordArtifactTool,
    PlaybookListTool,
    PlaybookGetTool,
    ComposioToolsTool,
    ComposioExecuteTool,
)


async def hivemind_tools(
    user_id: str,
    agent_id: str,
    session_id: str,
) -> list[ToolBase]:
    """AgentScope `extra_agent_tools` factory.

    Called once per agent assembly. Returns the HIVE-MIND capability set bound
    to the resolved principal, so every tool call is scoped to the caller by
    hm-core rather than by anything the model can influence.

    `agent_id` and `session_id` are accepted because that is the factory's
    signature; they are not used to scope data. Tenancy is `user_id` + org, and
    hm-core is the authority on both — a tool that scoped on `agent_id` would be
    inventing a second, weaker boundary.

    There is deliberately NO org parameter here. AgentScope's
    ``AgentToolFactory`` is ``(user_id, agent_id, session_id)`` — it has no org,
    so the runtime genuinely does not know it and must not guess. An env-var
    default would be correct for exactly one tenant and wrong for every other,
    which is the worst possible failure shape: it works in testing and leaks
    across tenants in production. hm-core resolves the org from the user
    instead, because the user→org mapping is hm-core's data.
    """
    user_uuid, org_uuid = _split_principal(user_id, None)
    tools: list[ToolBase] = [cls(user_uuid, org_uuid, session_id) for cls in _TOOL_CLASSES]
    _log.info(
        "assembled %d HIVE-MIND tools for user=%s agent=%s session=%s",
        len(tools),
        user_id,
        agent_id,
        session_id,
    )
    return tools


def describe() -> str:
    if not HM_CORE_URL:
        return "hm-core=UNSET (HIVE-MIND tools will fail)"
    return f"hm-core={HM_CORE_URL} tools={[c.name for c in _TOOL_CLASSES]}"
