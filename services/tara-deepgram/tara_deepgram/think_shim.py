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
import secrets
import time
from typing import Any, AsyncGenerator, Dict, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import config
from .core_client import get_persona
from .tara_stream import stream_tara
from .turn_router import answer_direct, route

log = logging.getLogger("tara_dg.think")

router = APIRouter()

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
                session_id, {"directive": "", "goal_state": "", "facts": []})
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
            if use_router:
                # Persona reaches the strategist too: the skill's opening lines
                # define who TARA is + what the call is FOR — cached, so only the
                # first turn pays the fetch before routing.
                persona = await get_persona(user_id, org_id)
                prompt_key = "internal_prompt" if mode == "internal" else "system_prompt"
                persona_hint = str(persona.get(prompt_key) or "")[:280].replace("\n", " ")
                decision = await route(
                    persona_name=persona_hint or "TARA",
                    goal="",
                    messages=messages, prev_directive=prev_directive,
                    goal_state=state.get("goal_state", ""),
                    facts=state.get("facts", []),
                )
                state["directive"] = decision.get("directive") or prev_directive
                state["goal_state"] = decision.get("goal_state") or state.get("goal_state", "")
                for f in decision.get("new_facts", []):
                    if f and f not in state["facts"]:
                        state["facts"].append(f)
                state["facts"] = state["facts"][-12:]  # cap the brief

            if use_router and decision["action"] == "direct":
                path = "direct"
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
                async for text in answer_direct(
                    persona_prompt=persona.get(prompt_key) or "",
                    language=language,
                    directive=decision.get("directive", ""),
                    messages=messages,
                    history_turns=decision.get("history_turns", 3),
                    goal_state=state.get("goal_state", ""),
                    facts=state.get("facts", []),
                ):
                    if first_ms is None:
                        first_ms = round((time.monotonic() - t0) * 1000)
                    produced = True
                    yield _chunk(chunk_id, model, {"content": text})
            else:
                path = "recall" if use_router else "core-legacy"

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
        log.info("turn session=%s path=%s router_ms=%s first_token_ms=%s total_ms=%s",
                 session_id, path, decision.get("router_ms", "-") if use_router else "-",
                 first_ms, total_ms)
        yield _chunk(chunk_id, model, {}, finish="stop")
        yield "data: [DONE]\n\n"

    return StreamingResponse(sse(), media_type="text/event-stream")
