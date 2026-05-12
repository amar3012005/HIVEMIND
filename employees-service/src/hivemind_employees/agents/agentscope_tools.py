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
from __future__ import annotations

import json
import logging
import os
from typing import Optional

import httpx
from agentscope.tool import Toolkit

log = logging.getLogger(__name__)

HIVEMIND_TIMEOUT_S = 30.0


def _client(api_key: str) -> httpx.Client:
    base = os.environ.get("HIVEMIND_CORE_URL", "http://hm-core:3000")
    return httpx.Client(
        base_url=base,
        timeout=httpx.Timeout(HIVEMIND_TIMEOUT_S, connect=5.0),
        headers={
            "Authorization": f"Bearer {api_key}",
            "X-API-Key": api_key,
            "Content-Type": "application/json",
        },
    )


def _post_slack_action(api_key: str, action_type: str, payload: dict) -> dict:
    with _client(api_key) as c:
        r = c.post(
            "/api/employees/slack-action",
            json={"action_type": action_type, "payload": payload},
        )
        r.raise_for_status()
        return r.json()


def build_hivemind_toolkit(api_key: str, enabled_tool_names: list[str]) -> Toolkit:
    """Return an AgentScope Toolkit populated with HIVEMIND tools.

    enabled_tool_names mirrors the schema used by `tools.py`:
        hivemind_slack_post, hivemind_slack_react, hivemind_slack_search,
        hivemind_slack_history, hivemind_recall, hivemind_save_memory.
    """
    tk = Toolkit()

    if "hivemind_slack_post" in enabled_tool_names:
        def slack_post(channel: str, text: str, thread_ts: Optional[str] = None) -> str:
            """Post a message to a Slack channel or thread.

            Args:
                channel: Slack channel ID (e.g. C01ABCDEF).
                text: Message body.
                thread_ts: Optional thread timestamp to reply in-thread.
            """
            res = _post_slack_action(api_key, "slack_post", {
                "channel": channel, "text": text, "thread_ts": thread_ts,
            })
            return json.dumps(res)
        tk.register_tool_function(slack_post)

    if "hivemind_slack_react" in enabled_tool_names:
        def slack_react(channel: str, ts: str, emoji: str) -> str:
            """Add an emoji reaction to a Slack message.

            Args:
                channel: Slack channel ID.
                ts: Message timestamp to react to.
                emoji: Emoji name without colons (e.g. "thumbsup").
            """
            res = _post_slack_action(api_key, "slack_react", {
                "channel": channel, "ts": ts, "emoji": emoji,
            })
            return json.dumps(res)
        tk.register_tool_function(slack_react)

    if "hivemind_slack_search" in enabled_tool_names:
        def slack_search(query: str, count: int = 10) -> str:
            """Search Slack workspace messages.

            Args:
                query: Search query string.
                count: Max results (default 10).
            """
            res = _post_slack_action(api_key, "slack_search", {
                "query": query, "count": count,
            })
            return json.dumps(res)
        tk.register_tool_function(slack_search)

    if "hivemind_slack_history" in enabled_tool_names:
        def slack_history(channel: str, limit: int = 50, since: Optional[str] = None) -> str:
            """Fetch recent Slack channel history.

            Args:
                channel: Slack channel ID.
                limit: Max messages (default 50).
                since: Optional ISO-8601 timestamp lower bound.
            """
            res = _post_slack_action(api_key, "slack_history", {
                "channel": channel, "limit": limit, "since": since,
            })
            return json.dumps(res)
        tk.register_tool_function(slack_history)

    if "hivemind_recall" in enabled_tool_names:
        def recall(query: str, max_memories: int = 5) -> str:
            """Recall memories from HIVEMIND knowledge graph.

            Args:
                query: What to search for.
                max_memories: Max memories to return (default 5).
            """
            with _client(api_key) as c:
                r = c.post("/api/recall", json={
                    "query_context": query, "max_memories": max_memories,
                })
                r.raise_for_status()
                return json.dumps(r.json())
        tk.register_tool_function(recall)

    if "hivemind_save_memory" in enabled_tool_names:
        def save_memory(title: str, content: str, tags: Optional[str] = None) -> str:
            """Save a fact or note to HIVEMIND persistent memory.

            Args:
                title: Short descriptive title.
                content: The content to remember.
                tags: Comma-separated tags (e.g. "decision,pricing,q1").
            """
            tag_list = [t.strip() for t in (tags or "").split(",") if t.strip()]
            with _client(api_key) as c:
                r = c.post("/api/memories", json={
                    "title": title, "content": content, "tags": tag_list, "sync": True,
                })
                r.raise_for_status()
                return json.dumps(r.json())
        tk.register_tool_function(save_memory)

    log.info("Built AgentScope toolkit (tools=%s)", enabled_tool_names)
    return tk
