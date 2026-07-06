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
import time
from typing import Callable, Optional
from urllib.parse import urlencode

import websockets
from fastapi import WebSocket, WebSocketDisconnect

from . import config
from .core_client import core_post
from .functions import FUNCTION_DEFS, FunctionExecutor

log = logging.getLogger("tara_dg.session")

_DISCLOSURE = {
    "en": "Hello! This is TARA, an AI assistant calling on behalf of {company}. This call may be ended at any time — just say so.",
    "de": "Hallo! Hier ist TARA, ein KI-Assistent im Auftrag von {company}. Sie können das Gespräch jederzeit beenden — sagen Sie es einfach.",
    "fr": "Bonjour ! Ici TARA, un assistant IA appelant de la part de {company}. Vous pouvez mettre fin à cet appel à tout moment.",
    "es": "¡Hola! Soy TARA, un asistente de IA llamando en nombre de {company}. Puede finalizar esta llamada en cualquier momento.",
    "nl": "Hallo! Dit is TARA, een AI-assistent die belt namens {company}. U kunt dit gesprek op elk moment beëindigen.",
}


def build_settings(*, session_id: str, user_id: Optional[str], org_id: Optional[str],
                   language: str, voice_id: Optional[str], prompt: str,
                   company: str, greeting_extra: str = "") -> dict:
    """Deepgram Settings message: mulaw@8k both ways, think → HIVEMIND shim."""
    qs = urlencode({
        "session_id": session_id, "user_id": user_id or "",
        "org_id": org_id or "", "language": language, "mode": "external",
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
                "prompt": prompt,
                "functions": FUNCTION_DEFS,
            },
            "speak": {"provider": {"type": "deepgram",
                                   "model": voice_id or config.DEEPGRAM_SPEAK_MODEL}},
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
                     prompt: str, company: str,
                     on_end: Optional[Callable[[list[dict]], None]] = None,
                     already_accepted: bool = False, seed_start: Optional[dict] = None) -> None:
    """Bridge one Telnyx/Twilio media stream to one Deepgram Agent session."""
    if not already_accepted:
        await telnyx_ws.accept()
    events = CallEventLog(session_id)
    stream_id: Optional[str] = None  # Twilio streamSid (echoed in outbound frames)
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
    )

    try:
        async with websockets.connect(
            config.DEEPGRAM_AGENT_URL,
            additional_headers={"Authorization": f"Token {config.DEEPGRAM_API_KEY}"},
        ) as dg:
            await dg.send(json.dumps(settings))
            events.write("session_start", {"session_id": session_id, "language": language})
            asyncio.create_task(core_post("/api/tara/calls/start", {
                "session_id": session_id, "mode": "phone",
                "voice_id": voice_id, "language": language,
            }, user_id, org_id))
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
                            await dg.send(base64.b64decode(payload))
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
                        out = {"event": "media",
                               "media": {"payload": base64.b64encode(frame).decode()}}
                        if stream_id:  # Twilio requires streamSid; Telnyx omits it
                            out["streamSid"] = stream_id
                        await telnyx_ws.send_text(json.dumps(out))
                        continue
                    msg = json.loads(frame)
                    mtype = msg.get("type")
                    if mtype == "ConversationText":
                        role, content = msg.get("role"), msg.get("content")
                        events.write("transcript", {"role": role, "content": content})
                        if role == "user":
                            turn["user_text"] = content
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
                        events.write("dg_error", {"description": msg.get("description"),
                                                  "code": msg.get("code")})
                        log.error("deepgram error session=%s: %s", session_id, msg)
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
        try:
            await core_post("/api/tara/calls/end", {"session_id": session_id}, user_id, org_id)
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
