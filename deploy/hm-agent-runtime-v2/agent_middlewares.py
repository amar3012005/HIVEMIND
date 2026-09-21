# -*- coding: utf-8 -*-
"""extra_agent_middlewares factory.

Agentic memory (MEMORY.md) is AgentScope-native. Company evidence stays in
HIVE Core via extra_agent_tools — never written into MEMORY.md.

Composio workflow skill is seeded into the workspace skills/ dir (AgentScope
native Skill viewer), adapted from the DeepSeek harness
composio-connected-workflows skill. Tools remain extra_agent_tools — this
file is how-to, not a second tool runtime.
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from pathlib import Path, PurePosixPath
from typing import Any

_log = logging.getLogger("hm-agent-runtime.middleware")
_SESSION_WORKSPACES: OrderedDict[str, Any] = OrderedDict()
_MAX_TRACKED_WORKSPACES = 512

_COMPOSIO_SKILL = """---
name: composio-connected-workflows
description: Load for connected-app work (mail, CRM, Slack, LinkedIn). Simple reads use hivemind_composio_search_tools then hivemind_composio_session_execute.
---

# Composio connected workflows

HIVE memory and connected apps are separate evidence sources. Connectors.jsx
owns OAuth; the agent never invents a connection.

## Sequence (same as harness hivemind_connected_task)

1. Call `hivemind_composio_search_tools` first with a natural-language
   `use_case`. Name the app if known. Do not ask the user for Slack channels,
   mailbox IDs, or other provider-owned values before search reports
   connection status and discovery tools.
2. Reuse the returned `session_id` for every later execute. Never invent a
   tool slug — only execute slugs from search.
3. If search says no active toolkits, stop. Connection is a UI action
   (Connectors page), not an agent guess.
4. Reads may execute. Sends, posts, deletes, publishes wait for hm-core
   `approval_required` / `denied` / `executed`. Do not retry an executed receipt.
"""


def _seed_composio_skill(workdir: str) -> None:
    dest = Path(workdir) / "skills" / "composio-connected-workflows"
    dest.mkdir(parents=True, exist_ok=True)
    path = dest / "SKILL.md"
    if not path.exists():
        path.write_text(_COMPOSIO_SKILL, encoding="utf-8")


def _remember_workspace(session_id: str, workspace: Any) -> None:
    """Keep the AgentScope-owned workspace handle for an active session.

    A custom tool factory receives a session id but not the Workspace instance.
    The middleware factory receives both, so this small registry is the native
    bridge that lets ``hivemind_record_artifact`` read a file through the
    configured AgentScope backend (Docker, E2B, etc.). It intentionally stores
    no model-provided path and is bounded so old sessions cannot retain an
    unbounded number of sandbox handles.
    """
    if not session_id or workspace is None:
        return
    _SESSION_WORKSPACES[session_id] = workspace
    _SESSION_WORKSPACES.move_to_end(session_id)
    while len(_SESSION_WORKSPACES) > _MAX_TRACKED_WORKSPACES:
        _SESSION_WORKSPACES.popitem(last=False)


async def read_workspace_file(session_id: str, path: str, *, max_bytes: int) -> bytes:
    """Read one relative file via AgentScope's configured workspace backend."""
    workspace = _SESSION_WORKSPACES.get(session_id)
    if workspace is None:
        raise RuntimeError("workspace is unavailable for this AgentScope session")

    relative = PurePosixPath(str(path or ""))
    if not str(relative) or relative.is_absolute() or ".." in relative.parts:
        raise ValueError("artifact path must be a workspace-relative path")

    backend = workspace.get_backend()
    target = backend.join_path(str(workspace.workdir), *relative.parts)
    if not await backend.file_exists(target):
        raise FileNotFoundError(f"artifact file does not exist: {path}")
    payload = bytes(await backend.read_file(target))
    if not payload:
        raise ValueError("artifact file is empty")
    if len(payload) > max_bytes:
        raise ValueError(f"artifact exceeds the {max_bytes}-byte upload limit")
    return payload


async def hivemind_agent_middlewares(
    user_id: str,
    agent_id: str,
    session_id: str,
    workspace: Any = None,
) -> list:
    workdir = getattr(workspace, "workdir", None) if workspace is not None else None
    if not workdir:
        _log.debug(
            "no workspace.workdir for user=%s agent=%s session=%s; skip AgenticMemory",
            user_id,
            agent_id,
            session_id,
        )
        return []
    _remember_workspace(session_id, workspace)
    try:
        _seed_composio_skill(str(workdir))
    except OSError as exc:
        _log.warning("could not seed composio skill: %s", exc)
    from agentscope.middleware import AgenticMemoryMiddleware, TracingMiddleware

    # These are AgentScope middlewares, attached to every assembled agent. The
    # tracing middleware becomes a near-zero no-op until `setup_tracing()` has
    # installed a real OpenTelemetry provider; keeping it here avoids a second
    # execution/event pipeline when telemetry is enabled later.
    return [
        AgenticMemoryMiddleware(workdir=str(workdir)),
        TracingMiddleware(),
    ]
