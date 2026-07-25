from __future__ import annotations

import asyncio
import json
import logging
import uuid

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

BUILTIN_VOICES = [
    {"id": "eve", "provider": "grok", "name": "Eve", "language": "en", "gender": "feminine", "description": "Clear, warm and conversational", "custom": False},
    {"id": "ara", "provider": "grok", "name": "Ara", "language": "en", "gender": "feminine", "description": "Calm and professional", "custom": False},
    {"id": "rex", "provider": "grok", "name": "Rex", "language": "en", "gender": "masculine", "description": "Confident and direct", "custom": False},
    {"id": "sal", "provider": "grok", "name": "Sal", "language": "en", "gender": "neutral", "description": "Balanced and natural", "custom": False},
    {"id": "leo", "provider": "grok", "name": "Leo", "language": "en", "gender": "masculine", "description": "Warm and measured", "custom": False},
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

@app.get("/voices")
async def voices(language: str | None = None):
    items = [v for v in BUILTIN_VOICES if not language or v["language"].startswith(language.split("-")[0])]
    return {"voices": items, "languages": sorted({v["language"] for v in items})}

async def _xai_connect(snapshot: dict):
    url = f"{config.XAI_REALTIME_URL}?model={config.TARA_GROK_MODEL}"
    return await websockets.connect(url, additional_headers={"Authorization": f"Bearer {config.XAI_API_KEY}"}, max_size=8 * 1024 * 1024)

@app.websocket("/voice")
async def voice(ws: WebSocket):
    capability = ws.query_params.get("capability", "")
    session_id = ws.query_params.get("session_id", "")
    if not capability or not session_id:
        await ws.close(code=4401)
        return
    try:
        session = await consume_capability(session_id, capability)
    except Exception:
        await ws.close(code=4401)
        return
    await ws.accept()
    snapshot = session.get("config", {})
    xai = await _xai_connect(snapshot)
    await xai.send(json.dumps({"type": "session.update", "session": {"instructions": SYSTEM_PROMPT, "voice": snapshot.get("voice_id", "eve"), "reasoning": {"effort": snapshot.get("reasoning_effort", "high")}, "audio": {"input": {"format": {"type": "audio/pcm", "rate": 16000}, "transcription": {"language_hint": snapshot.get("language", "en")}}, "output": {"format": {"type": "audio/pcm", "rate": 16000}, "speed": snapshot.get("output_speed", 1.0)}}, "tools": TOOL_SCHEMAS}}))
    await emit_event(session_id, {"event_id": str(uuid.uuid4()), "type": "started", "payload": {"provider": "grok", "model": config.TARA_GROK_MODEL}})

    async def browser_to_xai():
        try:
            while True:
                message = await ws.receive()
                if message.get("bytes") is not None:
                    await xai.send(message["bytes"])
                elif message.get("text"):
                    payload = json.loads(message["text"])
                    await xai.send(json.dumps(payload))
        except WebSocketDisconnect:
            pass

    async def xai_to_browser():
        try:
            async for message in xai:
                if isinstance(message, bytes):
                    await ws.send_bytes(message)
                    continue
                event = json.loads(message)
                if event.get("type") == "response.function_call_arguments.done":
                    args = json.loads(event.get("arguments") or "{}")
                    result = await execute(session_id, event.get("name", ""), args)
                    await xai.send(json.dumps({"type": "conversation.item.create", "item": {"type": "function_call_output", "call_id": event.get("call_id"), "output": json.dumps(result)}}))
                    await xai.send(json.dumps({"type": "response.create"}))
                await ws.send_text(json.dumps(event))
        finally:
            await emit_event(session_id, {"event_id": str(uuid.uuid4()), "type": "completed", "payload": {"provider": "grok"}})

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
