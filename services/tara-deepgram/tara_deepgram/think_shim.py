"""
OpenAI-Chat-Completions-compatible shim over HIVEMIND — the Deepgram Voice
Agent's `think` endpoint.

Voice-v2 strategy (TARA_DG_STRATEGY=router, default):
  Each turn, ONE tiny fast-model call (turn_router.route) decides:
    direct → answer locally with the selected skill's persona + the last N
             turns Deepgram already sent (no recall, no memory in prompt)
    recall → HIVEMIND /api/tara/stream with skip_clinical=true and the
             router's one-line directive as voice_directive (memory only
             when needed; the accumulating clinical loop never runs)
  The router's directive IS the strategic clinical layer — persona-aware,
  refreshed every turn, ~150 tokens instead of an unbounded analysis chain.

Legacy strategy (TARA_DG_STRATEGY=legacy): every turn straight to core.

Per-call identity rides the endpoint URL query string (set in Settings).
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import time
from typing import Any, AsyncGenerator, Dict, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import config
from .core_client import core_post, get_persona
from .tara_stream import stream_tara
from .turn_router import answer_direct, route

log = logging.getLogger("tara_dg.think")

router = APIRouter()

# Rotating fillers spoken while recall runs (perceived-latency mask). A list per
# language; the shim rotates per turn and skips back-to-back fillers so the
# caller never hears the same phrase twice in a row.
_FILLERS = {
    "en": ["Let me check that for you.", "Good question — one moment.",
           "Let me pull that up.", "Sure, just a second.", "Hmm, let me see."],
    "de": ["Einen Moment, ich schaue das kurz nach.", "Gute Frage — Sekunde.",
           "Moment, das habe ich gleich.", "Lassen Sie mich kurz nachsehen."],
    "fr": ["Un instant, je vérifie ça.", "Bonne question — une seconde.",
           "Laissez-moi regarder ça.", "Un petit moment."],
    "es": ["Un momento, déjame revisar eso.", "Buena pregunta — un segundo.",
           "Déjame verlo.", "Un momentito."],
    "nl": ["Momentje, ik zoek dat even op.", "Goede vraag — momentje.",
           "Even kijken.", "Seconde."],
    "it": ["Un attimo, controllo subito.", "Bella domanda — un secondo.",
           "Vediamo un attimo.", "Momento."],
}


def _next_filler(state: dict, language: str) -> Optional[str]:
    """Rotate fillers; skip entirely if the previous turn also used one."""
    if state.get("last_was_filler"):
        state["last_was_filler"] = False
        return None
    pool = _FILLERS.get(language, _FILLERS["en"])
    i = state.get("filler_i", 0)
    state["filler_i"] = (i + 1) % len(pool)
    state["last_was_filler"] = True
    return pool[i % len(pool)]

# Cheap local heuristic: is this turn likely to need recall (→ speak a filler
# immediately, before the router LLM, so Aura-2 starts talking at ~300ms)?
_TRIVIAL_RE = re.compile(
    r"^(hi+|hey+|hello|hi there|thanks|thank you|ok(ay)?|yes|yeah|yep|no|nope|sure|bye|"
    r"good|great|cool|nice|got it|mm+|uh+|right|exactly|perfect)[\s.!,'-]*$", re.I)
_QWORD_RE = re.compile(
    r"\b(what|which|who|where|when|why|how|price|cost|do you|does|did|can you|could you|"
    r"tell me|is there|are there|explain|list|show|details?|about)\b", re.I)


def _likely_recall(q: str) -> bool:
    q = (q or "").strip()
    if not q or _TRIVIAL_RE.match(q):
        return False
    if "?" in q or _QWORD_RE.search(q):
        return True
    return len(q.split()) >= 6


# Per-session strategy state (last directive). Single replica; tiny.
_session_state: dict[str, dict] = {}


def _authorized(request: Request) -> bool:
    if not config.THINK_SHIM_SECRET:
        return False  # unset secret = shim closed (safe default)
    auth = request.headers.get("authorization", "")
    token = auth.removeprefix("Bearer ").strip()
    return secrets.compare_digest(token, config.THINK_SHIM_SECRET)


def _content_str(c: Any) -> str:
    if isinstance(c, list):  # OpenAI content-parts form
        return " ".join(p.get("text", "") for p in c if isinstance(p, dict))
    return str(c or "")


def _last_user_message(messages: list[dict]) -> str:
    for m in reversed(messages or []):
        if m.get("role") == "user":
            return _content_str(m.get("content"))
    return ""


def _chunk(chunk_id: str, model: str, delta: Dict[str, Any], finish: Optional[str] = None) -> str:
    return "data: " + json.dumps({
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }) + "\n\n"


@router.post("/think/v1/chat/completions")
async def think(request: Request):
    if not _authorized(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    body = await request.json()
    qp = request.query_params
    messages = body.get("messages", [])
    query = _last_user_message(messages)
    if not query.strip():
        return JSONResponse({"error": "no user message"}, status_code=400)

    session_id = qp.get("session_id") or "dg-session"
    user_id = qp.get("user_id") or None
    org_id = qp.get("org_id") or None
    language = qp.get("language") or "en"
    mode = qp.get("mode") or "external"
    call_goal = qp.get("goal") or ""  # goal set at dial time (FE Outbound)
    model = body.get("model") or "hivemind-tara"
    chunk_id = f"chatcmpl-{secrets.token_hex(8)}"
    t0 = time.monotonic()

    use_router = config.VOICE_STRATEGY == "router" and bool(config.OPENROUTER_API_KEY)

    async def sse() -> AsyncGenerator[str, None]:
        yield _chunk(chunk_id, model, {"role": "assistant"})
        produced = False
        first_ms = None
        path = "core-legacy"
        decision = {"action": "recall", "history_turns": 2, "directive": ""}
        try:
            persona = {}
            if len(_session_state) > 500:  # bound memory across long uptimes
                _session_state.clear()
            state = _session_state.setdefault(
                session_id, {"directive": "", "goal_state": "", "facts": [], "tok": {"p": 0, "c": 0}})
            state.setdefault("tok", {"p": 0, "c": 0})
            turn_tok0 = (state["tok"]["p"], state["tok"]["c"])  # baseline for this turn's delta
            # Seed goal_state from the dial-time goal so the strategist is oriented
            # from turn 1 (it evolves it thereafter).
            if call_goal and not state.get("goal_state"):
                state["goal_state"] = f"Objective: {call_goal}"
            prev_directive = state.get("directive", "")
            # The brief = the call's working memory: goal progress + user-revealed
            # facts, injected into BOTH paths so nothing established gets forgotten.
            brief_bits = []
            if state.get("goal_state"):
                brief_bits.append(f"Goal: {state['goal_state']}")
            if state.get("facts"):
                brief_bits.append("Known: " + "; ".join(state["facts"][-8:]))
            brief = " | ".join(brief_bits)
            # Speculative parallel start: core recall stream launches immediately
            # (it is the latency-critical path) carrying the PREVIOUS turn's
            # directive (clinical semantics: insight steers the next turn). The
            # router races it: "direct" → core stream cancelled before the LLM
            # matters; "recall" → the router added zero latency.
            extra: Dict[str, Any] = {}
            if use_router:
                # CLINICAL_LIVE: let core's clinical hypothesis engine own the
                # directive — do NOT skip clinical and do NOT send the router's
                # one-line voice_directive (which would override clinical). The
                # fast spoken-answer model/provider below still apply.
                if not config.CLINICAL_LIVE:
                    extra["skip_clinical"] = True
                    vd = " ".join(x for x in (prev_directive, brief) if x)
                    if vd:
                        extra["voice_directive"] = vd[:300]
                # Speed the spoken recall answer: force the fast model/provider.
                if config.RECALL_MODEL:
                    extra["voice_model"] = config.RECALL_MODEL
                if config.DIRECT_PROVIDER:
                    extra["voice_provider"] = ",".join(config.DIRECT_PROVIDER)
                if config.DIRECT_REASONING_EFFORT:
                    extra["voice_reasoning_effort"] = config.DIRECT_REASONING_EFFORT
            core_gen = stream_tara(
                query=query, session_id=session_id, user_id=user_id,
                org_id=org_id, language=language, mode=mode, extra=extra or None,
            )
            core_first = asyncio.ensure_future(core_gen.__anext__())

            # FILLER-FIRST (pre-router): if the turn clearly needs recall, speak a
            # filler NOW — before the router LLM blocks — so Aura-2 (which starts
            # TTS at the first sentence) talks at ~300ms instead of ~1s. Router
            # still runs in parallel for goal/facts/directive.
            filler_emitted = False
            forced_recall = False
            # CLINICAL_LIVE: every turn must reach core so recall + the clinical
            # hypothesis engine run (clinical is one turn behind by design). This
            # skips the router's "direct" short-circuit that would cancel core.
            if use_router and config.CLINICAL_LIVE:
                forced_recall = True
            if use_router and _likely_recall(query):
                forced_recall = True
                filler = _next_filler(state, language) if config.FILLER_ENABLED else None
                if filler:
                    first_ms = round((time.monotonic() - t0) * 1000)
                    produced = True
                    filler_emitted = True
                    path = "recall+filler"
                    yield _chunk(chunk_id, model, {"content": filler + " "})

            if use_router:
                # Persona reaches the strategist too: the skill's opening lines
                # define who TARA is + what the call is FOR — cached, so only the
                # first turn pays the fetch before routing.
                persona = await get_persona(user_id, org_id)
                prompt_key = "internal_prompt" if mode == "internal" else "system_prompt"
                persona_hint = str(persona.get(prompt_key) or "")[:280].replace("\n", " ")
                decision = await route(
                    persona_name=persona_hint or "TARA",
                    goal=call_goal,
                    messages=messages, prev_directive=prev_directive,
                    goal_state=state.get("goal_state", ""),
                    facts=state.get("facts", []),
                    phase=state.get("phase", "discover"),
                    confidence=int(state.get("confidence", 50)),
                )
                state["directive"] = decision.get("directive") or prev_directive
                state["goal_state"] = decision.get("goal_state") or state.get("goal_state", "")
                state["phase"] = decision.get("phase", state.get("phase", "discover"))
                state["confidence"] = decision.get("confidence", state.get("confidence", 50))
                for f in decision.get("new_facts", []):
                    if f and f not in state["facts"]:
                        state["facts"].append(f)
                state["facts"] = state["facts"][-12:]  # cap the brief

            if use_router and decision["action"] == "direct" and not forced_recall:
                path = "direct"
                state["last_was_filler"] = False  # direct turn = no filler spoken
                core_first.cancel()
                try:
                    await core_first  # let the cancellation land before closing
                except (asyncio.CancelledError, StopAsyncIteration, Exception):  # noqa: BLE001
                    pass
                try:
                    await core_gen.aclose()
                except Exception:  # noqa: BLE001
                    pass
                prompt_key = "internal_prompt" if mode == "internal" else "system_prompt"
                _u: Dict[str, Any] = {}
                async for text in answer_direct(
                    persona_prompt=persona.get(prompt_key) or "",
                    language=language,
                    directive=decision.get("directive", ""),
                    messages=messages,
                    history_turns=decision.get("history_turns", 3),
                    goal_state=state.get("goal_state", ""),
                    facts=state.get("facts", []),
                    usage_out=_u,
                ):
                    if first_ms is None:
                        first_ms = round((time.monotonic() - t0) * 1000)
                    produced = True
                    yield _chunk(chunk_id, model, {"content": text})
                state["tok"]["p"] += int(_u.get("prompt_tokens", 0) or 0)
                state["tok"]["c"] += int(_u.get("completion_tokens", 0) or 0)
            else:
                path = "recall" if use_router else "core-legacy"

                # Fallback filler: heuristic missed but recall is slow anyway —
                # emit a filler if the answer hasn't begun within the threshold.
                if use_router and not filler_emitted and config.FILLER_ENABLED:
                    await asyncio.wait({core_first}, timeout=config.FILLER_AFTER_MS / 1000.0)
                    if not core_first.done():
                        filler = _next_filler(state, language)
                        if filler:
                            first_ms = round((time.monotonic() - t0) * 1000)
                            produced = True
                            path = "recall+filler"
                            yield _chunk(chunk_id, model, {"content": filler + " "})

                async def _events():
                    try:
                        yield await core_first
                    except StopAsyncIteration:
                        return
                    async for e in core_gen:
                        yield e

                async for evt in _events():
                    if evt["type"] == "token" and evt["text"]:
                        if first_ms is None:
                            first_ms = round((time.monotonic() - t0) * 1000)
                        produced = True
                        yield _chunk(chunk_id, model, {"content": evt["text"]})
                    elif evt["type"] == "final":
                        u = evt.get("usage") or {}
                        state["tok"]["p"] += int(u.get("prompt_tokens", 0) or 0)
                        state["tok"]["c"] += int(u.get("completion_tokens", 0) or 0)
                    elif evt["type"] == "error":
                        log.error("think upstream error session=%s: %s", session_id, evt["error"])
                        break
        except Exception as e:  # noqa: BLE001
            log.exception("think turn failed session=%s", session_id)
            if not produced:
                yield _chunk(chunk_id, model, {"content": "I'm sorry, I hit a snag — could you say that again?"})
        if not produced:
            yield _chunk(chunk_id, model, {"content": "I'm sorry, I couldn't reach my knowledge base just now."})
        total_ms = round((time.monotonic() - t0) * 1000)
        # Per-turn token usage → core (decoupled from the bridge; keeps Usage live).
        try:
            dp = state["tok"]["p"] - turn_tok0[0]
            dc = state["tok"]["c"] - turn_tok0[1]
            if (dp or dc) and session_id and not session_id.startswith(("tok-", "dg-", "warm-")):
                asyncio.create_task(core_post("/api/tara/calls/token-usage", {
                    "session_id": session_id, "prompt_tokens": dp, "completion_tokens": dc,
                }, user_id, org_id))
        except Exception:  # noqa: BLE001
            pass
        log.info("turn session=%s path=%s router_ms=%s first_token_ms=%s total_ms=%s tok=%s/%s",
                 session_id, path, decision.get("router_ms", "-") if use_router else "-",
                 first_ms, total_ms, state["tok"]["p"], state["tok"]["c"])
        yield _chunk(chunk_id, model, {}, finish="stop")
        yield "data: [DONE]\n\n"

    return StreamingResponse(sse(), media_type="text/event-stream")
