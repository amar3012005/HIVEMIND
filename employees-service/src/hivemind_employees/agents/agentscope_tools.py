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

import json
import logging
import os
from typing import List, Optional

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
    """Register a live-MCP toolkit for each granted 3rd-party connector
    (P3 of HyperAgents×Connectors). For connector "github" the agent gets
    `github_list_tools()` (discover) + `github_call(tool_name, arguments)`
    (invoke). Both POST the core bridge /api/connectors/mcp/exec|inspect,
    which resolves the room owner's Nango token server-side. The agent only
    sees connectors the user GRANTED it for this room.
    """
    for raw in connectors or []:
        conn = str(raw or "").strip()
        if not conn:
            continue
        safe = conn.replace("-", "_")

        def _make(conn_name: str, safe_name: str):
            def _list() -> ToolResponse:
                with _client(api_key, user_id, org_id) as c:
                    r = c.post("/api/connectors/mcp/inspect", json={"name": conn_name})
                    r.raise_for_status()
                    return _tool_response(r.json())

            def _call(tool_name: str, arguments: Optional[dict] = None) -> ToolResponse:
                with _client(api_key, user_id, org_id) as c:
                    r = c.post("/api/connectors/mcp/exec", json={
                        "name": conn_name,
                        "operation": {"type": "tool", "name": tool_name, "arguments": arguments or {}},
                    })
                    r.raise_for_status()
                    return _tool_response(r.json())

            _list.__name__ = f"{safe_name}_list_tools"
            _list.__doc__ = (
                f"List the tools available on the {conn_name} connector (a 3rd-party "
                f"MCP integration the user granted this room). Call this FIRST to see "
                f"what {conn_name} tool_name values {safe_name}_call accepts."
            )
            _call.__name__ = f"{safe_name}_call"
            _call.__doc__ = (
                f"Invoke a tool on the {conn_name} connector. tool_name must be one "
                f"returned by {safe_name}_list_tools; arguments is that tool's input "
                f"object. Use only when the room task needs live {conn_name} data/action; "
                f"cite what you pull."
            )
            return _list, _call

        lst, cll = _make(conn, safe)
        tk.register_tool_function(lst)
        tk.register_tool_function(cll)


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
                if project_id:
                    body["project_id"] = project_id
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
