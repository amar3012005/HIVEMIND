"""Shared HIVEMIND core helpers: fire-and-forget call-history posts + config fetch."""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, Optional

import httpx

from . import config

log = logging.getLogger("tara_dg.core")


def _headers(user_id: Optional[str], org_id: Optional[str]) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {config.HIVEMIND_API_KEY}",
        "X-API-Key": config.HIVEMIND_API_KEY,
        "X-HM-User-Id": user_id or "",
        "X-HM-Org-Id": org_id or "",
        "Content-Type": "application/json",
    }


async def core_post(path: str, payload: dict, user_id: Optional[str], org_id: Optional[str]) -> None:
    """Fire-and-forget POST to core (call-history ingest). Never raises."""
    try:
        async with httpx.AsyncClient(timeout=10, verify=config.VERIFY_TLS) as c:
            await c.post(f"{config.HIVEMIND_CORE_URL}{path}",
                         json=payload, headers=_headers(user_id, org_id))
    except Exception as e:  # noqa: BLE001
        log.debug("core post failed (%s): %s", path, e)


# Persona config cache: (user_id, org_id) → {config, fetched_at}. Skills change
# rarely mid-call; 120s TTL keeps the router prompt fresh without per-turn fetches.
_cfg_cache: dict[tuple, dict] = {}
_CFG_TTL = 120.0


async def get_persona(user_id: Optional[str], org_id: Optional[str], session_id: Optional[str] = None) -> Dict[str, Any]:
    """Fetch the tenant's TARA config (selected-skill prompts) with caching."""
    key = (user_id, org_id, session_id or "")
    hit = _cfg_cache.get(key)
    if hit and time.time() - hit["at"] < _CFG_TTL:
        return hit["cfg"]
    try:
        async with httpx.AsyncClient(timeout=8, verify=config.VERIFY_TLS) as c:
            r = await c.get(
                f"{config.HIVEMIND_CORE_URL}/api/tara/config",
                params={"tenant_id": "default", "agent_name": "default", **({"session_id": session_id} if session_id else {})},
                headers=_headers(user_id, org_id),
            )
            cfg = (r.json() or {}).get("config") or {} if r.status_code == 200 else {}
            try:
                p = await c.get(f"{config.HIVEMIND_CORE_URL}/api/profiles",
                                headers=_headers(user_id, org_id))
                if p.status_code == 200:
                    cfg["profile_context"] = ((p.json() or {}).get("context") or "")[:2000]
            except Exception as e:  # noqa: BLE001
                log.debug("profile context fetch failed: %s", e)
    except Exception as e:  # noqa: BLE001
        log.warning("persona fetch failed: %s", e)
        cfg = {}
    _cfg_cache[key] = {"cfg": cfg, "at": time.time()}
    return cfg
