"""PSTN dialing for the Grok adapter, via Zernio (a Telnyx reseller).

Each adapter owns its own realtime audio + telephony transport — that is the
whole point of the provider split — so tara-grok dials for itself rather than
borrowing tara-deepgram's carrier path. The ~40 lines of Zernio duplication buy
full independence: a Grok org gets Grok on the phone, not Deepgram.

Why no transcode: Zernio/Telnyx media streaming carries G.711 μ-law @8kHz as
base64 in JSON frames, and xAI's realtime API accepts `audio/pcmu` at 8000 Hz
natively. The bridge therefore re-wraps base64 payloads in both directions.
"""
from __future__ import annotations

import logging
import re
from typing import Optional
from urllib.parse import urlencode

import httpx
from pydantic import BaseModel

from . import config

log = logging.getLogger("tara_grok.telephony")

# call id → snapshot. Single replica; Redis if this ever scales out.
pending_calls: dict[str, dict] = {}

_E164 = re.compile(r"^\+[1-9]\d{7,14}$")


class DialRequest(BaseModel):
    """Mirrors tara-deepgram's DialRequest so campaigns.js can dial either
    adapter with one payload shape."""
    to: str
    session_id: str
    user_id: Optional[str] = None
    org_id: Optional[str] = None
    language: str = "en"
    voice_id: Optional[str] = None
    skill_id: Optional[str] = None
    # The skill's PROMPT text, resolved by the caller. Core owns the skills store,
    # so it hands the prompt down here exactly as it does for browser sessions via
    # the config snapshot — this adapter never needs skills-read access itself.
    skill_prompt: Optional[str] = None
    goal: Optional[str] = None
    campaign_id: Optional[str] = None
    contact_name: Optional[str] = None
    company: Optional[str] = None
    mode: Optional[str] = None
    context: Optional[str] = None


async def _zernio(method: str, path: str, extra_headers: Optional[dict] = None, **kwargs) -> dict:
    headers = {"Authorization": f"Bearer {config.ZERNIO_API_KEY}",
               "Content-Type": "application/json", **(extra_headers or {})}
    async with httpx.AsyncClient(timeout=20) as client:
        response = await getattr(client, method)(
            f"{config.ZERNIO_API_BASE}{path}", headers=headers, **kwargs)
        response.raise_for_status()
        return response.json() if response.content else {}


async def dial(req: DialRequest) -> dict:
    """Place an outbound call whose audio bridges into THIS adapter's xAI session.

    Fail-closed on the destination allowlist — the same gate room calls and
    campaigns share, so no caller can dial around it.
    """
    if not config.telephony_enabled():
        raise ValueError("Zernio telephony is not configured on tara-grok")
    if not _E164.match(req.to or ""):
        raise ValueError(f"Number {req.to!r} is not valid E.164 (e.g. +4915772925738).")
    allow_all = "*" in config.ALLOWED_NUMBERS or config.DIAL_ALLOW_ALL
    if not allow_all and req.to not in config.ALLOWED_NUMBERS:
        raise ValueError(f"Number {req.to!r} not in the configured allowlist.")

    # session_id rides the forwardTo query string; Zernio preserves it verbatim
    # (verified live), which is how the media socket finds this call's snapshot.
    qs = urlencode({k: v for k, v in {
        "session_id": req.session_id,
        "language": req.language,
        "voice_id": req.voice_id or "",
    }.items() if v})
    body = {
        "to": req.to,
        "fromNumber": config.ZERNIO_FROM_NUMBER,
        # forwardTo is REQUIRED by Zernio (omitting it 422s) and opens the media
        # socket at dial time — there is no answered→streaming_start round-trip.
        "forwardTo": f"{config.PUBLIC_WS_BASE}/telnyx/stream?{qs}",
    }
    result = await _zernio("post", "/voice/calls", json=body,
                           extra_headers={"Idempotency-Key": f"tara-grok-{req.session_id}"})
    leg = str(result.get("callId") or "")
    if not leg:
        raise ValueError(f"Zernio returned no callId: {str(result)[:200]}")
    pending_calls[leg] = {
        "call_control_id": leg,
        "provider": "zernio",
        "telnyx_call_control_id": result.get("telnyxCallControlId"),
        "status": result.get("status") or "dialing",
        **req.model_dump(),
    }
    log.info("grok dial leg=%s session=%s to=%s", leg, req.session_id, req.to)
    return {"call_leg_id": leg, "session_id": req.session_id, "status": "dialing"}


async def hangup(call_leg_id: str) -> None:
    meta = pending_calls.get(call_leg_id)
    if not meta:
        raise ValueError(f"Call {call_leg_id!r} not found or already ended")
    await _zernio("post", f"/voice/calls/{meta['call_control_id']}/end")
    meta["status"] = "ended"


def find_by_session(session_id: str) -> Optional[dict]:
    for leg, meta in pending_calls.items():
        if meta.get("session_id") == session_id:
            return {"call_leg_id": leg, **meta}
    return None
