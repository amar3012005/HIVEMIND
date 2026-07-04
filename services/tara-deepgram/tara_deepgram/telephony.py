"""
Telnyx outbound dial + webhook handling (ported from tara-aaas telephony,
adapted for the Deepgram bridge: bidirectional PCMU streaming, no transcode).
"""
from __future__ import annotations

import logging
from typing import Optional
from urllib.parse import urlencode

import httpx
from pydantic import BaseModel

from . import config

log = logging.getLogger("tara_dg.telephony")

_TELNYX_API = "https://api.telnyx.com/v2"

# call_leg_id → call metadata. Single replica; Redis if scaled out.
pending_calls: dict[str, dict] = {}


async def _telnyx(method: str, path: str, **kwargs) -> dict:
    headers = {"Authorization": f"Bearer {config.TELNYX_API_KEY}",
               "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=15) as c:
        r = await getattr(c, method)(f"{_TELNYX_API}{path}", headers=headers, **kwargs)
        r.raise_for_status()
        return r.json() if r.content else {}


class DialRequest(BaseModel):
    to: str
    session_id: str
    user_id: Optional[str] = None
    org_id: Optional[str] = None
    language: str = "en"
    voice_id: Optional[str] = None
    skill_id: Optional[str] = None
    goal: Optional[str] = None
    campaign_id: Optional[str] = None
    contact_name: Optional[str] = None


async def dial(req: DialRequest) -> dict:
    """Dial via Telnyx; register metadata for webhook → stream routing."""
    if req.to not in config.TELNYX_ALLOWED_NUMBERS:
        raise ValueError(
            f"Number {req.to!r} not in TELNYX_ALLOWED_NUMBERS — dialing blocked."
        )
    result = await _telnyx("post", "/calls", json={
        "connection_id": config.TELNYX_APP_ID,
        "to": req.to,
        "from": config.TELNYX_FROM_NUMBER,
        "from_display_name": "TARA AI",
        "webhook_url": f"{config.PUBLIC_HTTP_BASE}/telnyx/webhook",
    })
    data = result["data"]
    leg = data["call_leg_id"]
    pending_calls[leg] = {
        "call_control_id": data["call_control_id"],
        "status": "dialing",
        **req.model_dump(),
    }
    log.info("dial leg=%s session=%s to=%s", leg, req.session_id, req.to)
    return {"call_leg_id": leg, "session_id": req.session_id, "status": "dialing"}


async def hangup(call_leg_id: str) -> None:
    meta = pending_calls.get(call_leg_id)
    if not meta:
        raise ValueError(f"Call {call_leg_id!r} not found or already ended")
    await _telnyx("post", f"/calls/{meta['call_control_id']}/actions/hangup")
    meta["status"] = "ended"


async def handle_webhook(event: dict) -> None:
    payload = event.get("data", {}).get("payload", {})
    etype = event.get("data", {}).get("event_type", "")
    leg = payload.get("call_leg_id")
    if not leg:
        return
    meta = pending_calls.get(leg)

    if etype == "call.answered" and meta:
        meta["status"] = "connected"
        qs = urlencode({"session_id": meta["session_id"]})
        cid = payload.get("call_control_id") or meta["call_control_id"]
        try:
            await _telnyx("post", f"/calls/{cid}/actions/streaming_start", json={
                "stream_url": f"{config.PUBLIC_WS_BASE}/telnyx/stream?{qs}",
                "stream_track": "inbound_track",
                "stream_bidirectional_mode": "rtp",
                "stream_bidirectional_codec": "PCMU",
            })
            log.info("streaming_start leg=%s", leg)
        except Exception as e:  # noqa: BLE001
            log.error("streaming_start failed leg=%s: %s", leg, e)
    elif etype == "call.hangup":
        if meta:
            meta["status"] = "ended"
        log.info("hangup leg=%s", leg)


def find_by_session(session_id: str) -> Optional[dict]:
    for leg, meta in pending_calls.items():
        if meta.get("session_id") == session_id:
            return {"call_leg_id": leg, **meta}
    return None
