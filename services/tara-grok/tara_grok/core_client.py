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

async def emit_event(session_id: str, event: dict) -> None:
    async with httpx.AsyncClient(timeout=8) as client:
        response = await client.post(f"{config.CORE_EVENTS_URL}/{session_id}/events", headers=headers(), json=event)
    response.raise_for_status()

async def run_tool(session_id: str, name: str, arguments: dict) -> dict:
    async with httpx.AsyncClient(timeout=12) as client:
        response = await client.post(f"{config.CORE_EVENTS_URL}/{session_id}/tools", headers=headers(), json={"name": name, "arguments": arguments})
    response.raise_for_status()
    return response.json()
