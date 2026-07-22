"""Connector Runtime V1 — capability fetch for HyperAgents (plan §5/§6).

Requests a short-lived capability token from Core's authenticated capability
endpoint. Core derives the user/org/role/projects from the authenticated caller;
this client only states the surface + requested connectors + access level.

No provider credentials ever cross this boundary — only the capability token,
which the stateless MCP gateway validates.
"""
from __future__ import annotations

import os
from typing import List, Optional, Dict, Any

import httpx

from ..config import settings


def _headers(api_key: str, user_id: Optional[str], org_id: Optional[str]) -> Dict[str, str]:
    """Bearer + master-key emulation headers, mirroring hivemind_client."""
    effective = api_key or ""
    extra: Dict[str, str] = {}
    if not effective:
        master = os.environ.get("HIVEMIND_MASTER_API_KEY") or os.environ.get("API_MASTER_KEY") or ""
        effective = master
        if user_id:
            extra["X-HM-User-Id"] = user_id
        if org_id:
            extra["X-HM-Org-Id"] = org_id
    h = {"Content-Type": "application/json"}
    if effective:
        h["Authorization"] = f"Bearer {effective}"
        h["X-API-Key"] = effective
    h.update(extra)
    return h


def fetch_capability(
    *,
    api_key: str,
    user_id: Optional[str],
    org_id: Optional[str],
    surface: str = "hyperagents",
    connectors: Optional[List[str]] = None,
    access: str = "read",
    room_id: Optional[str] = None,
    timeout: float = 10.0,
) -> Dict[str, Any]:
    """POST /api/connectors/runtime/capabilities → {capability_token, connectors, expires_at}.

    Returns {} on any failure (caller falls back to the legacy connector path).
    """
    body: Dict[str, Any] = {"surface": surface, "requested_access": access}
    if connectors:
        body["requested_connectors"] = list(connectors)
    if room_id:
        body["room_id"] = room_id
    try:
        with httpx.Client(base_url=settings.hivemind_core_url, timeout=timeout,
                          headers=_headers(api_key, user_id, org_id)) as c:
            r = c.post("/api/connectors/runtime/capabilities", json=body)
            if r.status_code != 200:
                return {}
            return r.json() or {}
    except Exception:
        return {}
