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
