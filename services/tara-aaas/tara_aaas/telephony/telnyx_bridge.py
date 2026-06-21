"""
Phone call handler for Telnyx media-streaming WebSocket.

Telnyx connects to us at /telnyx/stream?session_id=<id>.
Protocol: JSON envelopes with base64 μ-law 8 kHz audio payloads.

This mirrors handle_voice() from voice_ws.py but adapts the transport:
  Audio IN:  Telnyx {"event":"media"} → AudioBridge.phone_to_pcm16 → STT
  Audio OUT: TTS PCM → AudioBridge.pcm16_to_phone → Telnyx {"event":"media"}
  No browser FE on this WS; status events go to HIVEMIND call-history only.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import time as _time
from typing import Optional

from fastapi import WebSocket, WebSocketDisconnect

from .. import config
from ..stt.session_manager import GroqWhisperSession
from ..stt.config import GroqWhisperConfig
from ..tts.cartesia_manager import CartesiaManager
from ..tts.config import CartesiaConfig
from ..tara_stream import stream_tara
from ..voice_ws import _is_junk_transcript, _flush_boundary, _core_post
from .audio_bridge import AudioBridge

log = logging.getLogger("tara_aaas.telnyx")

# EU AI Act Art 50 — mandatory AI disclosure at open of every AI-initiated call.
_DISCLOSURE = {
    "de": "Guten Tag! Ich bin TARA, ein KI-Assistent. Dieses Gespräch wird von einer künstlichen Intelligenz geführt.",
    "en": "Hello! I'm TARA, an AI assistant. This call is handled by artificial intelligence.",
}


def _ai_disclosure(language: str) -> str:
    return _DISCLOSURE.get(language[:2].lower(), _DISCLOSURE["en"])


async def handle_telnyx_stream(
    ws: WebSocket,
    *,
    session_id: str,
    user_id: Optional[str],
    org_id: Optional[str],
    language: str = "en",
    voice_id: Optional[str] = None,
    mode: str = "external",
) -> None:
    """Drive a live Telnyx media-streaming session through the full TARA voice loop."""
    await ws.accept()
    bridge = AudioBridge()
    tts = CartesiaManager(CartesiaConfig.from_env())
    turn_task: Optional[asyncio.Task] = None
    turn_lock = asyncio.Lock()
    turn_seq = {"n": 0}

    # ── State machine (mirrors voice_ws) ─────────────────────────────────
    st = {"state": "listening", "speaking_since": 0.0}
    MIN_SPEAK_S = 1.2
    _VALID = {
        "idle":      {"listening"},
        "listening": {"thinking", "idle"},
        "thinking":  {"speaking", "listening"},
        "speaking":  {"listening", "thinking"},
    }

    async def to_state(ns: str) -> None:
        cur = st["state"]
        if ns == cur or ns not in _VALID.get(cur, set()):
            return
        st["state"] = ns
        if ns == "speaking":
            st["speaking_since"] = _time.monotonic()

    async def send_audio_to_phone(chunk: bytes, _idx: int, _meta: dict) -> None:
        """TTS PCM s16le 16 kHz → μ-law 8 kHz → Telnyx media event."""
        if st["state"] != "speaking":
            await to_state("speaking")
        try:
            ulaw = bridge.pcm16_to_phone(chunk)
            payload = base64.b64encode(ulaw).decode()
            await ws.send_text(json.dumps({"event": "media", "media": {"payload": payload}}))
        except Exception:  # noqa: BLE001 — phone side gone
            pass

    async def run_turn(transcript: str) -> None:
        async with turn_lock:
            await to_state("thinking")
            t0 = _time.monotonic()
            metrics = {"full": "", "ttfb": None, "usage": None}

            async def token_text():
                buf = ""
                async for evt in stream_tara(
                    query=transcript, session_id=session_id,
                    user_id=user_id, org_id=org_id, language=language, mode=mode,
                ):
                    if evt["type"] == "token":
                        if metrics["ttfb"] is None:
                            metrics["ttfb"] = round((_time.monotonic() - t0) * 1000)
                        metrics["full"] += evt["text"]
                        buf += evt["text"]
                        if _flush_boundary(buf):
                            yield buf
                            buf = ""
                    elif evt["type"] == "final":
                        metrics["usage"] = evt.get("usage")
                    elif evt["type"] == "error":
                        log.warning("phone turn stream error: %s", evt["error"])
                        break
                if buf.strip():
                    yield buf

            try:
                await tts.stream_text_to_audio(
                    token_text(), audio_callback=send_audio_to_phone,
                    context_id=session_id, voice_id=voice_id,
                )
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("phone turn failed")
            finally:
                await to_state("listening")
                turn_seq["n"] += 1
                u = metrics["usage"] or {}
                asyncio.create_task(_core_post("/api/tara/calls/turn", {
                    "session_id": session_id, "seq": turn_seq["n"],
                    "user_text": transcript, "agent_text": metrics["full"],
                    "llm_ttfb_ms": metrics["ttfb"],
                    "prompt_tokens": u.get("prompt_tokens"),
                    "completion_tokens": u.get("completion_tokens"),
                }, user_id, org_id))

    async def on_stt(msg: dict) -> None:
        nonlocal turn_task
        d = msg.get("data", msg)
        if d.get("event_type") == "vad_event" and d.get("signal_type") == "SPEECH_START":
            if st["state"] == "speaking" and (_time.monotonic() - st["speaking_since"]) >= MIN_SPEAK_S:
                if turn_task and not turn_task.done():
                    turn_task.cancel()
                await to_state("listening")
            return
        transcript = (d.get("transcript") or "").strip()
        if transcript and d.get("is_final"):
            if _is_junk_transcript(transcript):
                log.info("dropped junk transcript (phone): %r", transcript[:80])
                return
            if turn_task and not turn_task.done():
                turn_task.cancel()
            turn_task = asyncio.create_task(run_turn(transcript))

    async def greet_with_disclosure() -> None:
        """Mandatory AI disclosure (Art 50) + HIVEMIND-generated greeting."""
        async with turn_lock:
            await to_state("thinking")
            # 1. Fixed AI disclosure — always plays even if HIVEMIND is down.
            try:
                await tts.stream_text_to_audio(
                    _ai_disclosure(language),
                    audio_callback=send_audio_to_phone,
                    context_id=f"{session_id}-disclosure",
                    voice_id=voice_id,
                )
            except Exception:  # noqa: BLE001
                log.warning("disclosure TTS failed — call continues")

            # 2. Persona-aware greeting from HIVEMIND.
            async def gen():
                buf = ""
                try:
                    async for evt in stream_tara(
                        query="__open__", session_id=session_id,
                        user_id=user_id, org_id=org_id, language=language, mode=mode,
                        extra={"greeting": True},
                    ):
                        if evt["type"] == "token":
                            buf += evt["text"]
                            if _flush_boundary(buf):
                                yield buf
                                buf = ""
                        elif evt["type"] == "error":
                            break
                finally:
                    if buf.strip():
                        yield buf

            try:
                await tts.stream_text_to_audio(
                    gen(), audio_callback=send_audio_to_phone,
                    context_id=session_id, voice_id=voice_id,
                )
            except Exception:  # noqa: BLE001
                log.exception("phone greeting failed")
            finally:
                await to_state("listening")

    stt_cfg = GroqWhisperConfig()
    stt = GroqWhisperSession(session_id=session_id, config=stt_cfg, callback=on_stt)
    try:
        await tts.warmup()
        await stt.start()
        asyncio.create_task(_core_post("/api/tara/calls/start", {
            "session_id": session_id, "mode": mode,
            "voice_id": voice_id, "language": language,
        }, user_id, org_id))
        asyncio.create_task(greet_with_disclosure())

        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            raw = msg.get("text")
            if not raw:
                continue
            try:
                evt = json.loads(raw)
            except json.JSONDecodeError:
                continue
            etype = evt.get("event")
            if etype == "connected":
                log.info("telnyx ws connected session=%s", session_id)
            elif etype == "start":
                leg = evt.get("start", {}).get("callLegId") or evt.get("start", {}).get("call_leg_id")
                log.info("telnyx stream started call_leg_id=%s session=%s", leg, session_id)
            elif etype == "media":
                payload_b64 = evt.get("media", {}).get("payload", "")
                if payload_b64:
                    ulaw = base64.b64decode(payload_b64)
                    pcm = bridge.phone_to_pcm16(ulaw)
                    await stt.process_audio_chunk(pcm)
            elif etype == "stop":
                log.info("telnyx stream stop session=%s", session_id)
                break
    except WebSocketDisconnect:
        pass
    finally:
        if turn_task and not turn_task.done():
            turn_task.cancel()
        try:
            await stt.stop()
        except Exception:  # noqa: BLE001
            pass
        try:
            await _core_post("/api/tara/calls/end", {"session_id": session_id}, user_id, org_id)
        except Exception:  # noqa: BLE001
            pass
