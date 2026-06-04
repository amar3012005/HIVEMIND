"""
TARA AaaS FastAPI entrypoint (scaffold).

Phase A: health + a /verify/stream-tara route that proves the tara_stream
integration end-to-end. STT/TTS/VAD WS layers land in later phases.
"""
from __future__ import annotations

import json
import logging
import os
import time

import httpx
from fastapi import FastAPI, WebSocket
from fastapi.responses import StreamingResponse, JSONResponse, Response
from pydantic import BaseModel

from . import config
from .tara_stream import stream_tara
from .voice_ws import handle_voice

CARTESIA_KEY = os.getenv("CARTESIA_API_KEY", "")
CARTESIA_VER = "2024-11-13"

logging.basicConfig(level=logging.INFO)
app = FastAPI(title="TARA AaaS", version="0.1.0")

# CORS — browser fetch (/voices, /voice-preview) from the HIVEMIND frontend is
# cross-origin (hivemind.davinciai.eu → core:8050). WS bypasses CORS; REST needs it.
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https://([a-z0-9-]+\.)*davinciai\.eu",
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {
        "ok": True,
        "service": "tara-aaas",
        "tara_stream_url": config.HIVEMIND_TARA_STREAM_URL,
        "api_key_set": bool(config.HIVEMIND_API_KEY),
    }


class VerifyReq(BaseModel):
    query: str = "Hello TARA, are you reachable?"
    user_id: str | None = None
    org_id: str | None = None
    session_id: str = "aaas-verify"
    language: str = "en"


@app.post("/verify/stream-tara")
async def verify_stream_tara(req: VerifyReq):
    """Stream NDJSON of token events from tara_stream — proves integration."""
    async def gen():
        started = time.monotonic()
        first_token_ms = None
        full = ""
        async for evt in stream_tara(
            query=req.query,
            session_id=req.session_id,
            user_id=req.user_id,
            org_id=req.org_id,
            language=req.language,
        ):
            if evt["type"] == "token":
                if first_token_ms is None:
                    first_token_ms = round((time.monotonic() - started) * 1000)
                full += evt["text"]
            yield json.dumps(evt) + "\n"
        yield json.dumps({
            "type": "summary",
            "first_token_ms": first_token_ms,
            "total_ms": round((time.monotonic() - started) * 1000),
            "chars": len(full),
            "full_text": full,
        }) + "\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson")


@app.websocket("/voice")
async def voice(ws: WebSocket):
    # Phase 2 replaces query-param identity with cookie→whoami verification.
    qp = ws.query_params
    await handle_voice(
        ws,
        user_id=qp.get("user_id"),
        org_id=qp.get("org_id"),
        session_id=qp.get("session_id") or "voice-session",
        language=qp.get("language") or "en",
        voice_id=qp.get("voice_id") or None,
        mode=qp.get("mode") or "external",
    )


# ── Voice picker: list + preview Cartesia voices (server-side key) ──────────
@app.get("/voices")
async def list_voices(language: str | None = None, gender: str | None = None):
    if not CARTESIA_KEY:
        return JSONResponse({"error": "tts_unavailable"}, status_code=503)
    out, url = [], "https://api.cartesia.ai/voices/?limit=100"
    headers = {"X-API-Key": CARTESIA_KEY, "Cartesia-Version": CARTESIA_VER}
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            for _ in range(6):  # up to ~600 voices
                r = await c.get(url, headers=headers)
                if r.status_code != 200:
                    break
                j = r.json()
                for v in j.get("data", []):
                    if language and v.get("language") != language:
                        continue
                    if gender and v.get("gender") != gender:
                        continue
                    out.append({k: v.get(k) for k in ("id", "name", "description", "gender", "language", "country")})
                if not j.get("has_more") or not j.get("next_page"):
                    break
                url = f"https://api.cartesia.ai/voices/?limit=100&starting_after={j['next_page']}"
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=502)
    # languages present (for the filter UI)
    langs = sorted({v["language"] for v in out if v.get("language")})
    return {"voices": out, "languages": langs, "count": len(out)}


@app.get("/voice-preview")
async def voice_preview(voice_id: str, text: str | None = None, language: str = "en"):
    if not CARTESIA_KEY:
        return JSONResponse({"error": "tts_unavailable"}, status_code=503)
    sample = (text or "Hi, this is how I sound. How can I help you today?")[:200]
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.post(
                "https://api.cartesia.ai/tts/bytes",
                headers={"X-API-Key": CARTESIA_KEY, "Cartesia-Version": CARTESIA_VER, "Content-Type": "application/json"},
                json={
                    "model_id": "sonic-3",
                    "transcript": sample,
                    "voice": {"mode": "id", "id": voice_id},
                    "output_format": {"container": "mp3", "sample_rate": 44100, "bit_rate": 128000},
                    "language": language,
                },
            )
        if r.status_code != 200:
            return JSONResponse({"error": "preview_failed", "detail": r.text[:200]}, status_code=502)
        return Response(content=r.content, media_type="audio/mpeg")
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=502)
