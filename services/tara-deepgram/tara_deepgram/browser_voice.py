"""
Browser mic ⇄ Deepgram Voice Agent bridge.

Speaks the SAME WebSocket protocol as tara-aaas /voice, so AaasVoiceWidget
works unchanged when pointed here:

  browser → binary Int16 PCM s16le @16kHz
  browser ← binary Int16 PCM s16le @16kHz (TTS audio)
  browser ← JSON {type: ready|transcript|speech_start|turn_done|error}

Deepgram Agent handles STT + turn-taking + barge-in + TTS (Aura-2) in
linear16@16k both ways; think stage = our HIVEMIND shim (recall-grounded).
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

import websockets
from fastapi import WebSocket, WebSocketDisconnect

from . import config
from .agent_session import build_settings
from .core_client import core_post

log = logging.getLogger("tara_dg.browser")

# Default Aura-2 voice per language (Deepgram voice ids). English fallback.
# Per-language default Aura-2 voice. NOTE: eos-de / lotte-nl are premium and
# 403 on the current project — use plan-authorized voices (aurelia-de, beatrix-nl).
_AURA_BY_LANG = {
    "en": "aura-2-thalia-en",
    "de": "aura-2-aurelia-de",
    "es": "aura-2-celeste-es",
    "fr": "aura-2-agathe-fr",
    "nl": "aura-2-beatrix-nl",
    "it": "aura-2-livia-it",
    "ja": "aura-2-izanami-ja",
}


def _resolve_voice(voice_id: Optional[str], language: str) -> str:
    if voice_id and voice_id.startswith("aura"):
        return voice_id  # already a Deepgram voice
    return _AURA_BY_LANG.get(language, _AURA_BY_LANG["en"])


async def handle_browser_voice(ws: WebSocket, *, session_id: str,
                               user_id: Optional[str], org_id: Optional[str],
                               language: str, voice_id: Optional[str],
                               mode: str = "external") -> None:
    await ws.accept()

    prompt = (
        "You are TARA, the voice of this company's HIVEMIND. Answer briefly "
        "(1-3 spoken sentences), warmly and factually. Never invent facts."
    )
    settings = build_settings(
        session_id=session_id, user_id=user_id, org_id=org_id,
        language=language, voice_id=_resolve_voice(voice_id, language),
        prompt=prompt, company="the company",
    )
    # Browser leg is linear16@16k (widget contract), not phone mulaw.
    settings["audio"] = {
        "input":  {"encoding": "linear16", "sample_rate": 16000},
        "output": {"encoding": "linear16", "sample_rate": 16000, "container": "none"},
    }
    # Web widget mode: no phone functions, no outbound disclosure greeting.
    settings["agent"]["think"].pop("functions", None)
    settings["agent"]["greeting"] = ""
    if mode:  # per-call mode rides the think endpoint URL
        think = settings["agent"]["think"]["endpoint"]
        think["url"] = think["url"].replace("mode=external", f"mode={mode}")

    closed = asyncio.Event()
    try:
        async with websockets.connect(
            config.DEEPGRAM_AGENT_URL,
            additional_headers={"Authorization": f"Token {config.DEEPGRAM_API_KEY}"},
        ) as dg:
            await dg.send(json.dumps(settings))

            async def browser_to_dg() -> None:
                while not closed.is_set():
                    try:
                        msg = await ws.receive()
                    except (WebSocketDisconnect, RuntimeError):
                        break
                    if msg.get("type") == "websocket.disconnect":
                        break
                    data = msg.get("bytes")
                    if data:
                        await dg.send(data)
                closed.set()

            # Call-history state: pair each assistant reply with the preceding
            # user utterance and ingest as a turn (same core API as tara-aaas).
            turn = {"n": 0, "user_text": "", "latency_ms": None}

            async def dg_to_browser() -> None:
                while not closed.is_set():
                    try:
                        frame = await asyncio.wait_for(dg.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue
                    except websockets.ConnectionClosed:
                        break
                    if isinstance(frame, bytes):
                        await ws.send_bytes(frame)
                        continue
                    evt = json.loads(frame)
                    etype = evt.get("type")
                    if etype == "SettingsApplied":
                        await ws.send_text(json.dumps({"type": "ready"}))
                        asyncio.create_task(core_post("/api/tara/calls/start", {
                            "session_id": session_id, "mode": mode,
                            "voice_id": voice_id, "language": language,
                        }, user_id, org_id))
                    elif etype == "ConversationText":
                        role, content = evt.get("role"), evt.get("content")
                        await ws.send_text(json.dumps({
                            "type": "transcript", "role": role, "text": content,
                        }))
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
                    elif etype == "UserStartedSpeaking":
                        await ws.send_text(json.dumps({"type": "speech_start"}))
                    elif etype == "AgentStartedSpeaking":
                        turn["latency_ms"] = round(float(evt.get("total_latency") or 0) * 1000) or None
                        log.info("latency session=%s total=%.0fms ttt=%.0fms tts=%.0fms",
                                 session_id,
                                 float(evt.get("total_latency") or 0) * 1000,
                                 float(evt.get("ttt_latency") or 0) * 1000,
                                 float(evt.get("tts_latency") or 0) * 1000)
                    elif etype == "AgentAudioDone":
                        await ws.send_text(json.dumps({"type": "turn_done"}))
                    elif etype == "Error":
                        log.error("dg error session=%s: %s", session_id, evt)
                        await ws.send_text(json.dumps({
                            "type": "error",
                            "message": evt.get("description") or "agent error",
                        }))
                closed.set()

            async def keepalive() -> None:
                while not closed.is_set():
                    await asyncio.sleep(8)
                    try:
                        await dg.send(json.dumps({"type": "KeepAlive"}))
                    except websockets.ConnectionClosed:
                        break

            tasks = [asyncio.create_task(t()) for t in (browser_to_dg, dg_to_browser, keepalive)]
            await closed.wait()
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    except Exception as e:  # noqa: BLE001
        log.exception("browser voice bridge failed session=%s", session_id)
        try:
            await ws.send_text(json.dumps({"type": "error", "message": str(e)}))
        except Exception:  # noqa: BLE001
            pass
    finally:
        # Finalize call history (+ triggers core-side session insights).
        try:
            await core_post("/api/tara/calls/end", {"session_id": session_id}, user_id, org_id)
        except Exception:  # noqa: BLE001
            pass
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
