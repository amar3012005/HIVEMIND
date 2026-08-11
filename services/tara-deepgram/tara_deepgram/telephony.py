"""
Telnyx outbound dial + webhook handling (ported from tara-aaas telephony,
adapted for the Deepgram bridge: bidirectional PCMU streaming, no transcode).
"""
from __future__ import annotations

import logging
import re
from typing import Optional
from urllib.parse import urlencode

import asyncio
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
    # Resolved skill prompt from the caller. Core owns the skills store and pins
    # the skill in the campaign snapshot, so it hands the text down — this keeps
    # the pinned persona even if the org default changes mid-campaign.
    skill_prompt: Optional[str] = None
    goal: Optional[str] = None
    campaign_id: Optional[str] = None
    contact_name: Optional[str] = None
    company: Optional[str] = None      # real org/company name (never the UUID)
    mode: Optional[str] = None
    # Outreach campaigns: per-prospect brief (firm, website, why-fit, prior-call
    # learnings) — grounds the strategist + prompt so TARA knows WHO it's calling.
    context: Optional[str] = None
    # Compact org brief built by core at dial time (who TARA works for). Pydantic
    # DROPS unknown fields silently, so core was sending this and both adapters were
    # throwing it away — the field must be declared to exist. It reaches session meta
    # via **req.model_dump() below.
    org_brief: Optional[str] = None


def _b64_basic(user: str, pw: str) -> str:
    import base64
    return base64.b64encode(f"{user}:{pw}".encode()).decode()


async def _dial_twilio(req: DialRequest) -> dict:
    """Dial via Twilio; TwiML <Connect><Stream> opens the media WS directly
    (no separate webhook/stream-start step). Media WS = our /telnyx/stream
    endpoint — same run_bridge, streamSid echoed automatically."""
    # Twilio does NOT forward URL query params on the media WS — it delivers
    # them as <Parameter> tags (start.customParameters). session_id also carried
    # on the URL for our own convenience, but the bridge reads customParameters.
    from xml.sax.saxutils import escape as _xml_escape, quoteattr as _xml_attr
    stream_url = _xml_escape(f"{config.PUBLIC_WS_BASE}/telnyx/stream")
    params = {
        "session_id": req.session_id, "user_id": req.user_id or "",
        "org_id": req.org_id or "", "language": req.language, "voice_id": req.voice_id or "",
    }
    param_tags = "".join(
        f'<Parameter name={_xml_attr(k)} value={_xml_attr(v)} />' for k, v in params.items() if v
    )
    twiml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<Response><Connect><Stream url="{stream_url}">{param_tags}</Stream></Connect></Response>'
    )
    sid = config.TWILIO_ACCOUNT_SID
    url = f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Calls.json"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(url,
            headers={"Authorization": f"Basic {_b64_basic(sid, config.TWILIO_AUTH_TOKEN)}"},
            data={"To": req.to, "From": config.TWILIO_FROM_NUMBER, "Twiml": twiml})
        r.raise_for_status()
        data = r.json()
    leg = data["sid"]  # Twilio Call SID
    pending_calls[leg] = {"call_control_id": leg, "provider": "twilio",
                          "status": "dialing", **req.model_dump()}
    log.info("twilio dial leg=%s session=%s to=%s", leg, req.session_id, req.to)
    return {"call_leg_id": leg, "session_id": req.session_id, "status": "dialing"}


# Zernio's gateway flakes intermittently under a campaign burst: a run of 9 dials
# saw 5 connect normally and 4 die on "502 Bad Gateway" from
# https://zernio.com/api/v1/voice/calls, while the API answered healthily seconds
# later. With no retry, one blip permanently loses a prospect from the campaign.
_RETRY_STATUS = {502, 503, 504}
_RETRY_BACKOFF = (0.6, 1.8)  # two retries; sequential dialling, so this cannot stampede


async def _zernio(method: str, path: str, extra_headers: Optional[dict] = None, **kwargs) -> dict:
    headers = {"Authorization": f"Bearer {config.ZERNIO_API_KEY}",
               "Content-Type": "application/json", **(extra_headers or {})}
    # Retrying a POST /voice/calls is only safe because the caller sends an
    # Idempotency-Key, so Zernio collapses a duplicate into the original call. If
    # a POST ever arrives WITHOUT one, do not retry it — a second dial would ring
    # a real person twice, which is far worse than a failed row in the campaign.
    idempotent = method.lower() != "post" or "Idempotency-Key" in headers
    attempts = 1 + (len(_RETRY_BACKOFF) if idempotent else 0)
    last_exc = None
    for attempt in range(attempts):
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                r = await getattr(c, method)(f"{config.ZERNIO_API_BASE}{path}",
                                             headers=headers, **kwargs)
                if r.status_code in _RETRY_STATUS and attempt < attempts - 1:
                    log.warning("zernio %s %s -> %s, retrying in %.1fs (attempt %d/%d)",
                                method.upper(), path, r.status_code,
                                _RETRY_BACKOFF[attempt], attempt + 1, attempts)
                    await asyncio.sleep(_RETRY_BACKOFF[attempt])
                    continue
                r.raise_for_status()
                return r.json() if r.content else {}
        except (httpx.TransportError, httpx.TimeoutException) as e:
            last_exc = e
            if attempt >= attempts - 1:
                raise
            log.warning("zernio %s %s transport error (%s), retrying in %.1fs",
                        method.upper(), path, e, _RETRY_BACKOFF[attempt])
            await asyncio.sleep(_RETRY_BACKOFF[attempt])
    if last_exc:
        raise last_exc
    raise RuntimeError(f"zernio {method} {path} exhausted retries")


async def _dial_zernio(req: DialRequest) -> dict:
    """Dial via Zernio (a Telnyx reseller).

    `forwardTo` carries our media-WS URL at dial time, so there is no
    call.answered → streaming_start round-trip like Telnyx-direct; Zernio bridges
    the answered callee straight into the socket, bidirectionally. Query params on
    the URL survive verbatim (verified live), so the existing /telnyx/stream
    handler picks session_id up exactly as it does for Telnyx.

    NOTE: media only bridges AFTER the callee answers — an unanswered call ends
    `no_answer` and the socket is never opened. That is provider behaviour, not a
    bug in the bridge.
    """
    qs = urlencode({k: v for k, v in {
        "session_id": req.session_id,
        "user_id": req.user_id or "",
        "org_id": req.org_id or "",
        "language": req.language,
        "voice_id": req.voice_id or "",
    }.items() if v})
    body = {"to": req.to, "forwardTo": f"{config.PUBLIC_WS_BASE}/telnyx/stream?{qs}"}
    if config.ZERNIO_FROM_NUMBER:
        body["fromNumber"] = config.ZERNIO_FROM_NUMBER
    if config.ZERNIO_GREETING:
        body["greeting"] = config.ZERNIO_GREETING
    # Answering-machine detection. Zernio DEFERS the bridge until it decides
    # human vs machine, so TARA no longer burns her opener into a voicemail
    # beep — the single biggest source of wasted minutes in the first campaign
    # (one answering-service call ran 10m23s). Records come back with
    # `answered_machine` so a target can be requeued for a direct-dial retry
    # instead of being scored as a real conversation.
    if config.ZERNIO_AMD:
        body["amd"] = True
    # Idempotency-Key keyed on our session: a retried dial can never double-ring
    # a prospect.
    result = await _zernio("post", "/voice/calls", json=body,
                           extra_headers={"Idempotency-Key": f"tara-{req.session_id}"})
    leg = str(result.get("callId") or "")
    if not leg:
        raise ValueError(f"Zernio returned no callId: {str(result)[:200]}")
    pending_calls[leg] = {
        "call_control_id": leg,
        "provider": "zernio",
        # Kept for support/debugging — Zernio exposes the underlying Telnyx leg.
        "telnyx_call_control_id": result.get("telnyxCallControlId"),
        "status": result.get("status") or "dialing",
        **req.model_dump(),
    }
    log.info("zernio dial leg=%s session=%s to=%s", leg, req.session_id, req.to)
    return {"call_leg_id": leg, "session_id": req.session_id, "status": "dialing"}


_E164 = re.compile(r"^\+[1-9]\d{7,14}$")


async def dial(req: DialRequest) -> dict:
    """Dial via the configured provider; register metadata for stream routing.

    Outbound dialing is fail-closed: the destination must be present in the
    configured Telnyx/Twilio allowlist. This gate is shared by room calls and
    campaigns, so no caller can bypass it through a different route."""
    if not _E164.match(req.to or ""):
        raise ValueError(f"Number {req.to!r} is not valid E.164 (e.g. +4915772925738).")
    # Allowlist semantics: "*" (or DIAL_ALLOW_ALL=true) opens dialing to any
    # valid E.164 number — the workspace owner explicitly opted out of the
    # fail-closed list. An empty/non-* list stays fail-closed.
    _allow_all = "*" in config.ALLOWED_NUMBERS or str(
        __import__("os").getenv("DIAL_ALLOW_ALL", "")).lower() in ("1", "true", "yes")
    if not _allow_all and req.to not in config.ALLOWED_NUMBERS:
        raise ValueError(f"Number {req.to!r} not in the configured allowlist.")
    if config.TELEPHONY_PROVIDER == "twilio":
        return await _dial_twilio(req)
    if config.TELEPHONY_PROVIDER == "zernio":
        return await _dial_zernio(req)
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


async def send_dtmf_out_of_band(session_id: str, digits: str) -> bool:
    """Press digits via the CARRIER, not the audio path. Returns True if sent.

    In-band tones are a fallback, not the answer: injected audio reaches the far
    end (prospects hear TARA over the same channel) but IVRs still ignore
    correct, correctly-levelled tones — they expect RFC 2833 out-of-band digits,
    which only the carrier can emit.

    Telnyx supports this natively and our Telnyx integration already exists
    (`_telnyx`, /calls, streaming_start) — it ran in production before Zernio and
    TELNYX_APP_ID is still configured. So the moment TELNYX_API_KEY is present
    this becomes the real DTMF path with no other change.

    Zernio cannot do this today: it exposes no send-DTMF endpoint (nine path
    shapes probed) and owns the Telnyx account behind our calls, so its
    telnyxCallControlId is not actionable with our credentials.
    """
    meta = find_by_session(session_id)
    if not meta:
        return False
    # Only usable when the leg lives in OUR Telnyx account.
    if meta.get("provider") == "zernio" or not config.TELNYX_API_KEY:
        return False
    cid = meta.get("call_control_id")
    if not cid:
        return False
    try:
        await _telnyx("post", f"/calls/{cid}/actions/send_dtmf", json={"digits": str(digits)})
        log.info("telnyx send_dtmf leg=%s digits=%s", cid, digits)
        return True
    except Exception as error:  # noqa: BLE001
        log.warning("telnyx send_dtmf failed leg=%s: %s", cid, error)
        return False


async def hangup(call_leg_id: str) -> None:
    meta = pending_calls.get(call_leg_id)
    if not meta:
        raise ValueError(f"Call {call_leg_id!r} not found or already ended")
    if meta.get("provider") == "zernio":
        await _zernio("post", f"/voice/calls/{meta['call_control_id']}/end")
    elif meta.get("provider") == "twilio":
        sid = config.TWILIO_ACCOUNT_SID
        async with httpx.AsyncClient(timeout=15) as c:
            await c.post(
                f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Calls/{meta['call_control_id']}.json",
                headers={"Authorization": f"Basic {_b64_basic(sid, config.TWILIO_AUTH_TOKEN)}"},
                data={"Status": "completed"})
    else:
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


# ── Zernio webhooks ──────────────────────────────────────────────────────────
# Zernio signs the RAW body with HMAC-SHA256 (lowercase hex) in X-Zernio-Signature
# and sends NO timestamp — so a captured webhook is replayable forever. The
# event-id dedupe below is therefore a SECURITY control, not just idempotency.
# Delivery is at-least-once with up to 7 retries, so duplicates are normal.
_ZERNIO_SEEN_EVENTS: dict[str, float] = {}
_ZERNIO_SEEN_MAX = 5000


def verify_zernio_signature(raw_body: bytes, signature: str) -> bool:
    """Constant-time HMAC-SHA256 check. Fails closed when no secret is set."""
    import hashlib
    import hmac
    if not config.ZERNIO_WEBHOOK_SECRET or not signature:
        return False
    expected = hmac.new(config.ZERNIO_WEBHOOK_SECRET.encode(),
                        raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature.strip().lower())


def zernio_signature_debug(raw_body: bytes) -> str:
    """What OUR secret would produce, in both plausible encodings — prefixes only.

    Lets a signature mismatch be triaged from one log line: if the received value
    matches `hex…` we have a bug; if it matches `b64…` Zernio encodes differently
    than documented; if it matches neither, the secret in the Zernio dashboard is
    not the one in ZERNIO_WEBHOOK_SECRET.
    """
    import base64
    import hashlib
    import hmac
    if not config.ZERNIO_WEBHOOK_SECRET:
        return "no_secret_configured"
    mac = hmac.new(config.ZERNIO_WEBHOOK_SECRET.encode(), raw_body, hashlib.sha256)
    return (f"expect_hex={mac.hexdigest()[:12]}… "
            f"expect_b64={base64.b64encode(mac.digest()).decode()[:12]}…")


def zernio_event_is_new(event_id: str) -> bool:
    """True the first time an event id is seen. Replay/duplicate guard."""
    import time as _time
    if not event_id:
        return True  # nothing to dedupe on; handler stays idempotent anyway
    if event_id in _ZERNIO_SEEN_EVENTS:
        return False
    if len(_ZERNIO_SEEN_EVENTS) >= _ZERNIO_SEEN_MAX:
        for stale, _ in sorted(_ZERNIO_SEEN_EVENTS.items(), key=lambda kv: kv[1])[:1000]:
            _ZERNIO_SEEN_EVENTS.pop(stale, None)
    _ZERNIO_SEEN_EVENTS[event_id] = _time.monotonic()
    return True


def _zernio_leg(call: dict) -> str:
    """Zernio's call id field name varies by event; accept the documented set."""
    for key in ("callId", "_id", "id"):
        value = call.get(key)
        if value:
            return str(value)
    return ""


async def handle_zernio_webhook(event: dict) -> None:
    """Terminal-state bookkeeping. There is no `answered` event to act on —
    `forwardTo` already opened the media socket at dial time."""
    etype = str(event.get("event") or "")
    call = event.get("call") or {}
    leg = _zernio_leg(call)
    meta = pending_calls.get(leg) if leg else None
    if etype == "call.ended":
        # AMD verdict. A machine pickup is NOT a conversation — surfacing it lets
        # the campaign requeue for a direct-dial retry instead of scoring a
        # voicemail as a reached prospect.
        machine = call.get("answered_machine")
        if machine is None:
            machine = call.get("answeredMachine")
        if meta:
            meta["status"] = "ended"
            meta["end_reason"] = call.get("endReason")
            meta["duration_seconds"] = call.get("durationSeconds")
            meta["answered_machine"] = bool(machine)
        log.info("zernio call.ended leg=%s reason=%s dur=%ss answered_machine=%s",
                 leg, call.get("endReason"), call.get("durationSeconds"), machine)
    elif etype == "call.failed":
        if meta:
            meta["status"] = "failed"
            meta["failure_code"] = call.get("code")
        log.warning("zernio call.failed leg=%s code=%s msg=%s",
                    leg, call.get("code"), str(call.get("message"))[:200])
    else:
        # Log unknown/inbound events once so the real payload shape is learnable
        # from production rather than guessed (the docs omit full schemas).
        log.info("zernio webhook event=%s leg=%s keys=%s", etype, leg, sorted(call.keys())[:12])


def find_by_session(session_id: str) -> Optional[dict]:
    for leg, meta in pending_calls.items():
        if meta.get("session_id") == session_id:
            return {"call_leg_id": leg, **meta}
    return None
