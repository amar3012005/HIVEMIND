"""
Deepgram Voice Agent session bridged to a Telnyx media-stream WebSocket.

One instance per phone call:

  Telnyx WS (caller audio, base64 mulaw@8k JSON envelope)
      ⇄ this bridge (decode/encode only — no transcoding)
      ⇄ Deepgram Agent WS (STT + turn-taking + TTS + barge-in),
        whose `think` endpoint is our HIVEMIND shim → every answer recall-grounded.

EU AI Act Art. 50: the AI disclosure is the agent `greeting` in Settings —
spoken deterministically at call open, not left to the LLM.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import time
from typing import Callable, Optional
from urllib.parse import urlencode

import websockets
from fastapi import WebSocket, WebSocketDisconnect

from . import config, dtmf, ivr, listen
from .core_client import core_post
from .functions import FUNCTION_DEFS, FunctionExecutor
from .tara_stream import stream_tara

log = logging.getLogger("tara_dg.session")

_DISCLOSURE = {
    "en": "Hello! This is TARA, an AI assistant calling on behalf of {company}. This call may be ended at any time — just say so.",
    "de": "Hallo! Hier ist TARA, ein KI-Assistent im Auftrag von {company}. Sie können das Gespräch jederzeit beenden — sagen Sie es einfach.",
    "fr": "Bonjour ! Ici TARA, un assistant IA appelant de la part de {company}. Vous pouvez mettre fin à cet appel à tout moment.",
    "es": "¡Hola! Soy TARA, un asistente de IA llamando en nombre de {company}. Puede finalizar esta llamada en cualquier momento.",
    "nl": "Hallo! Dit is TARA, een AI-assistent die belt namens {company}. U kunt dit gesprek op elk moment beëindigen.",
}


_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

# Cartesia Sonic transcript rules (docs: formatting-text-for-sonic) folded into
# the persona prompt so the LLM emits TTS-clean text. Sonic reads capitalized
# acronyms letter-by-letter only when spelled with spaces/<spell>; raw ALL-CAPS
# words can be mis-read — hence the explicit rules below.
_TTS_STYLE_CARTESIA = (
    " SPOKEN-OUTPUT RULES (text-to-speech): write exactly what should be spoken."
    " End every reply with punctuation. Never use quotation marks unless quoting"
    " someone. Say URLs with the word dot (singulance dot com), never bare '.'."
    " Dates as MM/DD/YYYY; times like 7 PM with a space. For acronyms that must"
    " be spelled out (API, CRM, EU), keep them under 4 letters or write them as"
    " letters with spaces. Avoid ALL-CAPS words for emphasis — Sonic may spell"
    " them out; use wording for emphasis instead. Use - for a short pause. Use"
    " ?? to emphasize a question. No markdown, no lists, no emojis."
)


def build_speak(voice_id: Optional[str], language: str) -> dict:
    """The Settings.agent.speak block for the configured provider.

    cartesia → BYO endpoint (tts/bytes) on the SAME Deepgram agent: Sonic voice,
    ~225ms ttfb measured from the box, and the connection bills at the BYO-TTS
    tier. voice_id is honored only when it is a Cartesia voice UUID; an Aura
    model name (persona default) falls back to the configured Cartesia voice.
    Anything else (or no key) → Deepgram Aura-2, byte-identical to before.
    """
    if config.SPEAK_PROVIDER == "cartesia" and config.CARTESIA_API_KEY:
        cart_voice = voice_id if (voice_id and _UUID_RE.match(voice_id)) else config.CARTESIA_VOICE_ID
        return {
            "provider": {
                "type": "cartesia",
                "model_id": config.CARTESIA_MODEL,
                "voice": {"mode": "id", "id": cart_voice},
                "language": (language or "en").split("-")[0],
            },
            "endpoint": {
                "url": config.CARTESIA_TTS_URL,
                "headers": {"x-api-key": config.CARTESIA_API_KEY},
            },
        }
    return {"provider": {"type": "deepgram",
                         "model": voice_id or config.DEEPGRAM_SPEAK_MODEL}}


def build_settings(*, session_id: str, user_id: Optional[str], org_id: Optional[str],
                   language: str, voice_id: Optional[str], prompt: str,
                   company: str, greeting_extra: str = "", goal: str = "",
                   mode: str = "external") -> dict:
    """Deepgram Settings message: mulaw@8k both ways, think → HIVEMIND shim."""
    qs = urlencode({
        "session_id": session_id, "user_id": user_id or "",
        "org_id": org_id or "", "language": language, "mode": mode,
        "goal": goal or "",
    })
    disclosure = _DISCLOSURE.get(language, _DISCLOSURE["en"]).format(company=company)
    return {
        "type": "Settings",
        "audio": {
            "input":  {"encoding": "mulaw", "sample_rate": 8000},
            "output": {"encoding": "mulaw", "sample_rate": 8000, "container": "none"},
        },
        "agent": {
            "language": language,
            "listen": {"provider": {"type": "deepgram", "model": config.DEEPGRAM_LISTEN_MODEL}},
            "think": {
                "provider": {"type": "open_ai", "model": "hivemind-tara", "temperature": 0.3},
                "endpoint": {
                    "url": f"{config.PUBLIC_HTTP_BASE}/think/v1/chat/completions?{qs}",
                    "headers": {"authorization": f"Bearer {config.THINK_SHIM_SECRET}"},
                },
                "prompt": prompt + (_TTS_STYLE_CARTESIA
                                    if config.SPEAK_PROVIDER == "cartesia" and config.CARTESIA_API_KEY
                                    else ""),
                "functions": FUNCTION_DEFS,
            },
            "speak": build_speak(voice_id, language),
            "greeting": (disclosure + (" " + greeting_extra if greeting_extra else "")).strip(),
        },
    }


class CallEventLog:
    """Append-only JSONL log per call: transcript, function calls, dispositions."""

    def __init__(self, session_id: str):
        os.makedirs(config.LOG_DIR, exist_ok=True)
        self.path = os.path.join(config.LOG_DIR, f"{session_id}.jsonl")
        self.events: list[dict] = []

    def write(self, kind: str, data: dict) -> None:
        evt = {"ts": time.time(), "kind": kind, **data}
        self.events.append(evt)
        try:
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(json.dumps(evt, ensure_ascii=False) + "\n")
        except OSError as e:
            log.error("event log write failed: %s", e)


async def run_bridge(telnyx_ws: WebSocket, *, session_id: str,
                     user_id: Optional[str], org_id: Optional[str],
                     language: str, voice_id: Optional[str],
                     prompt: str, company: str, goal: str = "", mode: str = "external",
                     greeting_extra: str = "",
                     on_end: Optional[Callable[[list[dict]], None]] = None,
                     already_accepted: bool = False, seed_start: Optional[dict] = None) -> None:
    """Bridge one Telnyx/Twilio media stream to one Deepgram Agent session."""
    if not already_accepted:
        await telnyx_ws.accept()
    call_start = time.monotonic()
    events = CallEventLog(session_id)
    ivr_nav = ivr.IvrNavigator(session_id)
    # Set while DTMF plays so the agent-audio forwarder yields the carrier
    # socket — a tone must be the ONLY thing on the wire or it reads as noise.
    dtmf_active = asyncio.Event()
    stream_id: Optional[str] = None  # Twilio streamSid (echoed in outbound frames)

    async def _send_dtmf(digits: str) -> None:
        """Push in-band DTMF to the carrier leg over an EXCLUSIVE audio path.

        Two things are required and both were missing at first:
          1. flush TARA's already-queued TTS (`clear`), and
          2. stop dg_to_telnyx from writing agent frames while the tone plays —
             otherwise the two tasks interleave on one socket and the far end
             hears alternating 20ms slices of tone and speech, i.e. noise.
        A handset sends a digit into silence; so must we.
        """
        # PREFERRED: let the carrier emit the digit out-of-band (RFC 2833). This
        # is what IVRs actually accept; in-band audio tones are the fallback.
        # Live today only when the leg is in our own Telnyx account.
        from . import telephony as _tel  # local import: matches the existing
        # pattern in this module and keeps the import graph acyclic.
        if await _tel.send_dtmf_out_of_band(session_id, digits):
            log.info("ivr dtmf sent OUT-OF-BAND session=%s digits=%s", session_id, digits)
            return
        try:
            dtmf_active.set()
            # NO `clear` here. It is a Twilio Media Streams primitive; on Telnyx
            # it is at best a no-op and at worst resets the outbound stream,
            # which would drop the very frames we send next. The mute above
            # already gives us true silence, so `clear` bought nothing and risked
            # everything. (Barge-in still uses it on the Twilio path.)
            await asyncio.sleep(0.25)  # let the leg settle into silence
            for payload in dtmf.digits_to_media_frames(digits):
                out = {"event": "media", "media": {"payload": payload}}
                if stream_id:  # Twilio requires streamSid; Telnyx omits it
                    out["streamSid"] = stream_id
                await telnyx_ws.send_text(json.dumps(out))
                await asyncio.sleep(0.02)  # 20ms frames == real-time cadence
            log.info("ivr dtmf sent session=%s digits=%s", session_id, digits)
        except Exception:  # noqa: BLE001
            log.exception("ivr dtmf send failed session=%s", session_id)
        finally:
            # Restore the agent's audio path BEFORE the spoken fallback, else the
            # escape word would be dropped by the very mute that protected the
            # tone. Always runs — leaving this set would silence TARA for the
            # rest of the call.
            dtmf_active.clear()
        # SPOKEN FALLBACK, after the tone and after unmuting: most trees are
        # speech-enabled and almost every DTMF-only one still routes a spoken
        # "operator" to reception. Strictly sequential with the tone — never
        # simultaneous.
        try:
            await asyncio.sleep(0.3)
            phrase = ivr.spoken_escape(ivr_nav.presses - 1)
            await dg.send(json.dumps({"type": "InjectAgentMessage", "message": phrase}))
            log.info("ivr spoken escape session=%s phrase=%r", session_id, phrase)
        except Exception:  # noqa: BLE001
            log.exception("ivr spoken escape failed session=%s", session_id)
    if seed_start:  # start event already consumed by the caller (Twilio peek)
        st = seed_start.get("start", {}) or {}
        stream_id = (seed_start.get("streamSid") or st.get("streamSid")
                     or seed_start.get("stream_id") or st.get("stream_id"))
    hangup = asyncio.Event()

    async def request_hangup() -> None:
        hangup.set()

    def _history(n: int) -> str:
        turns = [e for e in events.events if e["kind"] == "transcript"][-n * 2:]
        return "\n".join(f"{t.get('role')}: {t.get('content')}" for t in turns)

    executor = FunctionExecutor(
        session_id=session_id, user_id=user_id, org_id=org_id,
        language=language, event_logger=events.write, request_hangup=request_hangup,
        get_history=_history,
    )

    settings = build_settings(
        session_id=session_id, user_id=user_id, org_id=org_id,
        language=language, voice_id=voice_id, prompt=prompt, company=company,
        goal=goal, mode=mode, greeting_extra=greeting_extra,
    )

    try:
        from .ai_gateway import websocket_route
        dg_url, dg_headers = websocket_route(
            config.DEEPGRAM_AGENT_URL, {"Authorization": f"Token {config.DEEPGRAM_API_KEY}"}
        )
        async with websockets.connect(
            dg_url,
            additional_headers=dg_headers,
        ) as dg:
            await dg.send(json.dumps(settings))
            events.write("session_start", {"session_id": session_id, "language": language})
            # Flip registry status → connected so the FE poll shows the live call.
            try:
                from . import telephony as _tel
                _m = _tel.find_by_session(session_id)
                if _m and _m.get("call_leg_id") in _tel.pending_calls:
                    _tel.pending_calls[_m["call_leg_id"]]["status"] = "connected"
            except Exception:  # noqa: BLE001
                pass
            asyncio.create_task(core_post("/api/tara/calls/start", {
                "session_id": session_id, "mode": "phone",
                "voice_id": voice_id, "language": language,
            }, user_id, org_id))
            # Warm the recall pipeline (embedding + Qdrant + lexical) DURING the
            # disclosure greeting so the caller's first real question isn't cold
            # (~2.4s → ~1.1s). Fire-and-forget throwaway recall; result discarded.
            async def _warm() -> None:
                try:
                    async for _ in stream_tara(query="hello", session_id=f"warm-{session_id}",
                                               user_id=user_id, org_id=org_id, language=language,
                                               mode="external", extra={"skip_clinical": True, "max_tokens": 1}):
                        break
                except Exception:  # noqa: BLE001
                    pass
            asyncio.create_task(_warm())
            turn = {"n": 0, "user_text": "", "latency_ms": None}

            async def telnyx_to_dg() -> None:
                nonlocal stream_id
                while not hangup.is_set():
                    try:
                        raw = await telnyx_ws.receive_text()
                    except WebSocketDisconnect:
                        break
                    msg = json.loads(raw)
                    ev = msg.get("event")
                    if ev == "media":
                        payload = msg.get("media", {}).get("payload")
                        if payload:
                            _pcmu_in = base64.b64decode(payload)
                            await dg.send(_pcmu_in)
                            listen.tee(session_id, "in", _pcmu_in)  # live-listen tap (no-op without listeners)
                    elif ev == "start":
                        st = msg.get("start", {})
                        stream_id = (msg.get("streamSid") or st.get("streamSid")
                                     or msg.get("stream_id") or st.get("stream_id"))
                        events.write("stream_start", {"stream_id": stream_id})
                    elif ev == "stop":
                        events.write("stream_stop", {})
                        break
                hangup.set()

            async def dg_to_telnyx() -> None:
                while not hangup.is_set():
                    try:
                        frame = await asyncio.wait_for(dg.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    except websockets.ConnectionClosed:
                        break
                    if isinstance(frame, bytes):
                        # EXCLUSIVE AUDIO PATH during DTMF. This task and
                        # _send_dtmf write to the SAME carrier socket from
                        # different tasks, so without this the far end receives
                        # [tone][agent][tone][agent]… interleaved at 20ms — which
                        # is noise, not a digit. That, not the carrier, is why
                        # correct tones at correct level were ignored: speech
                        # works because it is one continuous source. Drop (never
                        # buffer) agent frames here — we want real silence around
                        # the tone, exactly as a handset produces.
                        if dtmf_active.is_set():
                            continue
                        out = {"event": "media",
                               "media": {"payload": base64.b64encode(frame).decode()}}
                        if stream_id:  # Twilio requires streamSid; Telnyx omits it
                            out["streamSid"] = stream_id
                        await telnyx_ws.send_text(json.dumps(out))
                        listen.tee(session_id, "out", frame)  # live-listen tap (TTS out)
                        continue
                    msg = json.loads(frame)
                    mtype = msg.get("type")
                    if mtype == "ConversationText":
                        role, content = msg.get("role"), msg.get("content")
                        events.write("transcript", {"role": role, "content": content})
                        listen.tee_event(session_id, {"type": "transcript", "role": role, "content": content})
                        if role == "user":
                            turn["user_text"] = content
                            # IVR: if the "caller" is a phone tree, press the digit
                            # that reaches a human. In-band tones — the carrier has
                            # no send-DTMF API. Fire-and-forget so a menu never
                            # blocks the audio loop.
                            _digit = ivr_nav.on_caller_text(content)
                            if _digit:
                                events.write("ivr_press", {"digits": _digit})
                                asyncio.create_task(_send_dtmf(_digit))
                        elif role == "assistant":
                            turn["n"] += 1
                            asyncio.create_task(core_post("/api/tara/calls/turn", {
                                "session_id": session_id, "seq": turn["n"],
                                "user_text": turn["user_text"], "agent_text": content,
                                "llm_ttfb_ms": turn["latency_ms"],
                            }, user_id, org_id))
                            turn["user_text"] = ""
                    elif mtype == "UserStartedSpeaking":
                        # Barge-in: flush queued TTS audio on the phone leg.
                        clr = {"event": "clear"}
                        if stream_id:
                            clr["streamSid"] = stream_id
                        await telnyx_ws.send_text(json.dumps(clr))
                    elif mtype == "FunctionCallRequest":
                        for fn in msg.get("functions", []):
                            if not fn.get("client_side", True):
                                continue
                            content = await executor.execute(fn["name"], fn.get("arguments", "{}"))
                            await dg.send(json.dumps({
                                "type": "FunctionCallResponse",
                                "id": fn["id"], "name": fn["name"], "content": content,
                            }))
                    elif mtype == "Error":
                        desc = str(msg.get("description") or "")
                        events.write("dg_error", {"description": desc, "code": msg.get("code")})
                        log.error("deepgram error session=%s: %s", session_id, msg)
                        # Recover from an unauthorized voice instead of dropping the
                        # call: switch speak to the default authorized English voice.
                        if "speak" in desc and "authorized" in desc:
                            try:
                                # Recover onto the CONFIGURED provider (Cartesia stays
                                # Cartesia with its default voice — no silent mid-call
                                # revert to Aura), voice reset to the known-good default.
                                await dg.send(json.dumps({
                                    "type": "UpdateSpeak",
                                    "speak": build_speak(None, language),
                                }))
                                log.info("recovered speak → provider=%s session=%s", config.SPEAK_PROVIDER, session_id)
                            except Exception:  # noqa: BLE001
                                pass
                    elif mtype == "AgentStartedSpeaking":
                        turn["latency_ms"] = round(float(msg.get("total_latency") or 0) * 1000) or None
                        log.info("latency session=%s total=%.0fms ttt=%.0fms tts=%.0fms",
                                 session_id,
                                 float(msg.get("total_latency") or 0) * 1000,
                                 float(msg.get("ttt_latency") or 0) * 1000,
                                 float(msg.get("tts_latency") or 0) * 1000)
                    elif mtype in ("Welcome", "SettingsApplied", "AgentAudioDone", "AgentThinking"):
                        pass
                hangup.set()

            async def keepalive() -> None:
                while not hangup.is_set():
                    await asyncio.sleep(8)
                    try:
                        await dg.send(json.dumps({"type": "KeepAlive"}))
                    except websockets.ConnectionClosed:
                        break

            tasks = [asyncio.create_task(t()) for t in (telnyx_to_dg, dg_to_telnyx, keepalive)]
            await hangup.wait()
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    except Exception as e:  # noqa: BLE001
        log.exception("bridge failed session=%s", session_id)
        events.write("bridge_error", {"error": str(e)})
    finally:
        events.write("session_end", {"hangup_by_agent": executor.hangup_requested})
        # Mark the call ended in the registry so the FE status poll flips the
        # dialing animation to "ended" the moment the media stream closes.
        listen.end_session(session_id)  # release any live listeners
        try:
            from . import telephony as _tel
            m = _tel.find_by_session(session_id)
            if m and m.get("call_leg_id") in _tel.pending_calls:
                _tel.pending_calls[m["call_leg_id"]]["status"] = "ended"
        except Exception:  # noqa: BLE001
            pass
        try:
            duration_sec = int(time.monotonic() - call_start)
            # Tokens are posted per-turn by the shim (/calls/token-usage) — send
            # only duration here to avoid double-counting. Free per-call state.
            try:
                from . import think_shim as _ts
                _ts._session_state.pop(session_id, None)
            except Exception:  # noqa: BLE001
                pass
            await core_post("/api/tara/calls/end", {
                "session_id": session_id, "duration_sec": duration_sec,
            }, user_id, org_id)
        except Exception:  # noqa: BLE001
            pass
        if on_end:
            try:
                on_end(events.events)
            except Exception:  # noqa: BLE001
                log.exception("on_end callback failed")
        try:
            await telnyx_ws.close()
        except Exception:  # noqa: BLE001
            pass
