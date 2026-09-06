"""
tara-deepgram — TARA voice agent on Deepgram Voice Agent + Telnyx telephony.

Standalone sibling of tara-aaas. All phone routes require TARA_DG_ENABLED=true.
The LLM brain stays HIVEMIND: Deepgram's think stage calls our shim, which
proxies /api/tara/stream (recall-grounded, skill-prompted, external-hardened).
"""
from __future__ import annotations

import asyncio
import json as _json_mod
import logging
import os

import httpx
import re

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

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


def _service_auth_ok(request: Request) -> bool:
    import hmac
    expected = (os.environ.get("TARA_DG_API_KEY") or "").strip()
    supplied = (request.headers.get("x-tara-key") or "").strip()
    return bool(expected and supplied) and hmac.compare_digest(supplied, expected)


class RoomSpeakRequest(BaseModel):
    text: str
    language: str = "en"
    voice_id: str | None = None


@app.post("/room-speak")
async def room_speak(body: RoomSpeakRequest, request: Request):
    """Authenticated, bounded TARA speech for the internal Operating Room bridge."""
    from fastapi.responses import Response
    if not _service_auth_ok(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    text = body.text.strip()[:4000]
    if not text:
        return JSONResponse({"error": "text_required"}, status_code=400)
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            from .ai_gateway import request as gateway_request
            if config.SPEAK_PROVIDER == "cartesia" and config.CARTESIA_API_KEY:
                response = await gateway_request(
                    client, "POST", config.CARTESIA_TTS_URL,
                    headers={"Authorization": f"Bearer {config.CARTESIA_API_KEY}", "Cartesia-Version": "2025-04-16", "Content-Type": "application/json"},
                    json={"model_id": config.CARTESIA_MODEL, "transcript": text,
                          "voice": {"mode": "id", "id": body.voice_id or config.CARTESIA_VOICE_ID},
                          "language": (body.language or "en").split("-")[0],
                          "output_format": {"container": "mp3", "sample_rate": 44100, "bit_rate": 64000}},
                )
            elif config.DEEPGRAM_API_KEY:
                response = await gateway_request(
                    client, "POST", f"https://api.deepgram.com/v1/speak?model={body.voice_id or config.DEEPGRAM_SPEAK_MODEL}",
                    headers={"Authorization": f"Token {config.DEEPGRAM_API_KEY}", "Content-Type": "application/json"},
                    json={"text": text},
                )
            else:
                return JSONResponse({"error": "tts_unavailable"}, status_code=503)
        if response.status_code != 200:
            return JSONResponse({"error": "tts_failed"}, status_code=502)
        return Response(content=response.content, media_type="audio/mpeg")
    except Exception:  # noqa: BLE001
        log.exception("room speech failed")
        return JSONResponse({"error": "tts_failed"}, status_code=502)

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
        goal=(qp.get("goal") or "").strip()[:200],
        mode=qp.get("mode") or "external",
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


_cartesia_cache: dict = {"at": 0.0, "voices": []}


async def _cartesia_catalog() -> list[dict]:
    """Cartesia public voice catalog, mapped to the same shape as Aura's."""
    import time as _t
    if _cartesia_cache["voices"] and _t.time() - _cartesia_cache["at"] < 3600:
        return _cartesia_cache["voices"]
    try:
        out = []
        async with httpx.AsyncClient(timeout=15) as c:
            nxt = "https://api.cartesia.ai/voices/?limit=100&is_owner=false"
            for _ in range(5):  # paginate, cap ~500 voices
                r = await c.get(nxt, headers={
                    "Authorization": f"Bearer {config.CARTESIA_API_KEY}",
                    "Cartesia-Version": "2025-04-16"})
                if r.status_code != 200:
                    break
                j = r.json() or {}
                for v in j.get("data", []):
                    out.append({
                        "id": v.get("id"),
                        "name": v.get("name", ""),
                        "gender": v.get("gender", ""),
                        "language": v.get("language", "en"),
                        "description": (v.get("description") or "")[:90],
                    })
                if not j.get("has_more") or not j.get("data"):
                    break
                nxt = f"https://api.cartesia.ai/voices/?limit=100&is_owner=false&starting_after={j['data'][-1]['id']}"
        if out:
            out.sort(key=lambda v: (v["language"] != "en", v["language"], v["name"]))
            _cartesia_cache.update({"at": _t.time(), "voices": out})
            return out
    except Exception as e:  # noqa: BLE001
        log.warning("cartesia catalog fetch failed: %s", e)
    return _cartesia_cache["voices"]


@app.get("/voices")
async def list_voices(language: str | None = None, gender: str | None = None):
    # Catalog follows the ACTIVE speak provider — the picker must offer voices
    # the call will actually use (Cartesia Sonic when TARA_DG_SPEAK_PROVIDER=cartesia).
    if config.SPEAK_PROVIDER == "cartesia" and config.CARTESIA_API_KEY:
        catalog = await _cartesia_catalog() or await _aura_catalog()
    else:
        catalog = await _aura_catalog()
    out = [v for v in catalog if not language or v["language"] == language]
    if gender:
        g = gender.lower()[:3]  # 'fem'/'mas' matches feminine/masculine
        out = [v for v in out if v["gender"].startswith(g)]
    langs = sorted({v["language"] for v in catalog})
    return {"voices": out, "languages": langs, "count": len(out)}


@app.get("/voice-preview")
async def voice_preview(voice_id: str, text: str | None = None, language: str = "en"):
    from fastapi.responses import Response
    sample = (text or "Hi, this is how I sound. How can I help you today?")[:200]
    # Cartesia voice ids are UUIDs — preview through the SAME engine the call uses.
    if re.match(r"^[0-9a-f-]{36}$", voice_id, re.I) and config.CARTESIA_API_KEY:
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                from .ai_gateway import request as gateway_request
                r = await gateway_request(c, "POST", config.CARTESIA_TTS_URL,
                    headers={"Authorization": f"Bearer {config.CARTESIA_API_KEY}",
                             "Cartesia-Version": "2025-04-16",
                             "Content-Type": "application/json"},
                    json={"model_id": config.CARTESIA_MODEL, "transcript": sample,
                          "voice": {"mode": "id", "id": voice_id},
                          "language": (language or "en").split("-")[0],
                          "output_format": {"container": "mp3", "sample_rate": 44100,
                                            "bit_rate": 64000}})
            if r.status_code != 200:
                return JSONResponse({"error": "preview_failed", "detail": r.text[:200]}, status_code=502)
            return Response(content=r.content, media_type="audio/mpeg")
        except Exception as e:  # noqa: BLE001
            return JSONResponse({"error": str(e)}, status_code=502)
    if not config.DEEPGRAM_API_KEY:
        return JSONResponse({"error": "tts_unavailable"}, status_code=503)
    try:
        async with httpx.AsyncClient(timeout=20) as c:
            from .ai_gateway import request as gateway_request
            r = await gateway_request(c, "POST",
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

    def _dial_auth_ok(request: Request) -> bool:
        """Shared-secret gate on side-effectful dial/campaign routes. Enforced only
        when TARA_DG_API_KEY is set (backward-compatible rollout: deploy this first,
        set the env on both sides, then it enforces). Constant-time compare."""
        import hmac
        expected = (os.environ.get("TARA_DG_API_KEY") or "").strip()
        if not expected:
            return True
        supplied = (request.headers.get("x-tara-key") or "").strip()
        return bool(supplied) and hmac.compare_digest(supplied, expected)

    @app.post("/calls/outbound")
    async def outbound(req: telephony.DialRequest, request: Request):
        if not _dial_auth_ok(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        try:
            return await telephony.dial(req)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        except Exception as e:  # noqa: BLE001
            log.exception("dial failed")
            return JSONResponse({"error": str(e)}, status_code=502)

    @app.post("/calls/outbound/{call_leg_id}/hangup")
    async def call_hangup(call_leg_id: str, request: Request):
        if not _dial_auth_ok(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
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

    @app.websocket("/calls/listen")
    async def calls_listen(ws: WebSocket):
        """Listen-only browser tap into a live call (no barge-in). Query:
        session_id (required), key (required when TARA_DG_API_KEY set — browser
        WS can't send headers). Binary PCM16 mono 8kHz + JSON control events."""
        from . import listen as _listen
        qp = ws.query_params
        await _listen.handle_listen(ws, session_id=qp.get("session_id") or "",
                                    key=qp.get("key") or "",
                                    token=qp.get("token") or "")

    @app.post("/telnyx/webhook")
    async def telnyx_webhook(request: Request):
        event = await request.json()
        asyncio.get_event_loop().create_task(telephony.handle_webhook(event))
        return {"ok": True}

    @app.post("/zernio/webhook")
    async def zernio_webhook(request: Request):
        """Zernio call events. Fails CLOSED on a bad/missing signature.

        The HMAC covers the RAW body, so it is read before any parsing. Zernio
        sends no timestamp, so replays/duplicates are rejected by event id
        (X-Zernio-Event-Id / payload.id). Zernio needs a 2xx within 5s or it
        retries, so the handler runs in the background.
        """
        raw = await request.body()
        signature = request.headers.get("x-zernio-signature", "")
        if not telephony.verify_zernio_signature(raw, signature):
            # Diagnostic: distinguish "wrong secret" from "wrong scheme" without
            # leaking anything usable. Zernio's docs say lowercase-hex HMAC-SHA256
            # over the raw body; if the received value is base64 or a different
            # length, the scheme differs. Prefixes only.
            log.warning(
                "zernio webhook REJECTED: signature mismatch bytes=%d recv_len=%d recv=%s… %s",
                len(raw), len(signature), signature[:12] or "(none)",
                telephony.zernio_signature_debug(raw),
            )
            raise HTTPException(status_code=401, detail="invalid signature")
        try:
            event = _json_mod.loads(raw or b"{}")
        except Exception:  # noqa: BLE001
            raise HTTPException(status_code=400, detail="invalid json")
        event_id = request.headers.get("x-zernio-event-id") or str(event.get("id") or "")
        if not telephony.zernio_event_is_new(event_id):
            return {"ok": True, "duplicate": True}
        asyncio.get_event_loop().create_task(telephony.handle_zernio_webhook(event))
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
        # A per-call skill_prompt on the dial request WINS over the org's currently
        # selected persona. That is what makes "same goal + skill plan for every
        # outbound call" true irrespective of provider: the campaign pinned a skill
        # in its snapshot, and that pin must survive even if an admin later changes
        # the org default mid-campaign. Falls back to the org selection.
        skill_prompt = (meta.get("skill_prompt") or "").strip() or (
            persona.get("internal_prompt" if call_mode == "internal" else "system_prompt") or "")
        prompt = skill_prompt or _BASE_PROMPT.format(company=company, goal=call_goal or "have a helpful conversation")
        if call_goal:
            prompt += f"\n\n[CALL GOAL] {call_goal} — steer every turn toward this; never lose sight of it."
        if meta.get("contact_name"):
            prompt += f"\n[CALLER] The person you are calling is named {meta['contact_name']}."
        # ORG BRIEF — every new conversation opens already knowing who TARA works
        # for, for ANY tenant and ANY skill. Core supplies it in the dial payload
        # (built there because it is off the critical path and grok cannot reach
        # /api/profiles). Falls back to nothing rather than to profile_context,
        # which is the OPERATOR's personal profile, not a description of the org.
        org_brief = (str(meta.get("org_brief") or "").strip()
                     or str(persona.get("org_brief") or "").strip())[:600]
        if org_brief:
            prompt += (f"\n\n[ORG] Who you work for:\n{org_brief}\n"
                       "Speak from this when asked what the company does. "
                       "Never contradict it and never invent beyond it.")
        call_context = (meta.get("context") or "").strip()
        if call_context:
            prompt += (f"\n[PROSPECT CONTEXT] {call_context[:800]}\n"
                       "Ground the conversation in these facts about who you're calling — "
                       "reference them naturally, never invent others.")

        # Strategic opening: plan the first move from skill + goal, so TARA opens
        # by asking the right FIRST question (not a generic hello). Pre-seed the
        # turn-strategist's session state so it continues that plan.
        greeting_extra = ""
        plan: dict = {}
        if call_goal or call_context:
            plan = await plan_opening(persona_prompt=skill_prompt,
                                      goal=(f"{call_goal}\nProspect: {call_context[:400]}" if call_context else call_goal),
                                      company=company, language=call_lang,
                                      org_brief=org_brief)
            greeting_extra = plan.get("opening") or ""
        # Seed the strategist ALWAYS, not only when a goal was dialed. Without a
        # seeded row think_shim built its own default that had no hypotheses key at
        # all, so a goal-less call started with no steering state whatsoever.
        think_shim._session_state[session_id] = {
            # first_move is the TURN-1 DIRECTIVE — what this opening is trying
            # to find out. The old code put the whole-call `strategy` line here,
            # which then went out as voice_directive: a plan where a tactical
            # instruction belongs.
            "directive": plan.get("first_move") or "",
            "goal_state": plan.get("goal_state") or (f"Objective: {call_goal}" if call_goal else ""),
            # Prospect brief seeds the strategist's working memory so every
            # turn plans around WHO is on the line, not just the objective.
            "facts": ([f"Prospect: {call_context[:400]}"] if call_context else []),
            "tok": {"p": 0, "c": 0},
            # Seed the weighted hypothesis set from the GOAL at plan time, so
            # turn 1 already steers instead of spending the call working out
            # what to test. The set then evolves live — weights move, dead
            # branches drop, new ones appear.
            "hypotheses": [h for h in (plan.get("hypotheses") or [])
                           if isinstance(h, dict) and h.get("h")][:4],
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
    async def campaign_launch(req: campaigns.CampaignRequest, request: Request):
        if not _dial_auth_ok(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
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
    async def campaign_stop(camp_id: str, request: Request):
        if not _dial_auth_ok(request):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not campaigns.stop(camp_id):
            return JSONResponse({"error": "not_found"}, status_code=404)
        return {"ok": True}
