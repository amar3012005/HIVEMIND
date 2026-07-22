"""Connector Runtime V1 — HyperAgents MCP projection (plan §5, Phase 6).

Registers each granted connector as an INACTIVE AgentScope tool group backed by
the Core stateless MCP gateway, using the NATIVE agentscope 1.0.21 MCP client
(HttpStatelessClient + Toolkit.register_mcp_client). The Phase-1 spike proved
this exact path (protocol 2025-11-25). NO per-provider Python is written — the
gateway serves the canonical schemas; the capability token rides in the
Authorization header.

This replaces the hand-written provider functions in agentscope_tools.py when
CONNECTOR_RUNTIME_HYPER is enabled. Flag-off → this module is never imported.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import logging
from typing import List, Optional, Dict, Any

from agentscope.tool import Toolkit
from agentscope.mcp import HttpStatelessClient

from ..config import get_settings
from .runtime_client import fetch_capability

log = logging.getLogger("connector-runtime.mcp_projection")


def _mcp_base() -> str:
    # streamable-HTTP MCP endpoints live at <core>/mcp/connectors/<id>. AgentScope's
    # HttpStatelessClient opens+closes a session per call (stateless) — matches the
    # gateway's design and horizontally-scaled room workers.
    return f"{get_settings().hivemind_core_url.rstrip('/')}/mcp/connectors"


async def _register_async(
    tk: Toolkit,
    *,
    capability_token: str,
    connectors: List[Dict[str, Any]],
    execution_timeout: float = 15.0,
) -> List[str]:
    """Create one inactive group per connector + register its gateway tools.
    Returns the connector ids successfully registered."""
    registered: List[str] = []
    headers = {"Authorization": f"Bearer {capability_token}"}
    for conn in connectors:
        cid = conn.get("id")
        if not cid:
            continue
        try:
            tk.create_tool_group(
                cid,
                description=conn.get("description") or f"{cid} connector",
                active=False,  # inactive until the Director/agent equips it
            )
            client = HttpStatelessClient(
                name=cid,
                transport="streamable_http",
                url=f"{_mcp_base()}/{cid}",
                headers=headers,
            )
            await tk.register_mcp_client(
                client,
                group_name=cid,
                execution_timeout=execution_timeout,
                namesake_strategy="skip",  # tolerate re-registration
            )
            registered.append(cid)
        except Exception as e:  # one bad connector must not sink the room
            log.warning("[connector-runtime] register %s failed: %s", cid, e)
    return registered


def _run_async(coro):
    """Run an async coroutine from a sync context, whether or not a loop runs."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop and loop.is_running():
        # inside a running loop → offload to a worker thread with its own loop
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
            return ex.submit(lambda: asyncio.run(coro)).result()
    return asyncio.run(coro)


def register_runtime_connectors(
    tk: Toolkit,
    *,
    api_key: str,
    user_id: Optional[str],
    org_id: Optional[str],
    connectors: List[str],
    read_only: bool = False,
    room_id: Optional[str] = None,
) -> List[str]:
    """Sync entry called from _register_connector_tools. Fetches a capability
    token, then registers the granted connectors as inactive MCP-backed groups.
    Returns the registered connector ids ([] on failure → caller may fall back)."""
    if not connectors:
        return []
    cap = fetch_capability(
        api_key=api_key, user_id=user_id, org_id=org_id,
        surface="hyperagents",
        connectors=connectors,
        access="read" if read_only else "write",
        room_id=room_id,
    )
    token = cap.get("capability_token")
    granted = cap.get("connectors") or []
    if not token or not granted:
        log.warning("[connector-runtime] no capability granted (connectors=%s) — falling back", connectors)
        return []
    return _run_async(_register_async(tk, capability_token=token, connectors=granted))
