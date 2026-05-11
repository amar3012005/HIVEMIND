"""Audit helper — fire-and-forget logs to HIVEMIND core."""
from __future__ import annotations

import httpx
import logging
from typing import Optional, Dict, Any

from .config import get_settings

log = logging.getLogger(__name__)


async def emit(
    event_type: str,
    *,
    org_id: Optional[str] = None,
    user_id: Optional[str] = None,
    action: str = "execute",
    resource_type: Optional[str] = None,
    resource_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    """Best-effort audit row creation. Never raises — audit must not
    break the hot path."""
    settings = get_settings()
    if not settings.hivemind_master_api_key:
        log.debug("audit.emit skipped: no master key")
        return
    try:
        async with httpx.AsyncClient(
            base_url=settings.hivemind_core_url,
            timeout=httpx.Timeout(5.0, connect=2.0),
        ) as c:
            await c.post(
                "/api/audit/log",
                headers={"X-API-Key": settings.hivemind_master_api_key},
                json={
                    "event_type": event_type,
                    "event_category": "employee",
                    "action": action,
                    "organization_id": org_id,
                    "user_id": user_id,
                    "actor_type": "service",
                    "resource_type": resource_type,
                    "resource_id": resource_id,
                    "metadata": metadata or {},
                },
            )
    except Exception as e:
        log.warning("audit.emit failed for %s: %s", event_type, e)
