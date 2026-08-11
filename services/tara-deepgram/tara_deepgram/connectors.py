"""Connector Runtime V1 — TARA voice-safe projection (plan §5 TARA).

Flag-gated (CONNECTOR_RUNTIME_TARA). Gives the voice agent a RESTRICTED,
read-only connector capability (surface=tara): a small set of voice-safe
connector tools (calendar/contact/doc lookups) fetched from the Core stateless
MCP gateway. NO write tools in voice (outbound stays draft-only per policy);
short result budget; NO broad enterprise catalog.

Produces Deepgram function-defs to append to FUNCTION_DEFS and dispatches
FunctionCallRequests to the gateway tools/call. Provider credentials never
reach TARA — only the 5-min capability token.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List, Optional

import httpx

from .config import HIVEMIND_CORE_URL

log = logging.getLogger("tara_dg.connectors")

# Voice is read-only + tightly scoped. Only these connectors are ever offered to
# the voice agent, and only their read tools (the gateway read-grant enforces it
# server-side too — this is defence in depth + a small voice action space).
_VOICE_CONNECTORS = [c.strip() for c in os.getenv(
    "CONNECTOR_RUNTIME_TARA_CONNECTORS", "google_calendar,google_docs").split(",") if c.strip()]


def _enabled() -> bool:
    return os.getenv("CONNECTOR_RUNTIME_TARA", "").lower() in ("1", "true", "yes", "on")


def _headers(user_id: Optional[str], org_id: Optional[str]) -> Dict[str, str]:
    master = os.environ.get("HIVEMIND_MASTER_API_KEY") or os.environ.get("API_MASTER_KEY") or ""
    h = {"Content-Type": "application/json"}
    if master:
        h["Authorization"] = f"Bearer {master}"
        h["X-API-Key"] = master
    if user_id:
        h["X-HM-User-Id"] = user_id
    if org_id:
        h["X-HM-Org-Id"] = org_id
    return h


class TaraConnectorBridge:
    """Fetches a tara capability + projects voice-safe connector tools."""

    def __init__(self, *, user_id: Optional[str], org_id: Optional[str], timeout: float = 8.0):
        self.user_id = user_id
        self.org_id = org_id
        self.timeout = timeout
        self._token: Optional[str] = None
        self._defs: List[dict] = []
        self._tool_conn: Dict[str, str] = {}  # canonical tool name -> connector id

    def enabled(self) -> bool:
        return _enabled()

    async def prepare(self) -> List[dict]:
        """Fetch capability + gateway tools/list → Deepgram function defs. Safe: [] on any failure."""
        if not _enabled():
            return []
        try:
            async with httpx.AsyncClient(base_url=HIVEMIND_CORE_URL, timeout=self.timeout,
                                         headers=_headers(self.user_id, self.org_id)) as c:
                cap = await c.post("/api/connectors/runtime/capabilities", json={
                    "surface": "tara", "requested_connectors": _VOICE_CONNECTORS, "requested_access": "read",
                })
                if cap.status_code != 200:
                    log.info("tara capability not granted (%s)", cap.status_code)
                    return []
                capj = cap.json()
                self._token = capj.get("capability_token")
                conns = capj.get("connectors") or []
                for conn in conns:
                    cid = conn.get("id")
                    if not cid:
                        continue
                    tl = await c.post(f"/mcp/connectors/{cid}",
                                      headers={**_headers(self.user_id, self.org_id), "Authorization": f"Bearer {self._token}"},
                                      json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
                    tools = ((tl.json() or {}).get("result") or {}).get("tools") or []
                    for t in tools:
                        name = t.get("name")
                        if not name:
                            continue
                        self._tool_conn[name] = cid
                        self._defs.append({
                            "name": name,
                            "description": (t.get("description") or "")[:300],
                            "parameters": t.get("inputSchema") or {"type": "object", "properties": {}},
                        })
            return self._defs
        except Exception as e:
            log.warning("tara connector prepare failed: %s", e)
            return []

    def handles(self, name: str) -> bool:
        return name in self._tool_conn

    async def dispatch(self, name: str, args: Dict[str, Any]) -> str:
        """Execute a connector tool via the gateway; return a short text result for voice."""
        cid = self._tool_conn.get(name)
        if not cid or not self._token:
            return json.dumps({"ok": False, "error": "connector unavailable"})
        try:
            async with httpx.AsyncClient(base_url=HIVEMIND_CORE_URL, timeout=self.timeout) as c:
                r = await c.post(f"/mcp/connectors/{cid}",
                                 headers={**_headers(self.user_id, self.org_id), "Authorization": f"Bearer {self._token}"},
                                 json={"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                                       "params": {"name": name, "arguments": args or {}}})
                result = (r.json() or {}).get("result") or {}
                blocks = result.get("content") or []
                text = " ".join(b.get("text", "") for b in blocks if isinstance(b, dict))
                return (text or "No result.")[:1200]  # small voice budget
        except Exception as e:
            log.warning("tara connector dispatch %s failed: %s", name, e)
            return json.dumps({"ok": False, "error": "connector call failed"})
