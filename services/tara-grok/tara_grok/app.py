from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import Iterable

import httpx
import websockets
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from . import config
from .core_client import consume_capability, emit_event
from .prompt import SYSTEM_PROMPT
from .tools import TOOL_SCHEMAS, execute

log = logging.getLogger("tara_grok")
app = FastAPI(title="TARA Grok Voice", version="1.0.0")

# Fallback only. The live roster comes from xAI's own catalogue (GET /v1/tts/voices
# + GET /v1/custom-voices) — see _load_voices(). These five are the documented
# built-ins and keep the picker usable if xAI is briefly unreachable.
FALLBACK_VOICES = [
    {"id": "eve", "provider": "grok", "name": "Eve", "language": "en", "gender": "feminine", "description": "Clear, warm and conversational", "custom": False},
    {"id": "ara", "provider": "grok", "name": "Ara", "language": "en", "gender": "feminine", "description": "Calm and professional", "custom": False},
    {"id": "rex", "provider": "grok", "name": "Rex", "language": "en", "gender": "masculine", "description": "Confident and direct", "custom": False},
    {"id": "sal", "provider": "grok", "name": "Sal", "language": "en", "gender": "neutral", "description": "Balanced and natural", "custom": False},
    {"id": "leo", "provider": "grok", "name": "Leo", "language": "en", "gender": "masculine", "description": "Warm and measured", "custom": False},
]

VOICE_CACHE_TTL_SECONDS = 10 * 60
_voice_cache: dict[str, tuple[list[dict], float]] = {}


async def _load_voices() -> list[dict]:
    """Every official Grok voice, straight from xAI, plus the team's custom voices.

    `GET /v1/tts/voices` is the authoritative roster (the same voice ids the
    realtime `session.update` `voice` parameter accepts), so the picker tracks
    xAI's catalogue instead of a list we have to hand-maintain. Custom voices are
    merged in when the team has any. Cached; falls back to the documented
    built-ins if xAI is unreachable so the picker is never empty.
    """
    cached = _voice_cache.get("all")
    if cached and cached[1] > time.monotonic():
        return cached[0]

    headers = {"Authorization": f"Bearer {config.XAI_API_KEY}"}
    voices: list[dict] = []
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.get("https://api.x.ai/v1/tts/voices", headers=headers)
            response.raise_for_status()
            for item in (response.json() or {}).get("voices", []):
                voice_id = item.get("voice_id")
                if not voice_id:
                    continue
                voices.append({
                    "id": voice_id,
                    "provider": "grok",
                    "name": item.get("name") or str(voice_id).title(),
                    "language": item.get("language") or "en",
                    "gender": "",
                    "description": "",
                    "custom": False,
                })
            # Custom (cloned) voices are optional and entitlement-gated — never fatal.
            try:
                custom = await client.get("https://api.x.ai/v1/custom-voices", headers=headers)
                if custom.status_code == 200:
                    for item in (custom.json() or {}).get("voices", []):
                        voice_id = item.get("voice_id")
                        if not voice_id:
                            continue
                        voices.append({
                            "id": voice_id,
                            "provider": "grok",
                            "name": item.get("name") or str(voice_id),
                            "language": item.get("language") or "en",
                            "gender": item.get("gender") or "",
                            "description": item.get("description") or "",
                            "custom": True,
                        })
            except Exception:
                log.warning("custom voice list unavailable", exc_info=False)
    except Exception:
        log.warning("xAI voice catalogue unavailable — serving fallback roster", exc_info=False)

    if not voices:
        return FALLBACK_VOICES
    _voice_cache["all"] = (voices, time.monotonic() + VOICE_CACHE_TTL_SECONDS)
    return voices

MAX_BINARY_FRAME_BYTES = 32 * 1024
MAX_CONTROL_FRAME_BYTES = 16 * 1024
TOOL_BATCH_WINDOW_SECONDS = 0.05

# ── Session resumption (xAI realtime spec) ──────────────────────────────────
# Sending `resumption.enabled: true` only makes xAI CACHE the turns. To actually
# replay them the reconnect must carry `?conversation_id=<id>`, where the id came
# from the server's `conversation.created` event. Without that round-trip the
# opt-in is dead config and every reconnect starts cold.
#
# The id is cached HERE, keyed by the authenticated principal taken from the
# consumed capability — never accepted from the client. A client-supplied
# conversation_id would let a caller replay another tenant's conversation.
RESUMPTION_TTL_SECONDS = 15 * 60
MAX_RESUMPTION_ENTRIES = 5_000
_conversation_cache: dict[tuple[str, str], tuple[str, float]] = {}


def _resume_conversation_id(principal: tuple[str, str]) -> str | None:
    entry = _conversation_cache.get(principal)
    if not entry:
        return None
    conversation_id, expires_at = entry
    if expires_at <= time.monotonic():
        _conversation_cache.pop(principal, None)
        return None
    return conversation_id


def _remember_conversation(principal: tuple[str, str], conversation_id: str | None) -> None:
    if not conversation_id or not any(principal):
        return
    now = time.monotonic()
    if len(_conversation_cache) >= MAX_RESUMPTION_ENTRIES:
        for key, (_, expires_at) in list(_conversation_cache.items()):
            if expires_at <= now:
                _conversation_cache.pop(key, None)
        if len(_conversation_cache) >= MAX_RESUMPTION_ENTRIES:
            _conversation_cache.pop(next(iter(_conversation_cache)), None)
    _conversation_cache[principal] = (conversation_id, now + RESUMPTION_TTL_SECONDS)


def _capability_from_subprotocols(protocols: Iterable[str]) -> str:
    """Read the one-time capability without putting it in a URL or its logs."""
    for protocol in protocols:
        if protocol.startswith("hm.tara.cap."):
            return protocol.removeprefix("hm.tara.cap.")
    return ""


def _session_update(snapshot: dict) -> dict:
    return {
        "type": "session.update",
        "session": {
            "instructions": "\n\n".join(part for part in [SYSTEM_PROMPT, snapshot.get("instructions", "")] if part),
            "voice": snapshot.get("voice_id", "eve"),
            "reasoning": {"effort": snapshot.get("reasoning_effort", "high")},
            "turn_detection": {
                "type": "server_vad",
                "threshold": snapshot.get("vad_threshold", 0.85),
                "silence_duration_ms": snapshot.get("vad_silence_duration_ms", 650),
                "prefix_padding_ms": snapshot.get("vad_prefix_padding_ms", 333),
            },
            "resumption": {"enabled": True},
            "audio": {
                "input": {
                    "format": {"type": "audio/pcm", "rate": 16000},
                    "transport": "binary",
                    "transcription": {
                        "model": "grok-transcribe",
                        "language_hint": snapshot.get("language", "en"),
                        "keyterms": snapshot.get("keyterms", []),
                    },
                },
                "output": {
                    "format": {"type": "audio/pcm", "rate": 16000},
                    "transport": "binary",
                    "speed": snapshot.get("output_speed", 1.0),
                },
            },
            "replace": snapshot.get("pronunciation_replacements", {}),
            "tools": TOOL_SCHEMAS,
        },
    }

def _browser_event(event: dict) -> dict | None:
    """Normalize xAI events to TARA's provider-neutral widget contract."""
    event_type = event.get("type")
    if event_type == "session.updated":
        return {"type": "ready"}
    if event_type == "input_audio_buffer.speech_started":
        return {"type": "speech_start"}
    if event_type in {
        "conversation.item.input_audio_transcription.updated",
        "conversation.item.input_audio_transcription.completed",
    }:
        return {"type": "transcript", "text": event.get("transcript") or ""}
    if event_type in {
        "response.output_audio_transcript.delta",
        "response.text.delta",
        "response.output_text.delta",
    }:
        return {"type": "agent_text", "text": event.get("delta") or ""}
    if event_type == "response.done":
        return {"type": "turn_done"}
    if event_type == "error":
        error = event.get("error") or {}
        return {"type": "error", "error": error.get("message") or event.get("message") or "Grok realtime error"}
    return None


def _opening_events(snapshot: dict) -> list[dict]:
    """Seed an assistant-first opening turn after the realtime session is ready."""
    instruction = (snapshot.get("opening_instruction") or "").strip()
    if not instruction:
        goal = (snapshot.get("goal") or "").strip()
        language = snapshot.get("language", "en")
        if goal:
            instruction = (
                "The voice session has just connected. The user has not spoken yet. "
                f"Speak first in {language}. Privately plan a concise opening for this goal, "
                f"then say only the opening aloud: {goal}"
            )
        else:
            instruction = (
                "The voice session has just connected. The user has not spoken yet. "
                f"Speak first in {language}. Give a short natural TARA greeting and invite "
                "the user to choose what to work through first."
            )
    return [
        {
            "type": "conversation.item.create",
            "item": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": instruction}],
            },
        },
        {"type": "response.create"},
    ]


@app.get("/health/live")
async def health_live():
    return {"ok": True, "service": "tara-grok"}

@app.get("/health/ready")
async def health_ready():
    error = config.ready_error()
    if error:
        return JSONResponse({"ok": False, "error": error}, status_code=503)
    return {"ok": True, "service": "tara-grok", "model": config.TARA_GROK_MODEL}

# Grok speech-to-speech supported languages (official list). The voices themselves
# are multilingual — the model detects and answers in the caller's language — so the
# language selector drives the conversation/ASR hint, not which voices are offered.
GROK_LANGUAGES = [
    "en", "ar-EG", "ar-SA", "ar-AE", "bn", "zh", "fr", "de", "hi", "id",
    "it", "ja", "ko", "pt-BR", "pt-PT", "ru", "es-MX", "es-ES", "tr", "vi",
]


@app.get("/voices")
async def voices(language: str | None = None):
    catalogue = await _load_voices()
    # Grok voices are multilingual, so a language filter must never narrow them —
    # filtering by exact language would empty the picker.
    return {"voices": catalogue, "languages": GROK_LANGUAGES}

async def _xai_connect(snapshot: dict, resume_conversation_id: str | None = None):
    url = f"{config.XAI_REALTIME_URL}?model={config.TARA_GROK_MODEL}"
    if resume_conversation_id:
        # Replays the cached turns so the model stays conditioned on prior context.
        url += f"&conversation_id={resume_conversation_id}"
    return await websockets.connect(url, additional_headers={"Authorization": f"Bearer {config.XAI_API_KEY}"}, max_size=8 * 1024 * 1024)

@app.websocket("/voice/{session_id}")
async def voice(ws: WebSocket, session_id: str):
    capability = _capability_from_subprotocols(ws.scope.get("subprotocols", []))
    if not capability or not session_id:
        # Minimal, non-secret diagnostics: both rejection paths used to close 4401
        # silently, so a failed handshake was indistinguishable from a bad token.
        log.warning(
            "voice handshake rejected: no capability subprotocol (session=%s, subprotocols=%s)",
            session_id, [p.split(".")[0:3] for p in ws.scope.get("subprotocols", [])],
        )
        await ws.close(code=4401)
        return
    try:
        session = await consume_capability(session_id, capability)
    except Exception as error:
        status = getattr(getattr(error, "response", None), "status_code", None)
        detail = getattr(getattr(error, "response", None), "text", "")
        log.warning(
            "voice handshake rejected: capability consume failed (session=%s, core_status=%s, detail=%s)",
            session_id, status, str(detail)[:200] or type(error).__name__,
        )
        await ws.close(code=4401)
        return
    log.info("voice session accepted (session=%s, provider=grok)", session_id)
    await ws.accept(subprotocol="hm.tara.v1")
    snapshot = session.get("config", {})
    # Principal comes from the CONSUMED capability (Core-authenticated), so the
    # resumption cache can never be steered by client input.
    principal = (str(session.get("org_id") or ""), str(session.get("user_id") or ""))
    try:
        xai = await _xai_connect(snapshot, _resume_conversation_id(principal))
        await xai.send(json.dumps(_session_update(snapshot)))
    except Exception:
        log.exception("xAI realtime connection failed")
        await emit_event(session_id, {"event_id": str(uuid.uuid4()), "type": "failed", "payload": {"failure_code": "xai_connect_failed"}})
        await ws.close(code=1011)
        return
    await emit_event(session_id, {"event_id": str(uuid.uuid4()), "type": "started", "payload": {"provider": "grok", "model": config.TARA_GROK_MODEL}})

    async def browser_to_xai():
        try:
            while True:
                message = await ws.receive()
                if message.get("bytes") is not None:
                    if len(message["bytes"]) > MAX_BINARY_FRAME_BYTES:
                        await ws.close(code=1009)
                        return
                    await xai.send(message["bytes"])
                elif message.get("text"):
                    if len(message["text"].encode("utf-8")) > MAX_CONTROL_FRAME_BYTES:
                        await ws.close(code=1009)
                        return
                    payload = json.loads(message["text"])
                    if payload.get("type") not in {"input_audio_buffer.commit", "input_audio_buffer.clear", "response.cancel"}:
                        continue
                    await xai.send(json.dumps(payload))
        except WebSocketDisconnect:
            pass

    pending_tool_calls: list[dict] = []
    tool_batch_task: asyncio.Task | None = None
    opening_sent = False

    async def flush_tool_calls():
        nonlocal pending_tool_calls
        await asyncio.sleep(TOOL_BATCH_WINDOW_SECONDS)
        calls, pending_tool_calls = pending_tool_calls, []
        results = await asyncio.gather(*[
            execute(session_id, event["name"], event["arguments"])
            for event in calls
        ], return_exceptions=True)
        for event, result in zip(calls, results):
            output = result if not isinstance(result, Exception) else {"error": "tool_execution_failed"}
            await xai.send(json.dumps({"type": "conversation.item.create", "item": {"type": "function_call_output", "call_id": event["call_id"], "output": json.dumps(output)}}))
        await xai.send(json.dumps({"type": "response.create"}))

    async def xai_to_browser():
        nonlocal tool_batch_task, opening_sent
        terminal_event = {"event_id": str(uuid.uuid4()), "type": "completed", "payload": {"provider": "grok"}}
        try:
            async for message in xai:
                if isinstance(message, bytes):
                    await ws.send_bytes(message)
                    continue
                event = json.loads(message)
                if event.get("type") == "conversation.created":
                    # Capture the id so the NEXT connection can resume this conversation.
                    _remember_conversation(principal, (event.get("conversation") or {}).get("id"))
                if event.get("type") == "session.updated" and not opening_sent:
                    opening_sent = True
                    for opening_event in _opening_events(snapshot):
                        await xai.send(json.dumps(opening_event))
                if event.get("type") == "response.function_call_arguments.done":
                    try:
                        args = json.loads(event.get("arguments") or "{}")
                    except json.JSONDecodeError:
                        args = {}
                    pending_tool_calls.append({"name": event.get("name", ""), "call_id": event.get("call_id"), "arguments": args})
                    if not tool_batch_task or tool_batch_task.done():
                        tool_batch_task = asyncio.create_task(flush_tool_calls())
                browser_event = _browser_event(event)
                if browser_event:
                    await ws.send_text(json.dumps(browser_event))
        except Exception:
            log.exception("xAI realtime session failed")
            terminal_event = {"event_id": str(uuid.uuid4()), "type": "failed", "payload": {"provider": "grok", "failure_code": "xai_session_failed"}}
        finally:
            if tool_batch_task and not tool_batch_task.done():
                tool_batch_task.cancel()
            await emit_event(session_id, terminal_event)

    tasks = [asyncio.create_task(browser_to_xai()), asyncio.create_task(xai_to_browser())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks: task.cancel()
        await xai.close()

@app.post("/webhooks/telnyx")
async def telnyx_webhook():
    # Public ingress is intentionally not enabled until Core issues a signed call mapping.
    raise HTTPException(status_code=503, detail="Telnyx Grok bridge not enabled")
