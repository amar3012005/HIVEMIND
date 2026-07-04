"""
OpenAI-Chat-Completions-compatible shim over HIVEMIND /api/tara/stream.

Deepgram Voice Agent's `think.endpoint` points here. Each turn Deepgram POSTs the
conversation in OpenAI format; we take the latest user utterance, run it through
stream_tara (recall-grounded, skill-prompted, external-mode hardened) and stream
the answer back as SSE chunks — so the voice agent's brain IS HIVEMIND.

Per-call identity (session/user/org/language/mode) is carried in the endpoint URL
query string, set when we build the Deepgram Settings for that call.
"""
from __future__ import annotations

import json
import logging
import secrets
import time
from typing import Any, AsyncGenerator, Dict, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import config
from .tara_stream import stream_tara

log = logging.getLogger("tara_dg.think")

router = APIRouter()


def _authorized(request: Request) -> bool:
    if not config.THINK_SHIM_SECRET:
        return False  # unset secret = shim closed (safe default)
    auth = request.headers.get("authorization", "")
    token = auth.removeprefix("Bearer ").strip()
    return secrets.compare_digest(token, config.THINK_SHIM_SECRET)


def _last_user_message(messages: list[dict]) -> str:
    for m in reversed(messages or []):
        if m.get("role") == "user":
            c = m.get("content")
            if isinstance(c, list):  # OpenAI content-parts form
                return " ".join(p.get("text", "") for p in c if isinstance(p, dict))
            return str(c or "")
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
    query = _last_user_message(body.get("messages", []))
    if not query.strip():
        return JSONResponse({"error": "no user message"}, status_code=400)

    session_id = qp.get("session_id") or "dg-session"
    user_id = qp.get("user_id") or None
    org_id = qp.get("org_id") or None
    language = qp.get("language") or "en"
    mode = qp.get("mode") or "external"
    model = body.get("model") or "hivemind-tara"
    chunk_id = f"chatcmpl-{secrets.token_hex(8)}"

    async def sse() -> AsyncGenerator[str, None]:
        yield _chunk(chunk_id, model, {"role": "assistant"})
        produced = False
        async for evt in stream_tara(
            query=query, session_id=session_id, user_id=user_id,
            org_id=org_id, language=language, mode=mode,
        ):
            if evt["type"] == "token" and evt["text"]:
                produced = True
                yield _chunk(chunk_id, model, {"content": evt["text"]})
            elif evt["type"] == "error":
                log.error("think shim upstream error session=%s: %s", session_id, evt["error"])
                if not produced:
                    yield _chunk(chunk_id, model, {"content": "I'm sorry, I couldn't reach my knowledge base just now."})
                break
        yield _chunk(chunk_id, model, {}, finish="stop")
        yield "data: [DONE]\n\n"

    return StreamingResponse(sse(), media_type="text/event-stream")
