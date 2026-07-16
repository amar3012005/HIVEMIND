"""
Telnyx outbound call initiator + webhook handler.

Flow:
  1. POST /calls/outbound {to, session_id, ...}
       → validates against TELNYX_ALLOWED_NUMBERS allowlist
       → POST Telnyx /v2/calls  (dial out)
       → stores {call_control_id, session_id, ...} keyed by call_leg_id
       → returns {call_leg_id, session_id, status: "dialing"}

  2. POST /telnyx/webhook  (Telnyx fires this on state changes)
       → call.answered → POST Telnyx /v2/calls/{call_control_id}/actions/streaming_start
           stream_url = wss://{TELNYX_STREAM_BASE_URL}/telnyx/stream?session_id=...
       → call.hangup   → remove from pending dict

  3. WSS /telnyx/stream?session_id=<id>  (Telnyx connects to us)
       → telnyx_bridge.handle_telnyx_stream()

  4. GET /calls/outbound/{call_leg_id}/status
       → returns {call_leg_id, session_id, status}
"""
from __future__ import annotations

import logging
from typing import Optional
from urllib.parse import urlencode

import httpx
from pydantic import BaseModel

from .. import config

log = logging.getLogger("tara_aaas.outbound")

# In-memory call registry: call_leg_id → metadata + status.
# Safe for single-replica; for multi-replica add Redis.
_pending_calls: dict[str, dict] = {}

_TELNYX_API = "https://api.telnyx.com/v2"


async def _telnyx(method: str, path: str, **kwargs) -> dict:
    headers = {
        "Authorization": f"Bearer {config.TELNYX_API_KEY}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=15) as c:
        r = await getattr(c, method)(f"{_TELNYX_API}{path}", headers=headers, **kwargs)
        r.raise_for_status()
        return r.json() if r.content else {}


class OutboundCallRequest(BaseModel):
    to: str
    session_id: str
    user_id: Optional[str] = None
    org_id: Optional[str] = None
    language: str = "en"
    voice_id: Optional[str] = None
    # Outreach campaigns: one-line call objective (+opener), injected into every
    # turn of the voice session as the voice_directive so TARA pursues THIS goal.
    goal: Optional[str] = None


class OutboundCallResponse(BaseModel):
    call_leg_id: str
    session_id: str
    status: str


class CallStatus(BaseModel):
    call_leg_id: str
    session_id: str
    status: str  # dialing | connected | ended


async def initiate_call(req: OutboundCallRequest) -> OutboundCallResponse:
    """Dial out via Telnyx; register metadata for webhook routing."""
    if req.to not in config.TELNYX_ALLOWED_NUMBERS:
        raise ValueError(
            f"Number {req.to!r} not in TELNYX_ALLOWED_NUMBERS. "
            "Add it to the env var to permit outbound dialing."
        )
    result = await _telnyx("post", "/calls", json={
        "connection_id": config.TELNYX_APP_ID,
        "to": req.to,
        "from": config.TELNYX_FROM_NUMBER,
        "from_display_name": "TARA AI",
        "webhook_url": f"{config.TELNYX_WEBHOOK_BASE_URL}/telnyx/webhook",
    })
    data = result["data"]
    call_control_id = data["call_control_id"]
    call_leg_id = data["call_leg_id"]
    _pending_calls[call_leg_id] = {
        "call_control_id": call_control_id,
        "session_id": req.session_id,
        "user_id": req.user_id,
        "org_id": req.org_id,
        "language": req.language,
        "voice_id": req.voice_id,
        "goal": (req.goal or "")[:600] or None,
        "status": "dialing",
    }
    log.info("outbound initiated leg=%s session=%s to=%s", call_leg_id, req.session_id, req.to)
    return OutboundCallResponse(call_leg_id=call_leg_id, session_id=req.session_id, status="dialing")


def get_call_status(call_leg_id: str) -> Optional[dict]:
    return _pending_calls.get(call_leg_id)


async def hangup_call(call_leg_id: str) -> None:
    meta = _pending_calls.get(call_leg_id)
    if not meta:
        raise ValueError(f"Call {call_leg_id!r} not found or already ended")
    cid = meta.get("call_control_id")
    await _telnyx("post", f"/calls/{cid}/actions/hangup")
    meta["status"] = "ended"
    _pending_calls.pop(call_leg_id, None)
    log.info("hangup sent leg=%s", call_leg_id)


async def handle_webhook_event(event: dict) -> None:
    """Process Telnyx webhook; start media streaming on call.answered."""
    payload = event.get("data", {}).get("payload", {})
    event_type = event.get("data", {}).get("event_type", "")
    call_leg_id = payload.get("call_leg_id")
    call_control_id = payload.get("call_control_id")

    if event_type == "call.answered" and call_leg_id:
        meta = _pending_calls.get(call_leg_id)
        if not meta:
            log.warning("call.answered for unknown leg: %s", call_leg_id)
            return
        meta["status"] = "connected"
        qs = urlencode({
            "session_id": meta["session_id"],
            "user_id":    meta.get("user_id") or "",
            "org_id":     meta.get("org_id") or "",
            "language":   meta.get("language") or "en",
            "voice_id":   meta.get("voice_id") or "",
            "goal":       meta.get("goal") or "",
        })
        stream_url = f"{config.TELNYX_STREAM_BASE_URL}/telnyx/stream?{qs}"
        cid = call_control_id or meta.get("call_control_id")
        try:
            await _telnyx("post", f"/calls/{cid}/actions/streaming_start", json={
                "stream_url": stream_url,
                "stream_track": "inbound_track",
            })
            log.info("streaming_start sent leg=%s url=%s", call_leg_id, stream_url)
        except Exception as e:  # noqa: BLE001
            log.error("streaming_start failed leg=%s: %s", call_leg_id, e)

    elif event_type == "call.hangup" and call_leg_id:
        meta = _pending_calls.get(call_leg_id)
        if meta:
            meta["status"] = "ended"
        _pending_calls.pop(call_leg_id, None)
        log.info("call hangup leg=%s", call_leg_id)
