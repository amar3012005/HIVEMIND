"""
voice_ws — the full in-proc voice round-trip.

  browser audio ─WS─> GroqWhisperSession.process_audio_chunk
       (VAD/endpointing kept verbatim; local callback, NO orchestrator_url)
   final transcript ─> stream_tara (HIVEMIND /api/tara/stream)
       token text ───> CartesiaConnection.stream_text_to_audio
            audio  ───> WS back to browser

Barge-in: VAD SPEECH_START cancels the in-flight turn (LLM + TTS) task.
One turn at a time per connection. Auth (cookie→whoami) added in Phase 2 — here
user_id/org_id come from query params (TEMPORARY, replaced by verified identity).
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

from fastapi import WebSocket, WebSocketDisconnect

from . import config
from .stt.session_manager import GroqWhisperSession
from .stt.config import GroqWhisperConfig
from .tts.cartesia_manager import CartesiaManager
from .tts.config import CartesiaConfig
from .tara_stream import stream_tara

import re

log = logging.getLogger("tara_aaas.voice")

# Known Whisper/STT hallucinations to drop (fire on silence/non-speech).
_JUNK_RE = re.compile(
    r"(amara\.org|subtitles by|thank you for watching|please subscribe|untertitel|\bENDE\b|hansgrohe|copyright|transcription by)",
    re.IGNORECASE,
)


def _is_junk_transcript(text: str) -> bool:
    t = (text or "").strip()
    if len(t) < 2:
        return True
    if _JUNK_RE.search(t):
        return True
    words = t.split()
    # heavily repeated phrase (hallucination loop)
    if len(words) >= 6 and len(set(w.lower() for w in words)) <= max(2, len(words) // 4):
        return True
    # mostly single spelled-out letters ("H I V E M I N D")
    if len(words) >= 4 and sum(1 for w in words if len(w) == 1) >= max(4, len(words) // 2):
        return True
    return False


async def _core_post(path: str, payload: dict, user_id, org_id) -> None:
    """Fire-and-forget POST to HIVEMIND core (call-history ingest). Never blocks voice."""
    try:
        import httpx
        async with httpx.AsyncClient(timeout=10, verify=config.VERIFY_TLS) as c:
            await c.post(
                f"{config.HIVEMIND_CORE_URL}{path}",
                json=payload,
                headers={
                    "Authorization": f"Bearer {config.HIVEMIND_API_KEY}",
                    "X-API-Key": config.HIVEMIND_API_KEY,
                    "X-HM-User-Id": user_id or "",
                    "X-HM-Org-Id": org_id or "",
                    "Content-Type": "application/json",
                },
            )
    except Exception as e:  # noqa: BLE001
        log.debug("call-event post failed (%s): %s", path, e)


def _flush_boundary(buf: str) -> bool:
    """Buffer LLM tokens to a sentence/clause before sending to TTS — smooth speech."""
    s = buf.rstrip()
    if not s:
        return False
    if re.search(r'[.!?]["\')\]]*$', s):
        return True
    if re.search(r'[,;:]["\')\]]*$', s) and len(s) >= 28:
        return True
    return len(s) >= 60


async def handle_voice(ws: WebSocket, *, user_id: Optional[str], org_id: Optional[str],
                       session_id: str, language: str = "en", voice_id: Optional[str] = None,
                       mode: str = "external") -> None:
    await ws.accept()
    stt_cfg = GroqWhisperConfig()
    # Lock STT decode to the caller's chosen language (else Whisper falls back to
    # the GROQ_LANGUAGE env default — German — and mis-transcribes every other
    # language). The per-session language is the single source of truth for the
    # whole turn: STT decode hint, LLM reply language, and TTS phonology.
    if language:
        stt_cfg.language = language.strip().lower()
    tts = CartesiaManager(CartesiaConfig.from_env())
    turn_task: Optional[asyncio.Task] = None
    turn_lock = asyncio.Lock()          # one turn at a time (no races)
    turn_seq = {"n": 0}                 # call-history turn counter

    # ── Robust state machine ──────────────────────────────────────────────
    # idle → listening → thinking → speaking → listening. Min-speak guard stops
    # ambient noise from barging in on short replies. Valid transitions enforced.
    import time as _time
    st = {"state": "listening", "speaking_since": 0.0}
    MIN_SPEAK_S = 1.2                   # block barge-in before this much speech out
    _VALID = {
        "idle": {"listening"},
        "listening": {"thinking", "idle"},
        "thinking": {"speaking", "listening"},
        "speaking": {"listening", "thinking"},
    }

    async def to_state(ns: str):
        cur = st["state"]
        if ns == cur:
            return
        if ns not in _VALID.get(cur, set()):
            log.debug("state reject %s→%s", cur, ns)
            return
        st["state"] = ns
        if ns == "speaking":
            st["speaking_since"] = _time.monotonic()
        await _safe_send_json(ws, {"type": "state", "state": ns})

    async def send_audio(chunk: bytes, _idx: int, _meta: dict):
        if st["state"] != "speaking":
            await to_state("speaking")
        try:
            await ws.send_bytes(chunk)
        except Exception:  # noqa: BLE001 — client gone
            pass

    async def run_turn(transcript: str):
        """One user turn: stream_tara tokens → Cartesia TTS → audio out."""
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
                        await _safe_send_json(ws, {"type": "agent_text", "text": evt["text"]})
                        metrics["full"] += evt["text"]
                        buf += evt["text"]
                        if _flush_boundary(buf):
                            yield buf  # send whole clause/sentence → smooth TTS
                            buf = ""
                    elif evt["type"] == "final":
                        metrics["usage"] = evt.get("usage")
                    elif evt["type"] == "error":
                        log.warning("turn stream error: %s", evt["error"])
                        break
                if buf.strip():
                    yield buf
            try:
                await tts.stream_text_to_audio(token_text(), audio_callback=send_audio, context_id=session_id, voice_id=voice_id, language=language)
                await _safe_send_json(ws, {"type": "turn_done"})
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.exception("turn failed")
                await _safe_send_json(ws, {"type": "error", "error": str(e)})
            finally:
                await to_state("listening")
                # real-time ingest: append this turn to call history
                turn_seq["n"] += 1
                u = metrics["usage"] or {}
                asyncio.create_task(_core_post("/api/tara/calls/turn", {
                    "session_id": session_id, "seq": turn_seq["n"],
                    "user_text": transcript, "agent_text": metrics["full"],
                    "llm_ttfb_ms": metrics["ttfb"],
                    "prompt_tokens": u.get("prompt_tokens"), "completion_tokens": u.get("completion_tokens"),
                }, user_id, org_id))

    async def on_stt(msg: dict):
        """Local STT callback (nested payload {"type":"data","data":{...}})."""
        nonlocal turn_task
        d = msg.get("data", msg)
        if d.get("event_type") == "vad_event" and d.get("signal_type") == "SPEECH_START":
            # Barge-in only if actually speaking AND past the min-speak guard
            # (prevents ambient noise from cutting off short replies).
            if st["state"] == "speaking" and (_time.monotonic() - st["speaking_since"]) >= MIN_SPEAK_S:
                if turn_task and not turn_task.done():
                    turn_task.cancel()
                await _safe_send_json(ws, {"type": "speech_start"})
                await to_state("listening")
            return
        transcript = (d.get("transcript") or "").strip()
        if transcript and d.get("is_final"):
            if _is_junk_transcript(transcript):
                log.info("dropped junk/hallucination transcript: %r", transcript[:80])
                return
            await _safe_send_json(ws, {"type": "transcript", "text": transcript})
            if turn_task and not turn_task.done():
                turn_task.cancel()
            turn_task = asyncio.create_task(run_turn(transcript))

    async def greet():
        """Speak an opening greeting the moment the call starts (before user talks).

        The greeting is generated by HIVEMIND in the SELECTED language and the
        ACTIVE skill's persona (greeting:true on /api/tara/stream), then TTS'd.
        Falls back to a static line only if generation/TTS fails.
        """
        async with turn_lock:
            await to_state("thinking")
            got = {"any": False}

            async def gen():
                buf = ""
                try:
                    async for evt in stream_tara(
                        query="__open__", session_id=session_id,
                        user_id=user_id, org_id=org_id, language=language, mode=mode,
                        extra={"greeting": True},
                    ):
                        if evt["type"] == "token":
                            got["any"] = True
                            await _safe_send_json(ws, {"type": "agent_text", "text": evt["text"]})
                            buf += evt["text"]
                            if _flush_boundary(buf):
                                yield buf
                                buf = ""
                        elif evt["type"] == "error":
                            log.warning("greeting stream error: %s", evt["error"])
                            break
                finally:
                    if buf.strip():
                        yield buf

            try:
                await tts.stream_text_to_audio(gen(), audio_callback=send_audio, context_id=session_id, voice_id=voice_id, language=language)
                if not got["any"]:
                    raise RuntimeError("empty greeting")
                await _safe_send_json(ws, {"type": "turn_done"})
            except Exception:  # noqa: BLE001
                log.exception("greeting generation failed — using static fallback")
                fb = "Hello! I'm TARA. How can I help you today?"
                try:
                    await _safe_send_json(ws, {"type": "agent_text", "text": fb})
                    await tts.stream_text_to_audio(fb, audio_callback=send_audio, context_id=session_id, voice_id=voice_id, language=language)
                    await _safe_send_json(ws, {"type": "turn_done"})
                except Exception:  # noqa: BLE001
                    pass
            finally:
                await to_state("listening")

    stt = GroqWhisperSession(session_id=session_id, config=stt_cfg, callback=on_stt)
    try:
        await tts.warmup()
        await stt.start()
        await _safe_send_json(ws, {"type": "ready", "session_id": session_id})
        # real-time: open a call-history record
        asyncio.create_task(_core_post("/api/tara/calls/start", {
            "session_id": session_id, "mode": mode, "voice_id": voice_id, "language": language,
        }, user_id, org_id))
        asyncio.create_task(greet())  # greet in background so the recv loop reads mic immediately
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if (b := msg.get("bytes")) is not None:
                await stt.process_audio_chunk(b)
            elif (t := msg.get("text")) is not None:
                # control messages (e.g. {"type":"end"}) — extend as needed
                try:
                    ctl = json.loads(t)
                    if ctl.get("type") == "end":
                        break
                except json.JSONDecodeError:
                    pass
    except WebSocketDisconnect:
        pass
    finally:
        if turn_task and not turn_task.done():
            turn_task.cancel()
        try:
            await stt.stop()
        except Exception:  # noqa: BLE001
            pass
        # real-time: finalize call + generate insights (await so it runs before exit)
        try:
            await _core_post("/api/tara/calls/end", {"session_id": session_id}, user_id, org_id)
        except Exception:  # noqa: BLE001
            pass


async def _safe_send_json(ws: WebSocket, obj: dict):
    try:
        await ws.send_text(json.dumps(obj))
    except Exception:  # noqa: BLE001
        pass
