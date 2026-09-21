# -*- coding: utf-8 -*-
"""Project native AgentScope team lifecycle into durable WorkRun events.

This module deliberately wraps the five built-in Team tools rather than
reimplementing them.  AgentScope still creates the TeamRecord, worker sessions,
inbox messages and wakeups.  The wrapper adds a small, storage-derived metadata
record to the native ``ToolResultEnd`` event, which the HIVE bridge already
persists.  It never parses the tool's human-facing response text.
"""
from __future__ import annotations

from typing import Any

from agentscope.tool import ToolChunk
from agentscope.tool._base import ToolBase


TEAM_TOOL_NAMES = frozenset({
    "TeamCreate", "TeamDelete", "TeamSay", "AgentCreate", "AgentInvite",
})


def _success(chunk: ToolChunk) -> bool:
    return str(getattr(chunk, "state", "")).lower() not in {
        "error", "denied", "interrupted",
    }


async def _team_for(tool: Any) -> Any | None:
    session = await tool._storage.get_session(
        tool._user_id, tool._agent_id, tool._session_id,
    )
    if session is None or not getattr(session, "team_id", None):
        return None
    return await tool._storage.get_team(tool._user_id, session.team_id)


def _team_data(team: Any, *, action: str) -> dict[str, Any]:
    return {
        "action": action,
        "team_id": str(getattr(team, "id", "")),
        "team_name": str(getattr(getattr(team, "data", None), "name", "")),
        "leader_session_id": str(getattr(team, "session_id", "")),
    }


async def _member_data(tool: Any, team: Any, name: str) -> dict[str, Any]:
    members = list(getattr(getattr(team, "data", None), "members", []) or [])
    for member in members:
        agent = await tool._storage.get_agent(member.owner_id, member.agent_id)
        if agent is not None and getattr(getattr(agent, "data", None), "name", None) == name:
            return {
                "member": name,
                "member_agent_id": str(member.agent_id),
                "member_session_id": str(member.session_id),
                "member_origin": str(getattr(member, "role", "created")),
            }
    return {"member": name}


class WorkRunTeamTool(ToolBase):
    """A transparent ToolBase decorator for source-verified team tools."""

    def __init__(self, delegate: ToolBase) -> None:
        super().__init__()
        self._delegate = delegate
        self.name = delegate.name
        self.description = delegate.description
        self.input_schema = delegate.input_schema
        self.is_concurrency_safe = delegate.is_concurrency_safe
        self.is_read_only = delegate.is_read_only
        self.is_state_injected = delegate.is_state_injected
        self.is_external_tool = delegate.is_external_tool
        self.is_mcp = delegate.is_mcp
        self.mcp_name = delegate.mcp_name

    async def check_permissions(self, tool_input: dict[str, Any], context: Any) -> Any:
        return await self._delegate.check_permissions(tool_input, context)

    async def call(self, **kwargs: Any) -> ToolChunk:
        before = await _team_for(self._delegate)
        result = await self._delegate(**kwargs)
        if not isinstance(result, ToolChunk) or not _success(result):
            return result

        after = await _team_for(self._delegate)
        action_by_tool = {
            "TeamCreate": "team_created",
            "TeamDelete": "team_deleted",
            "TeamSay": "message_sent",
            "AgentCreate": "member_created",
            "AgentInvite": "member_invited",
        }
        team = before if self.name == "TeamDelete" else after
        if team is None:
            return result

        metadata = _team_data(team, action=action_by_tool[self.name])
        if self.name in {"AgentCreate", "AgentInvite"}:
            metadata.update(await _member_data(self._delegate, team, str(kwargs.get("name", "member"))))
        elif self.name == "TeamSay":
            # Coordination content stays in AgentScope context.  HIVE only
            # receives the routing fact necessary to audit the WorkRun.
            metadata["recipient"] = str(kwargs.get("to") or "all")

        projected = result.model_copy(deep=True)
        projected.metadata = {**projected.metadata, "hivemind_team": metadata}
        return projected


def instrument_team_tools(toolkit: Any) -> None:
    """Replace only native team objects with transparent lifecycle wrappers."""
    for group in getattr(toolkit, "tool_groups", []):
        group.tools = [
            WorkRunTeamTool(tool)
            if getattr(tool, "name", "") in TEAM_TOOL_NAMES and not isinstance(tool, WorkRunTeamTool)
            else tool
            for tool in group.tools
        ]
