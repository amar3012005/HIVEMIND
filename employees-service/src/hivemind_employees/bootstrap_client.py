"""Bootstrap client — pulls the full employee + Slack-token snapshot
from HIVEMIND control-plane using the master API key.

Replaces the env-var-per-employee path that we had in Phase 2.3.
Slack app tokens (xapp-) remain admin-managed via env vars because
they're per-app, not per-OAuth-grant.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Dict, List, Optional

import httpx

log = logging.getLogger(__name__)

_CACHE: Dict[str, Dict] = {}
_CACHE_TS = 0.0
_CACHE_LOCK = asyncio.Lock()


async def fetch_bootstrap() -> List[Dict]:
    """Pull the live employee snapshot from control-plane. Best-effort;
    returns [] if the endpoint is unreachable (sidecar runs in degraded
    mode but stays up)."""
    cp_url = os.environ.get("HIVEMIND_CP_URL", "http://hm-control:3000")
    master_key = os.environ.get("HIVEMIND_MASTER_API_KEY", "")
    if not master_key:
        log.warning("bootstrap: HIVEMIND_MASTER_API_KEY not set")
        return []

    async with httpx.AsyncClient(base_url=cp_url, timeout=httpx.Timeout(15.0, connect=5.0)) as c:
        try:
            r = await c.get(
                "/v1/employees/bootstrap",
                headers={"Authorization": f"Bearer {master_key}"},
            )
            r.raise_for_status()
        except Exception as e:
            log.warning("bootstrap fetch failed: %s", e)
            return []
        try:
            data = r.json()
            return data.get("employees", []) or []
        except Exception as e:
            log.warning("bootstrap parse failed: %s", e)
            return []


async def report_sidecar_status(employee_id: str, status: str, error_message: Optional[str] = None) -> None:
    """Best-effort PUT to /v1/employees/:id/sidecar-status so the UI
    badge flips automatically. Never raises."""
    cp_url = os.environ.get("HIVEMIND_CP_URL", "http://hm-control:3000")
    master_key = os.environ.get("HIVEMIND_MASTER_API_KEY", "")
    if not master_key:
        return
    payload: Dict[str, object] = {"status": status}
    if error_message:
        payload["error_message"] = error_message
    async with httpx.AsyncClient(base_url=cp_url, timeout=5.0) as c:
        try:
            await c.put(
                f"/v1/employees/{employee_id}/sidecar-status",
                headers={"Authorization": f"Bearer {master_key}"},
                json=payload,
            )
        except Exception as e:
            log.debug("status report failed for %s: %s", employee_id, e)
