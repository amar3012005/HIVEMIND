"""
tara-deepgram — TARA voice agent on Deepgram Voice Agent + Telnyx telephony.

Standalone sibling of tara-aaas. All phone routes require TARA_DG_ENABLED=true.
The LLM brain stays HIVEMIND: Deepgram's think stage calls our shim, which
proxies /api/tara/stream (recall-grounded, skill-prompted, external-hardened).
"""
from __future__ import annotations

import asyncio
import logging

import httpx

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
        "telephony_provider": config.TELEPHONY_PROVIDER,
        "deepgram_key_set": bool(config.DEEPGRAM_API_KEY),
        "telnyx_key_set": bool(config.TELNYX_API_KEY),
        "twilio_key_set": bool(config.TWILIO_ACCOUNT_SID and config.TWILIO_AUTH_TOKEN),
        "from_number_set": bool(config.TWILIO_FROM_NUMBER if config.TELEPHONY_PROVIDER == "twilio" else config.TELNYX_FROM_NUMBER),
        "hivemind_key_set": bool(config.HIVEMIND_API_KEY),
        "allowlist_size": len(config.ALLOWED_NUMBERS),
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
        goal=(qp.get("goal") or "").strip()[:200],
    )


# Aura-2 voices — full catalog fetched live from Deepgram /v1/models (90 voices,
# 7 languages as of 2026-07) with a 1h cache; static fallback if the API is down.
_AURA_FALLBACK = [
    {"id": "aura-2-thalia-en",  "name": "Thalia",  "gender": "feminine",  "language": "en", "description": "Clear, confident, energetic (US)"},
    {"id": "aura-2-apollo-en",  "name": "Apollo",  "gender": "masculine", "language": "en", "description": "Confident, casual (US)"},
    {"id": "aura-2-eos-de",     "name": "Eos",     "gender": "feminine",  "language": "de", "description": "Warm, natural (DE)"},
    {"id": "aura-2-celeste-es", "name": "Celeste", "gender": "feminine",  "language": "es", "description": "Clear, energetic (ES)"},
    {"id": "aura-2-agathe-fr",  "name": "Agathe",  "gender": "feminine",  "language": "fr", "description": "Warm, natural (FR)"},
    {"id": "aura-2-lotte-nl",   "name": "Lotte",   "gender": "feminine",  "language": "nl", "description": "Natural (NL)"},
]
_voice_cache: dict = {"at": 0.0, "voices": []}


async def _aura_catalog() -> list[dict]:
    import time as _t
    if _voice_cache["voices"] and _t.time() - _voice_cache["at"] < 3600:
        return _voice_cache["voices"]
    if not config.DEEPGRAM_API_KEY:
        return _AURA_FALLBACK
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get("https://api.deepgram.com/v1/models",
                            headers={"Authorization": f"Token {config.DEEPGRAM_API_KEY}"})
        models = (r.json() or {}).get("tts", []) if r.status_code == 200 else []
        out = []
        for m in models:
            cn = m.get("canonical_name", "")
            if not cn.startswith("aura-2-"):
                continue
            meta = m.get("metadata") or {}
            tags = meta.get("tags") or []
            gender = "feminine" if "feminine" in tags else ("masculine" if "masculine" in tags else "")
            lang = (m.get("languages") or ["en"])[0].split("-")[0]
            traits = [t for t in tags if t not in ("feminine", "masculine")][:3]
            out.append({
                "id": cn,
                "name": meta.get("display_name") or m.get("name", "").title(),
                "gender": gender, "language": lang,
                "description": f"{', '.join(traits).title()} ({meta.get('accent', '')})".strip(),
                "sample": meta.get("sample"),
            })
        if out:
            out.sort(key=lambda v: (v["language"] != "en", v["language"], v["name"]))
            _voice_cache.update({"at": _t.time(), "voices": out})
            return out
    except Exception as e:  # noqa: BLE001
        log.warning("aura catalog fetch failed: %s", e)
    return _voice_cache["voices"] or _AURA_FALLBACK


@app.get("/voices")
async def list_voices(language: str | None = None, gender: str | None = None):
    catalog = await _aura_catalog()
    out = [v for v in catalog if not language or v["language"] == language]
    if gender:
        g = gender.lower()[:3]  # 'fem'/'mas' matches feminine/masculine
        out = [v for v in out if v["gender"].startswith(g)]
    langs = sorted({v["language"] for v in catalog})
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
        import json as _json
        session_id = ws.query_params.get("session_id") or None
        seed_start = None
        # Twilio delivers session params via the `start` event's customParameters
        # (not URL query). Peek frames until `start`, extract them, then proceed.
        if config.TELEPHONY_PROVIDER == "twilio" or not session_id:
            await ws.accept()
            for _ in range(5):  # connected → start within a few frames
                try:
                    raw = await ws.receive_text()
                except Exception:  # noqa: BLE001
                    break
                msg = _json.loads(raw)
                if msg.get("event") == "start":
                    seed_start = msg
                    cp = (msg.get("start", {}) or {}).get("customParameters", {}) or {}
                    session_id = cp.get("session_id") or session_id or "dg-session"
                    break
            session_id = session_id or "dg-session"
            meta = telephony.find_by_session(session_id) or {}
            accepted = True
        else:
            meta = telephony.find_by_session(session_id) or {}
            accepted = False

        # Persona = the operator's SELECTED skill (external system prompt), not a
        # generic base — so the phone agent stays strictly in character. Goal from
        # the dial is appended so every reply drives toward it.
        from .core_client import get_persona
        from .browser_voice import _resolve_voice
        from .turn_router import plan_opening
        from . import think_shim
        call_mode = meta.get("mode") or "external"
        call_goal = meta.get("goal") or ""
        # Company name = the real org name from the dial (NEVER the org UUID, which
        # Deepgram would spell out as gibberish like "B-A-9-2-3...").
        company = meta.get("company") or "our team"
        call_lang = (meta.get("language") or "en").split("-")[0]
        persona = await get_persona(meta.get("user_id"), meta.get("org_id"))
        skill_prompt = persona.get("internal_prompt" if call_mode == "internal" else "system_prompt") or ""
        prompt = skill_prompt or _BASE_PROMPT.format(company=company, goal=call_goal or "have a helpful conversation")
        if call_goal:
            prompt += f"\n\n[CALL GOAL] {call_goal} — steer every turn toward this; never lose sight of it."
        if meta.get("contact_name"):
            prompt += f"\n[CALLER] The person you are calling is named {meta['contact_name']}."

        # Strategic opening: plan the first move from skill + goal, so TARA opens
        # by asking the right FIRST question (not a generic hello). Pre-seed the
        # turn-strategist's session state so it continues that plan.
        greeting_extra = ""
        if call_goal:
            plan = await plan_opening(persona_prompt=skill_prompt, goal=call_goal,
                                      company=company, language=call_lang)
            greeting_extra = plan.get("opening") or ""
            think_shim._session_state[session_id] = {
                "directive": plan.get("strategy") or "",
                "goal_state": plan.get("goal_state") or f"Objective: {call_goal}",
                "facts": [],
            }
        await run_bridge(
            ws, session_id=session_id,
            user_id=meta.get("user_id"), org_id=meta.get("org_id"),
            language=call_lang,
            voice_id=_resolve_voice(meta.get("voice_id"), call_lang),
            prompt=prompt, company=company,
            goal=call_goal, mode=call_mode, greeting_extra=greeting_extra,
            already_accepted=accepted, seed_start=seed_start,
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
