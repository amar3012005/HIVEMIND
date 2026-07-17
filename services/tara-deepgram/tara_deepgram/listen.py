"""Live-listen — browser tap into an active phone call (listen-only, no barge-in).

The call bridge (agent_session.run_bridge) tees a copy of every audio frame —
caller→TARA (inbound PCMU) and TARA→caller (outbound TTS PCMU) — into a bounded
per-session queue here. A listen-only WebSocket (/calls/listen) drains the queue,
transcodes PCMU (G.711 μ-law, 8 kHz mono) → PCM16, and streams binary frames to
the browser plus tiny JSON control events.

Never blocks the call: queues are drop-oldest; no listener = zero overhead beyond
one dict lookup. Enabled via TARA_LISTEN_ENABLED (default on); when TARA_DG_API_KEY
is set, the WS requires it as a `key` query param (browser WS can't send headers).
"""
from __future__ import annotations

import asyncio
import hmac
import logging
import os
from typing import Dict, List

from fastapi import WebSocket, WebSocketDisconnect

log = logging.getLogger("tara_dg.listen")

_QUEUE_MAX = 400  # ~8s of 20ms frames — plenty of cushion, bounded memory

# session_id → list of listener queues (multiple browsers may listen).
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


def enabled() -> bool:
    return (os.environ.get("TARA_LISTEN_ENABLED", "1").strip().lower()
            not in ("0", "false", "off"))


def has_listeners(session_id: str) -> bool:
    return bool(_listeners.get(session_id))


def tee(session_id: str, direction: str, pcmu: bytes) -> None:
    """Called from the call bridge for every audio frame. Non-blocking, drop-oldest."""
    qs = _listeners.get(session_id)
    if not qs:
        return
    for q in qs:
        if q.full():
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
        try:
            q.put_nowait((direction, pcmu))
        except asyncio.QueueFull:
            pass


def tee_event(session_id: str, event: dict) -> None:
    """Control events (transcripts, speech_start…) mirrored to listeners."""
    qs = _listeners.get(session_id)
    if not qs:
        return
    for q in qs:
        try:
            q.put_nowait(("json", event))
        except asyncio.QueueFull:
            pass


def _auth_ok(key: str) -> bool:
    expected = (os.environ.get("TARA_DG_API_KEY") or "").strip()
    if not expected:
        return True
    return bool(key) and hmac.compare_digest(key.strip(), expected)


async def handle_listen(ws: WebSocket, session_id: str, key: str = "") -> None:
    """Listen-only WS: binary = PCM16 mono 8kHz (both call directions), JSON =
    {type: ready|transcript|speech_start|ended}."""
    if not enabled() or not _auth_ok(key):
        await ws.close(code=4401)
        return
    await ws.accept()
    q: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAX)
    _listeners.setdefault(session_id, []).append(q)
    log.info("listener attached session=%s (n=%d)", session_id, len(_listeners[session_id]))
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
        log.exception("listen ws failed session=%s", session_id)
    finally:
        qs = _listeners.get(session_id) or []
        if q in qs:
            qs.remove(q)
        if not qs:
            _listeners.pop(session_id, None)
        log.info("listener detached session=%s", session_id)


def end_session(session_id: str) -> None:
    """Call ended — tell listeners and let their sockets close."""
    tee_event(session_id, {"type": "ended"})
