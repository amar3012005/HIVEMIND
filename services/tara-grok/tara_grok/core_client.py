from __future__ import annotations

import httpx
from . import config

def headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {config.SERVICE_TOKEN}", "Content-Type": "application/json"}

async def consume_capability(session_id: str, capability: str) -> dict:
    async with httpx.AsyncClient(timeout=8) as client:
        response = await client.post(f"{config.CORE_EVENTS_URL}/{session_id}/consume", headers=headers(), json={"capability": capability})
    response.raise_for_status()
    return response.json()

async def register_pstn_session(org_id: str, user_id: str, provider: str,
                                mode: str, snapshot: dict) -> str:
    """Ask Core for a session row for a PHONE call; returns its UUID.

    A telephony call has no browser capability, so there is no
    tara_voice_sessions row for the events endpoint to resolve tenancy from —
    which is why Grok phone calls persisted nothing at all (no call row, no
    turns, no insight, no leads). Using Core's UUID as the session id for the
    whole call makes every downstream path work unchanged.
    """
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.post(
            f"{config.CORE_EVENTS_URL}/register", headers=headers(),
            json={"org_id": org_id, "user_id": user_id, "provider": provider,
                  "mode": mode, "config": snapshot},
        )
    response.raise_for_status()
    return str((response.json() or {}).get("session_id") or "")


async def emit_event(session_id: str, event: dict) -> None:
    async with httpx.AsyncClient(timeout=8) as client:
        response = await client.post(f"{config.CORE_EVENTS_URL}/{session_id}/events", headers=headers(), json=event)
    response.raise_for_status()

async def run_tool(session_id: str, name: str, arguments: dict) -> dict:
    async with httpx.AsyncClient(timeout=12) as client:
        response = await client.post(f"{config.CORE_EVENTS_URL}/{session_id}/tools", headers=headers(), json={"name": name, "arguments": arguments})
    response.raise_for_status()
    return response.json()
