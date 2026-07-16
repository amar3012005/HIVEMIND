"""HIVEMIND MCP tools as SlackAgents-compatible FunctionTool callbacks.

SlackAgents tool callbacks are synchronous, so we use httpx.Client (sync)
here. The Slack bolt handler runs in async context but invokes the
assistant in a thread executor — so blocking I/O is fine.

Every tool routes through the SAME core endpoints used by the Node MCP
server, so policy gate + audit + auto-ingest are enforced centrally.
"""
from __future__ import annotations

import json
import logging
import os
import httpx
from typing import Optional, Any

from slackagents.tools.function_tool import FunctionTool

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


# ── Public tool factories (return FunctionTool instances) ──────────────────

def build_hivemind_tools(
    api_key: str,
    enabled_tool_names: list[str],
) -> list[FunctionTool]:
    """Construct FunctionTool instances for every tool name in
    enabled_tool_names. Closes over the employee's API key so each
    callback authenticates as that employee."""

    tools: list[FunctionTool] = []

    # ── Slack actions ───────────────────────────────────────────
    if "hivemind_slack_post" in enabled_tool_names:
        def slack_post(channel: str, text: str, thread_ts: Optional[str] = None) -> str:
            """Post a message to a Slack channel or thread.
            :param channel: Slack channel ID (e.g. C01ABCDEF)
            :param text: Message text
            :param thread_ts: Optional thread timestamp to reply in-thread
            """
            res = _post_slack_action(api_key, "slack_post", {
                "channel": channel, "text": text, "thread_ts": thread_ts,
            })
            return json.dumps(res)
        tools.append(FunctionTool.from_function(slack_post))

    if "hivemind_slack_react" in enabled_tool_names:
        def slack_react(channel: str, ts: str, emoji: str) -> str:
            """Add an emoji reaction to a Slack message.
            :param channel: Slack channel ID
            :param ts: Message timestamp
            :param emoji: Emoji name without colons (e.g. "thumbsup")
            """
            res = _post_slack_action(api_key, "slack_react", {
                "channel": channel, "ts": ts, "emoji": emoji,
            })
            return json.dumps(res)
        tools.append(FunctionTool.from_function(slack_react))

    if "hivemind_slack_search" in enabled_tool_names:
        def slack_search(query: str, count: int = 10) -> str:
            """Search messages across the Slack workspace.
            :param query: Search query
            :param count: Max results (default 10)
            """
            res = _post_slack_action(api_key, "slack_search", {
                "query": query, "count": count,
            })
            return json.dumps(res)
        tools.append(FunctionTool.from_function(slack_search))

    if "hivemind_slack_history" in enabled_tool_names:
        def slack_history(channel: str, limit: int = 50, since: Optional[str] = None) -> str:
            """Fetch recent messages from a Slack channel.
            :param channel: Slack channel ID
            :param limit: Max messages (default 50)
            :param since: Optional ISO timestamp lower bound
            """
            res = _post_slack_action(api_key, "slack_history", {
                "channel": channel, "limit": limit, "since": since,
            })
            return json.dumps(res)
        tools.append(FunctionTool.from_function(slack_history))

    # ── Memory ───────────────────────────────────────────────────
    if "hivemind_recall" in enabled_tool_names:
        def recall(query: str, max_memories: int = 5) -> str:
            """Recall memories from HIVEMIND knowledge graph.
            :param query: What to search for
            :param max_memories: Max memories to return (default 5)
            """
            with _client(api_key) as c:
                r = c.post("/api/recall", json={
                    "query_context": query, "max_memories": max_memories,
                    "mode": "explain",
                })
                r.raise_for_status()
                return json.dumps(r.json())
        tools.append(FunctionTool.from_function(recall))

    if "hivemind_save_memory" in enabled_tool_names:
        def save_memory(title: str, content: str, tags: Optional[str] = None) -> str:
            """Save a fact or note to HIVEMIND persistent memory.
            :param title: Short descriptive title
            :param content: The content to remember
            :param tags: Comma-separated tags (e.g. "decision,pricing,q1")
            """
            tag_list = [t.strip() for t in (tags or "").split(",") if t.strip()]
            with _client(api_key) as c:
                r = c.post("/api/memories", json={
                    "title": title, "content": content, "tags": tag_list, "sync": True,
                })
                r.raise_for_status()
                return json.dumps(r.json())
        tools.append(FunctionTool.from_function(save_memory))

    log.info("Built %d HIVEMIND tools for employee API key", len(tools))
    return tools
