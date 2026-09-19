# -*- coding: utf-8 -*-
"""Split HIVE extra_agent_tools into AgentScope ToolGroups.

extra_factory tools are merged into Toolkit `tools=` (the reserved basic
group). Native grouping is ToolGroup + reset_tools. We wrap get_toolkit so
PlaybookList/Get stay basic; everything else is a named group.
"""
from __future__ import annotations

from typing import Any, Callable

from agentscope.tool import ToolGroup
from agentscope.tool._base import ToolBase

HIVEMIND_NAMES = {
    "hivemind_company_context",
    "hivemind_recall",
    "hivemind_list_prospects",
    "hivemind_save_prospect",
    "hivemind_save_memory",
    "hivemind_record_artifact",
}
WEB_NAMES = {"hivemind_web_search"}
APPS_NAMES = {"hivemind_composio_tools", "hivemind_composio_execute"}
BASIC_NAMES = {"PlaybookList", "PlaybookGet"}


def partition_hive_tools(tools: list[ToolBase]) -> dict[str, list[ToolBase]]:
    buckets = {
        "basic": [],
        "hivemind": [],
        "web_research": [],
        "connected_apps": [],
        "other": [],
    }
    for tool in tools:
        name = getattr(tool, "name", "")
        if name in BASIC_NAMES:
            buckets["basic"].append(tool)
        elif name in HIVEMIND_NAMES:
            buckets["hivemind"].append(tool)
        elif name in WEB_NAMES:
            buckets["web_research"].append(tool)
        elif name in APPS_NAMES:
            buckets["connected_apps"].append(tool)
        else:
            buckets["other"].append(tool)
    return buckets


def extra_groups_for(tools: list[ToolBase]) -> tuple[list[ToolBase], list[ToolGroup]]:
    buckets = partition_hive_tools(tools)
    basic = buckets["basic"] + buckets["other"]
    groups: list[ToolGroup] = []
    if buckets["hivemind"]:
        groups.append(
            ToolGroup(
                name="hivemind",
                description="Company memory, prospects, artifacts, and ICP.",
                instructions="Call hivemind_company_context first on identity or ICP questions.",
                tools=buckets["hivemind"],
            ),
        )
    if buckets["web_research"]:
        groups.append(
            ToolGroup(
                name="web_research",
                description="Search and read the public internet.",
                instructions="Prefer first-party sources. Do not invent URLs.",
                tools=buckets["web_research"],
            ),
        )
    if buckets["connected_apps"]:
        groups.append(
            ToolGroup(
                name="connected_apps",
                description="Discover and act through org-connected apps (Composio).",
                instructions="If need_connect, stop and ask the user to connect. Execute writes once.",
                tools=buckets["connected_apps"],
            ),
        )
    return basic, groups


def patch_get_toolkit() -> None:
    """Patch ChatService's get_toolkit so HIVE tools become native ToolGroups."""
    import agentscope.app._service._chat as chat_mod
    import agentscope.app._service._toolkit as tk_mod

    orig: Callable[..., Any] = tk_mod.get_toolkit

    async def grouped_get_toolkit(*args: Any, extra_factory=None, **kwargs: Any):
        captured: list[ToolBase] = []

        async def capture(user_id: str, agent_id: str, session_id: str) -> list[ToolBase]:
            if extra_factory is None:
                return []
            captured.extend(await extra_factory(user_id, agent_id, session_id))
            basic, _groups = extra_groups_for(captured)
            return basic

        toolkit = await orig(*args, extra_factory=capture, **kwargs)
        _basic, groups = extra_groups_for(captured)
        for group in groups:
            if all(g.name != group.name for g in toolkit.tool_groups):
                toolkit.tool_groups.append(group)
        if groups:
            from agentscope.tool._builtin import ResetTools
            from agentscope.tool._types import RegisteredTool

            toolkit.builtin_meta_tool = RegisteredTool(
                tool=ResetTools(
                    groups=toolkit.tool_groups,
                    response_template=toolkit.meta_tool_response_template,
                ),
            )
        return toolkit

    tk_mod.get_toolkit = grouped_get_toolkit
    chat_mod.get_toolkit = grouped_get_toolkit
