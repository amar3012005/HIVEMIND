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
import os
from pathlib import Path
from typing import Any

_log = logging.getLogger("hm-agent-runtime.middleware")

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


async def hivemind_agent_middlewares(
    user_id: str,
    agent_id: str,
    session_id: str,
    workspace: Any = None,
) -> list:
    from agentscope.middleware import AgenticMemoryMiddleware, TracingMiddleware

    middlewares = []
    if os.getenv("AGENTSCOPE_OTEL_ENABLED", "0") == "1":
        middlewares.append(TracingMiddleware())
    workdir = getattr(workspace, "workdir", None) if workspace is not None else None
    if not workdir:
        _log.debug(
            "no workspace.workdir for user=%s agent=%s session=%s; skip AgenticMemory",
            user_id,
            agent_id,
            session_id,
        )
        return middlewares
    try:
        _seed_composio_skill(str(workdir))
    except OSError as exc:
        _log.warning("could not seed composio skill: %s", exc)
    middlewares.insert(0, AgenticMemoryMiddleware(workdir=str(workdir)))
    return middlewares
