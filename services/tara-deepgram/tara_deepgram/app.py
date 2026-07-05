"""
tara-deepgram — TARA voice agent on Deepgram Voice Agent + Telnyx telephony.

Standalone sibling of tara-aaas. All phone routes require TARA_DG_ENABLED=true.
The LLM brain stays HIVEMIND: Deepgram's think stage calls our shim, which
proxies /api/tara/stream (recall-grounded, skill-prompted, external-hardened).
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import FastAPI, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import campaigns, config, telephony
from .agent_session import run_bridge
from .browser_voice import handle_browser_voice
from .think_shim import router as think_router

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("tara_dg.app")

app = FastAPI(title="TARA Deepgram Voice", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https://([a-z0-9-]+\.)*(singulancelabs\.com|davinciai\.eu)",
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(think_router)

_BASE_PROMPT = (
    "You are TARA, a professional, warm phone agent for {company}. "
    "Goal of this call: {goal}. "
    "Keep replies to 1-2 short spoken sentences. Never invent facts — use "
    "search_memory when unsure. If the person objects to being called, call "
    "mark_do_not_call then end_call immediately. Log interested callers with "
    "log_lead. Use schedule_callback when asked to call later. Always end the "
    "call with end_call after saying goodbye."
)


@app.get("/health")
async def health():
    return {
        "ok": True,
        "service": "tara-deepgram",
        "outbound_enabled": config.TARA_DG_ENABLED,
        "deepgram_key_set": bool(config.DEEPGRAM_API_KEY),
        "telnyx_key_set": bool(config.TELNYX_API_KEY),
        "hivemind_key_set": bool(config.HIVEMIND_API_KEY),
        "allowlist_size": len(config.TELNYX_ALLOWED_NUMBERS),
        "max_parallel": config.CAMPAIGN_MAX_PARALLEL,
    }


# Browser mic widget (Talk to TARA) — same protocol as tara-aaas /voice.
@app.websocket("/voice")
async def browser_voice(ws: WebSocket):
    qp = ws.query_params
    await handle_browser_voice(
        ws,
        session_id=qp.get("session_id") or "dg-web-session",
        user_id=qp.get("user_id") or None,
        org_id=qp.get("org_id") or None,
        language=(qp.get("language") or "en").split("-")[0],
        voice_id=qp.get("voice_id") or None,
        mode=qp.get("mode") or "external",
    )


# Aura-2 voices for the picker (mirrors tara-aaas /voices shape).
_AURA_VOICES = [
    {"id": "aura-2-thalia-en",  "name": "Thalia",  "gender": "feminine",  "language": "en", "description": "Clear, confident, energetic (US)"},
    {"id": "aura-2-andromeda-en", "name": "Andromeda", "gender": "feminine", "language": "en", "description": "Casual, expressive (US)"},
    {"id": "aura-2-apollo-en",  "name": "Apollo",  "gender": "masculine", "language": "en", "description": "Confident, casual (US)"},
    {"id": "aura-2-arcas-en",   "name": "Arcas",   "gender": "masculine", "language": "en", "description": "Natural, smooth (US)"},
    {"id": "aura-2-draco-en",   "name": "Draco",   "gender": "masculine", "language": "en", "description": "Warm, trustworthy (GB)"},
    {"id": "aura-2-eos-de",     "name": "Eos",     "gender": "feminine",  "language": "de", "description": "Warm, natural (DE)"},
    {"id": "aura-2-celeste-es", "name": "Celeste", "gender": "feminine",  "language": "es", "description": "Clear, energetic (ES)"},
    {"id": "aura-2-agathe-fr",  "name": "Agathe",  "gender": "feminine",  "language": "fr", "description": "Warm, natural (FR)"},
    {"id": "aura-2-lotte-nl",   "name": "Lotte",   "gender": "feminine",  "language": "nl", "description": "Natural (NL)"},
]


@app.get("/voices")
async def list_voices(language: str | None = None, gender: str | None = None):
    out = [v for v in _AURA_VOICES if not language or v["language"] == language]
    if gender:
        g = gender.lower()[:3]  # 'fem'/'mas' matches feminine/masculine
        out = [v for v in out if v["gender"].startswith(g)]
    langs = sorted({v["language"] for v in _AURA_VOICES})
    return {"voices": out, "languages": langs, "count": len(out)}


@app.get("/voice-preview")
async def voice_preview(voice_id: str, text: str | None = None, language: str = "en"):
    if not config.DEEPGRAM_API_KEY:
        return JSONResponse({"error": "tts_unavailable"}, status_code=503)
    import httpx
    from fastapi.responses import Response
    sample = (text or "Hi, this is how I sound. How can I help you today?")[:200]
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.post(
                f"https://api.deepgram.com/v1/speak?model={voice_id}",
                headers={"Authorization": f"Token {config.DEEPGRAM_API_KEY}",
                         "Content-Type": "application/json"},
                json={"text": sample},
            )
        if r.status_code != 200:
            return JSONResponse({"error": "preview_failed", "detail": r.text[:200]}, status_code=502)
        return Response(content=r.content, media_type="audio/mpeg")
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=502)


if config.TARA_DG_ENABLED:

    @app.post("/calls/outbound")
    async def outbound(req: telephony.DialRequest):
        try:
            return await telephony.dial(req)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        except Exception as e:  # noqa: BLE001
            log.exception("dial failed")
            return JSONResponse({"error": str(e)}, status_code=502)

    @app.post("/calls/outbound/{call_leg_id}/hangup")
    async def call_hangup(call_leg_id: str):
        try:
            await telephony.hangup(call_leg_id)
            return {"ok": True}
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=404)
        except Exception as e:  # noqa: BLE001
            log.exception("hangup failed")
            return JSONResponse({"error": str(e)}, status_code=502)

    @app.get("/calls/outbound/{call_leg_id}/status")
    async def call_status(call_leg_id: str):
        meta = telephony.pending_calls.get(call_leg_id)
        if not meta:
            return JSONResponse({"error": "not_found"}, status_code=404)
        return {"call_leg_id": call_leg_id,
                "session_id": meta["session_id"], "status": meta["status"]}

    @app.post("/telnyx/webhook")
    async def telnyx_webhook(request: Request):
        event = await request.json()
        asyncio.get_event_loop().create_task(telephony.handle_webhook(event))
        return {"ok": True}

    @app.websocket("/telnyx/stream")
    async def telnyx_stream(ws: WebSocket):
        session_id = ws.query_params.get("session_id") or "dg-session"
        meta = telephony.find_by_session(session_id) or {}
        prompt = _BASE_PROMPT.format(
            company=meta.get("org_id") or "the company",
            goal=meta.get("goal") or "have a helpful conversation",
        )
        if meta.get("contact_name"):
            prompt += f" The person you are calling is named {meta['contact_name']}."
        await run_bridge(
            ws, session_id=session_id,
            user_id=meta.get("user_id"), org_id=meta.get("org_id"),
            language=meta.get("language") or "en",
            voice_id=meta.get("voice_id"),
            prompt=prompt, company=meta.get("org_id") or "the company",
        )

    # ── Campaigns ────────────────────────────────────────────────────────────
    @app.post("/campaigns")
    async def campaign_launch(req: campaigns.CampaignRequest):
        try:
            return campaigns.launch(req)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)

    @app.get("/campaigns")
    async def campaign_list():
        return {"campaigns": campaigns.list_campaigns()}

    @app.get("/campaigns/{camp_id}")
    async def campaign_status(camp_id: str):
        camp = campaigns.status(camp_id)
        if not camp:
            return JSONResponse({"error": "not_found"}, status_code=404)
        return camp

    @app.post("/campaigns/{camp_id}/stop")
    async def campaign_stop(camp_id: str):
        if not campaigns.stop(camp_id):
            return JSONResponse({"error": "not_found"}, status_code=404)
        return {"ok": True}
