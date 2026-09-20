# -*- coding: utf-8 -*-
"""Progressively expose HIVE and native AgentScope capabilities.

AgentScope's stock toolkit places workspace, planning, team, and caller-extra
tools in the always-active ``basic`` group.  HIVE must not make the workspace
or team controls model-visible before the agent has selected a playbook and
created a native Task plan.  This adapter keeps only planning, playbook
selection, and cancellation in ``basic``; the stock AgentScope objects remain
their own ToolGroups and are activated through ``reset_tools``.

This is deliberately a toolkit assembly patch, not an execution loop.  The
AgentScope session still owns task state, tool calls, cancellation, and event
ordering.
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
TEAM_TOOL_NAMES = {
    "TeamCreate",
    "TeamDelete",
    "TeamSay",
    "AgentCreate",
    "AgentInvite",
}


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
    # Unknown extras must not silently become always-visible capabilities.
    # Extra factories are an extension seam, so make an owner explicitly opt
    # into basic exposure by adding its tool name to BASIC_NAMES.
    basic = buckets["basic"]
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
    if buckets["other"]:
        groups.append(
            ToolGroup(
                name="runtime_extensions",
                description="Additional HIVE runtime capabilities for a bounded task.",
                instructions="Activate only when the current planned task requires one of these capabilities.",
                tools=buckets["other"],
            ),
        )
    return basic, groups


def separate_native_tool_groups(toolkit: Any, workspace_tool_names: set[str]) -> None:
    """Move stock AgentScope workspace/team capabilities out of ``basic``.

    ``get_toolkit`` returns real ToolBase instances.  Moving those exact
    instances (rather than rebuilding them) preserves their session-bound
    state and schemas. Skills stay basic: AgentScope exposes only compact skill
    metadata there, and its native SkillViewer loads full SKILL.md content on
    demand. MCP clients stay with workspace tools because they are executable
    capabilities, not metadata.
    """
    basic_group = next((group for group in toolkit.tool_groups if group.name == "basic"), None)
    if basic_group is None:
        return

    workspace_tools = [
        tool for tool in basic_group.tools if getattr(tool, "name", "") in workspace_tool_names
    ]
    team_tools = [
        tool for tool in basic_group.tools if getattr(tool, "name", "") in TEAM_TOOL_NAMES
    ]
    moved_names = {getattr(tool, "name", "") for tool in workspace_tools + team_tools}
    basic_group.tools = [
        tool for tool in basic_group.tools if getattr(tool, "name", "") not in moved_names
    ]

    if workspace_tools or basic_group.mcps:
        toolkit.tool_groups.append(
            ToolGroup(
                name="workspace",
                description="Read and write the task workspace, and use workspace MCP tools when a planned task requires them.",
                instructions="Use only after the playbook is selected, the relevant Skill is read, and an AgentScope Task explains the workspace work.",
                tools=workspace_tools,
                mcps=basic_group.mcps,
            ),
        )
        basic_group.mcps = []

    if team_tools:
        toolkit.tool_groups.append(
            ToolGroup(
                name="team_tools",
                description="Create, coordinate, and close an AgentScope team for work that needs explicit delegation.",
                instructions="Do not create a team by default. Activate only when the selected playbook or task plan requires delegated work.",
                tools=team_tools,
            ),
        )


def patch_get_toolkit() -> None:
    """Patch ChatService's get_toolkit so HIVE tools become native ToolGroups."""
    import agentscope.app._service._chat as chat_mod
    import agentscope.app._service._toolkit as tk_mod

    orig: Callable[..., Any] = tk_mod.get_toolkit

    async def grouped_get_toolkit(*args: Any, extra_factory=None, **kwargs: Any):
        captured: list[ToolBase] = []
        workspace = kwargs.get("workspace")
        workspace_tool_names: set[str] = set()
        if workspace is not None:
            workspace_tool_names = {
                getattr(tool, "name", "") for tool in await workspace.list_tools()
            }

        async def capture(user_id: str, agent_id: str, session_id: str) -> list[ToolBase]:
            if extra_factory is None:
                return []
            captured.extend(await extra_factory(user_id, agent_id, session_id))
            basic, _groups = extra_groups_for(captured)
            return basic

        toolkit = await orig(*args, extra_factory=capture, **kwargs)
        separate_native_tool_groups(toolkit, workspace_tool_names)
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
