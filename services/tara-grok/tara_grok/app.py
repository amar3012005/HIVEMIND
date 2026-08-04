from __future__ import annotations

import asyncio
import base64
import hmac
import json
import logging
import time
import uuid
from collections.abc import Iterable

import httpx
import websockets
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from . import config, listen, telephony
from .core_client import consume_capability, emit_event
from .prompt import SYSTEM_PROMPT
from .tools import TOOL_SCHEMAS, execute

# Without this, `tara_grok` has no handler and logging.lastResort drops anything
# below WARNING — every log.info in this service was silently discarded, which
# made the PSTN bridge impossible to diagnose. tara-deepgram has always done this.
logging.basicConfig(level=logging.INFO)
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


def _session_update(snapshot: dict, media: str = "browser") -> dict:
    """Session config. `media` selects the audio profile:

    - "browser"   PCM16 @16kHz over binary frames (mic/speaker path).
    - "telephony" G.711 μ-law @8kHz over JSON frames. Zernio/Telnyx media
      streaming delivers exactly that, base64 in JSON, and xAI accepts
      `audio/pcmu` at 8000 Hz natively — so the PSTN bridge is a pure base64
      re-wrap with NO transcode and no added latency.
    """
    if media == "telephony":
        audio_format = {"type": "audio/pcmu", "rate": 8000}
        transport = "json"
        # Telephony-tuned VAD. The browser defaults are wrong for a phone line:
        # PSTN audio is narrowband and quieter, so threshold 0.85 misses normal
        # speech (the caller ends up repeating themselves); 333ms of prefix
        # padding clips the start of the first word; 650ms of trailing silence
        # makes every turn feel laggy on a call.
        vad = {
            "threshold": snapshot.get("vad_threshold", 0.5),
            "silence_duration_ms": snapshot.get("vad_silence_duration_ms", 420),
            "prefix_padding_ms": snapshot.get("vad_prefix_padding_ms", 500),
        }
    else:
        audio_format = {"type": "audio/pcm", "rate": 16000}
        transport = "binary"
        vad = {
            "threshold": snapshot.get("vad_threshold", 0.85),
            "silence_duration_ms": snapshot.get("vad_silence_duration_ms", 650),
            "prefix_padding_ms": snapshot.get("vad_prefix_padding_ms", 333),
        }
    return {
        "type": "session.update",
        "session": {
            "instructions": "\n\n".join(part for part in [
                SYSTEM_PROMPT,
                snapshot.get("instructions", ""),
                # Same org brief the phone leg gets, from the session snapshot core
                # minted — so a browser conversation is grounded identically.
                (f"[ORG] Who you work for:\n{str(snapshot.get('org_brief') or '')[:600]}"
                 if snapshot.get("org_brief") else ""),
            ] if part),
            "voice": snapshot.get("voice_id", "eve"),
            "reasoning": {"effort": snapshot.get("reasoning_effort", "high")},
            "turn_detection": {"type": "server_vad", **vad},
            "resumption": {"enabled": True},
            "audio": {
                "input": {
                    "format": audio_format,
                    "transport": transport,
                    "transcription": {
                        "model": "grok-transcribe",
                        "language_hint": snapshot.get("language", "en"),
                        "keyterms": snapshot.get("keyterms", []),
                    },
                },
                "output": {
                    "format": audio_format,
                    "transport": transport,
                    "speed": snapshot.get("output_speed", 1.0),
                },
            },
            "replace": snapshot.get("pronunciation_replacements", {}),
            "tools": TOOL_SCHEMAS,
            # Explicit not implicit: measured 4 realtime text inputs across 37 calls —
            # tools were registered but never chosen. Bar lowered in prompt.py; auto here.
            "tool_choice": "auto",
        },
    }


def _telephony_instructions(meta: dict) -> str:
    """Turn a dial request into the call's operating brief.

    The selected TARA skill's prompt leads (it defines persona and method); the
    per-call brief follows so it can specialise, not fight, the skill.
    """
    parts = []
    if meta.get("skill_prompt"):
        parts.append(str(meta["skill_prompt"]).strip())
    # `company` is WHO YOU WORK FOR (matches tara-deepgram's "phone agent for
    # {company}"); `contact_name` is WHO YOU ARE CALLING. These were inverted
    # here, which is how TARA ended up introducing herself as an agent of the
    # prospect she was cold-calling.
    if meta.get("company"):
        parts.append(f"You are a phone agent for {meta['company']}; introduce yourself as calling from it.")
    # Compact org brief, supplied by core in the dial payload. Every new call opens
    # knowing what this company actually does — not just its name — for any tenant
    # and any skill, without a company-specific prompt anywhere in this service.
    if meta.get("org_brief"):
        parts.append("Who you work for: " + str(meta["org_brief"])[:600].replace("\n", " ")
                     + " Speak from this when asked what the company does; never contradict it "
                       "and never invent beyond it.")
    if meta.get("contact_name"):
        parts.append(f"You are calling {meta['contact_name']}.")
    if meta.get("goal"):
        parts.append(f"Objective: {meta['goal']}")
    if meta.get("context"):
        parts.append(f"Background: {meta['context']}")
    # The opener response.create carries the AI + recording disclosure, so don't
    # duplicate it here — repeating it just burns the first turn.
    parts.append("Keep every turn to one or two sentences — this is a phone call, "
                 "not a document. Never wait in silence.")
    return " ".join(parts)

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


@app.get("/capabilities")
async def capabilities():
    """What this adapter can actually fulfil, for the Outreach Contract router.

    Declared, not guessed: core reads this to decide whether an outreach call can
    be dialed here or must be handed to the user's browser. `telephony` is now
    true once Zernio credentials are present — this adapter dials for itself, so a
    Grok org gets Grok on the phone instead of parking every target as 'browser'.
    """
    return {
        "provider": "grok",
        "model": config.TARA_GROK_MODEL,
        "telephony": config.telephony_enabled(),   # Zernio (Telnyx-backed) PSTN
        "browser": True,             # realtime browser voice over /voice/{session_id}
        "channels": ["call"],
        "contract_versions": [1],
        "custom_voices": config.CUSTOM_VOICES_ENABLED if hasattr(config, "CUSTOM_VOICES_ENABLED") else False,
    }


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
    max_duration_seconds = int(snapshot.get("max_duration_seconds") or 0)
    closing_phrase = str(snapshot.get("closing_phrase") or "").strip()

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

    async def end_at_runtime_limit():
        """Close the Runtime-admin check-in on the server even if the tab stalls."""
        if max_duration_seconds <= 0:
            return
        await asyncio.sleep(max(max_duration_seconds - 6, 0))
        if closing_phrase:
            try:
                await xai.send(json.dumps({
                    "type": "conversation.item.create",
                    "item": {"type": "message", "role": "user", "content": [{
                        "type": "input_text",
                        "text": f"The internal check-in ends now. Say exactly: {closing_phrase}",
                    }]},
                }))
                await xai.send(json.dumps({"type": "response.create"}))
            except websockets.ConnectionClosed:
                return
        await asyncio.sleep(min(6, max_duration_seconds))
        await ws.close(code=1000, reason="runtime_time_limit")

    tasks = [asyncio.create_task(browser_to_xai()), asyncio.create_task(xai_to_browser())]
    deadline_task = asyncio.create_task(end_at_runtime_limit()) if max_duration_seconds > 0 else None
    try:
        wait_for = [*tasks, *([deadline_task] if deadline_task else [])]
        await asyncio.wait(wait_for, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in [*tasks, *([deadline_task] if deadline_task else [])]: task.cancel()
        await xai.close()

@app.post("/webhooks/telnyx")
async def telnyx_webhook():
    # Public ingress is intentionally not enabled until Core issues a signed call mapping.
    raise HTTPException(status_code=503, detail="Telnyx Grok bridge not enabled")


# ── PSTN telephony ───────────────────────────────────────────────────────────

def _dial_auth_ok(request: Request) -> bool:
    """Shared-secret gate on the side-effectful dial routes, same contract as
    tara-deepgram (header `x-tara-key`). Constant-time compare; empty env = open
    so the route can be deployed before the secret is set on both sides."""
    expected = config.DIAL_API_KEY
    if not expected:
        return True
    supplied = (request.headers.get("x-tara-key") or "").strip()
    return bool(supplied) and hmac.compare_digest(supplied, expected)


@app.post("/calls/outbound")
async def calls_outbound(req: telephony.DialRequest, request: Request):
    """Dial a prospect and bridge the answered call into a Grok session.

    Same path and payload as tara-deepgram's, so core's campaign runner reaches
    either adapter with one call — it picks by the campaign's snapshotted provider.
    """
    if not _dial_auth_ok(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    try:
        return await telephony.dial(req)
    except ValueError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    except Exception as error:  # noqa: BLE001
        log.exception("grok dial failed")
        return JSONResponse({"error": str(error)[:300]}, status_code=502)


@app.post("/calls/outbound/{call_leg_id}/hangup")
async def calls_hangup(call_leg_id: str, request: Request):
    if not _dial_auth_ok(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    try:
        await telephony.hangup(call_leg_id)
        return {"ok": True}
    except ValueError as error:
        return JSONResponse({"error": str(error)}, status_code=404)


@app.get("/calls/outbound/{call_leg_id}/status")
async def calls_status(call_leg_id: str):
    meta = telephony.pending_calls.get(call_leg_id)
    if not meta:
        return JSONResponse({"error": "not_found"}, status_code=404)
    return {"call_leg_id": call_leg_id, "status": meta.get("status"),
            "session_id": meta.get("session_id")}


@app.websocket("/calls/listen")
async def calls_listen(ws: WebSocket):
    """Listen-only browser tap into a live Grok call. Same wire contract as
    tara-deepgram (binary PCM16 mono 8kHz + JSON control), so the existing
    dashboard player works unchanged. Auth = Core-minted session-scoped token."""
    qp = ws.query_params
    await listen.handle_listen(ws, session_id=qp.get("session_id") or "",
                               token=qp.get("token") or "")


@app.websocket("/telnyx/stream")
async def telnyx_stream(ws: WebSocket):
    """Bridge one Zernio/Telnyx media stream to one xAI realtime session.

    Both sides speak G.711 μ-law @8kHz base64-in-JSON, so this is a re-wrap in
    each direction — no transcode, no resampling. Frames are teed to
    listen.tee() so the dashboard can hear the call live.
    """
    session_id = ws.query_params.get("session_id") or ""
    meta = telephony.find_by_session(session_id) or {}
    await ws.accept()
    if not session_id:
        await ws.close(code=1008)
        return

    snapshot = {
        "voice_id": meta.get("voice_id") or ws.query_params.get("voice_id") or "eve",
        "language": meta.get("language") or ws.query_params.get("language") or "en",
        "instructions": _telephony_instructions(meta),
    }
    try:
        xai = await _xai_connect(snapshot, _resume_conversation_id(
            (str(meta.get("org_id") or ""), str(meta.get("user_id") or ""))))
        await xai.send(json.dumps(_session_update(snapshot, media="telephony")))
        # SPEAK FIRST. With server_vad the model waits for the caller, so on an
        # OUTBOUND call nobody talks until the callee does — the line just sits
        # silent and the human hangs up or says "hello?" twice. We placed this
        # call, so TARA owes the first word. Ask for the opening turn immediately
        # with a per-response instruction: it also carries the AI + recording
        # disclosure (EU AI Act Art. 50 parity with tara-deepgram's `greeting`)
        # and is capped short so time-to-first-audio stays low.
        await xai.send(json.dumps({
            "type": "response.create",
            "response": {"instructions": (
                # AI disclosure is legally required (EU AI Act Art. 50) and stays.
                # The recording line is GONE — calls are no longer recorded, so
                # announcing it was both untrue and a needless trust hit.
                "Open the call now, before the other person speaks. In ONE short sentence: "
                "say you are an AI assistant calling"
                + (f" from {meta['company']}" if meta.get("company") else "")
                + ", then give the single most relevant reason you are calling and ask one "
                "opening question. Under 25 words. Do not wait."
            )},
        }))
    except Exception:  # noqa: BLE001
        log.exception("xAI connect failed for PSTN session=%s", session_id)
        await ws.close(code=1011)
        return
    log.info("grok PSTN bridge open session=%s leg=%s (opener requested)",
             session_id, meta.get("call_control_id"))
    # Persistence: these events relay into the SAME /api/tara/calls pipeline
    # deepgram uses, so a Grok phone call produces a call row, turns, and the
    # full post-call pass (insight, leads, learnings) instead of nothing.
    await emit_event(session_id, {"event_id": str(uuid.uuid4()), "type": "started",
                                  "payload": {"provider": "grok", "channel": "pstn"}})
    turn_state = {"seq": 0, "user": ""}
    listen.tee_json(session_id, {"type": "ready", "session_id": session_id})

    async def pstn_to_xai():
        """Carrier → model. `media` frames carry base64 μ-law; forward verbatim."""
        try:
            while True:
                raw = await ws.receive_text()
                msg = json.loads(raw)
                event = msg.get("event")
                if event == "media":
                    payload = (msg.get("media") or {}).get("payload")
                    if payload:
                        await xai.send(json.dumps({
                            "type": "input_audio_buffer.append", "audio": payload,
                        }))
                        try:
                            listen.tee(session_id, "in", base64.b64decode(payload))
                        except Exception:  # noqa: BLE001
                            pass
                elif event == "stop":
                    break
        except (WebSocketDisconnect, RuntimeError):
            pass
        except Exception:  # noqa: BLE001
            log.exception("pstn_to_xai failed session=%s", session_id)

    async def xai_to_pstn():
        """Model → carrier. Audio deltas are base64 μ-law; re-wrap as media."""
        try:
            async for message in xai:
                if isinstance(message, bytes):
                    continue  # telephony profile uses json transport only
                event = json.loads(message)
                etype = event.get("type")
                if etype in ("response.output_audio.delta", "response.audio.delta"):
                    audio = event.get("delta") or event.get("audio")
                    if audio:
                        await ws.send_text(json.dumps({
                            "event": "media", "media": {"payload": audio},
                        }))
                        try:
                            listen.tee(session_id, "out", base64.b64decode(audio))
                        except Exception:  # noqa: BLE001
                            pass
                    continue
                if etype == "conversation.created":
                    _remember_conversation(
                        (str(meta.get("org_id") or ""), str(meta.get("user_id") or "")),
                        (event.get("conversation") or {}).get("id"))
                # Mirror transcripts to dashboard listeners (same shape as deepgram).
                if etype == "conversation.item.input_audio_transcription.completed":
                    text = event.get("transcript") or ""
                    turn_state["user"] = text
                    listen.tee_json(session_id, {"type": "transcript", "role": "user",
                                                 "content": text})
                elif etype == "response.output_audio_transcript.done":
                    text = event.get("transcript") or ""
                    listen.tee_json(session_id, {"type": "transcript", "role": "assistant",
                                                 "content": text})
                    # One turn = the caller's utterance + TARA's reply, matching
                    # how tara-deepgram records them so both providers produce
                    # the same transcript shape.
                    turn_state["seq"] += 1
                    asyncio.create_task(emit_event(session_id, {
                        "event_id": str(uuid.uuid4()), "type": "turn",
                        "payload": {"seq": turn_state["seq"],
                                    "user_text": turn_state.get("user") or "",
                                    "agent_text": text},
                    }))
                    turn_state["user"] = ""
        except Exception:  # noqa: BLE001
            log.exception("xai_to_pstn failed session=%s", session_id)

    tasks = [asyncio.create_task(pstn_to_xai()), asyncio.create_task(xai_to_pstn())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        listen.tee_json(session_id, {"type": "ended", "session_id": session_id})
        # Terminal event → Core relays to /api/tara/calls/end, which runs the
        # post-call pass. Without this a Grok call would never be analysed.
        try:
            await emit_event(session_id, {"event_id": str(uuid.uuid4()),
                                          "type": "completed",
                                          "payload": {"provider": "grok"}})
        except Exception:  # noqa: BLE001
            log.exception("grok completed event failed session=%s", session_id)
        await xai.close()
        log.info("grok PSTN bridge closed session=%s", session_id)
