"""Listen-only fan-out so the dashboard can hear an in-flight Grok PSTN call.

Parity with tara-deepgram's tap: the bridge tees both audio directions here, and
each browser listener gets binary PCM16 mono 8kHz plus JSON control frames. The
wire contract is identical, so the existing <LiveListen> player works unchanged.

Auth is a Core-minted, session-scoped capability — never the privileged dial key,
which must not reach a browser. Core checks org ownership before signing, so a
valid signature over a matching, unexpired `sid` IS the authorization.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import time
from typing import Dict, List

from fastapi import WebSocket, WebSocketDisconnect

from . import config

log = logging.getLogger("tara_grok.listen")

_QUEUE_MAX = 200
_listeners: Dict[str, List[asyncio.Queue]] = {}

# μ-law → linear16 lookup table (audioop is removed in Python 3.13 — no deps).
_ULAW2LIN = []
for _i in range(256):
    _u = ~_i & 0xFF
    _sign = _u & 0x80
    _exp = (_u >> 4) & 0x07
    _mant = _u & 0x0F
    _sample = ((_mant << 3) + 0x84) << _exp
    _sample -= 0x84
    _ULAW2LIN.append(-_sample if _sign else _sample)


def _pcmu_to_pcm16(data: bytes) -> bytes:
    out = bytearray(len(data) * 2)
    for i, b in enumerate(data):
        s = _ULAW2LIN[b]
        out[2 * i] = s & 0xFF
        out[2 * i + 1] = (s >> 8) & 0xFF
    return bytes(out)


def has_listeners(session_id: str) -> bool:
    return bool(_listeners.get(session_id))


def tee(session_id: str, direction: str, pcmu: bytes) -> None:
    """Fan one PCMU frame out to attached listeners. Never blocks the call: a
    slow listener's full queue drops frames rather than stalling the bridge."""
    queues = _listeners.get(session_id)
    if not queues:
        return
    for q in list(queues):
        try:
            q.put_nowait(("audio", pcmu))
        except asyncio.QueueFull:
            pass


def tee_json(session_id: str, payload: dict) -> None:
    queues = _listeners.get(session_id)
    if not queues:
        return
    for q in list(queues):
        try:
            q.put_nowait(("json", payload))
        except asyncio.QueueFull:
            pass


def verify_listen_token(token: str, session_id: str) -> bool:
    """base64url(claims) + "." + base64url(HMAC-SHA256(claims)), both unpadded
    to match Node's digest('base64url')."""
    secret = config.LISTEN_SECRET
    if not secret or not token or "." not in token:
        return False
    claims_b64, _, sig = token.partition(".")
    if not claims_b64 or not sig:
        return False
    mac = hmac.new(secret.encode(), claims_b64.encode(), hashlib.sha256).digest()
    expected = base64.urlsafe_b64encode(mac).rstrip(b"=").decode()
    if not hmac.compare_digest(expected, sig.strip()):
        return False
    try:
        pad = "=" * (-len(claims_b64) % 4)
        claims = json.loads(base64.urlsafe_b64decode(claims_b64 + pad))
    except Exception:  # noqa: BLE001
        return False
    if str(claims.get("sid") or "") != str(session_id):
        return False
    return float(claims.get("exp") or 0) > time.time() * 1000


async def handle_listen(ws: WebSocket, session_id: str, token: str = "") -> None:
    if not session_id or not verify_listen_token(token, session_id):
        log.warning("grok listen rejected session=%s (token=%s)",
                    session_id, "yes" if token else "no")
        await ws.close(code=4401)
        return
    await ws.accept()
    q: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAX)
    _listeners.setdefault(session_id, []).append(q)
    log.info("grok listener attached session=%s (n=%d)", session_id, len(_listeners[session_id]))
    try:
        await ws.send_json({"type": "ready", "session_id": session_id,
                            "format": "pcm16", "rate": 8000})
        while True:
            kind, payload = await q.get()
            if kind == "json":
                await ws.send_json(payload)
                if payload.get("type") == "ended":
                    break
            else:
                await ws.send_bytes(_pcmu_to_pcm16(payload))
    except (WebSocketDisconnect, RuntimeError):
        pass
    except Exception:  # noqa: BLE001
        log.exception("grok listen ws failed session=%s", session_id)
    finally:
        queues = _listeners.get(session_id) or []
        if q in queues:
            queues.remove(q)
        if not queues:
            _listeners.pop(session_id, None)
