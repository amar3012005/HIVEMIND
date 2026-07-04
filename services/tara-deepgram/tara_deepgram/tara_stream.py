"""
tara_stream — robust streaming client for HIVEMIND /api/tara/stream.

The LLM brain stays in HIVEMIND; this AaaS forwards a query and streams tokens
back. Multi-tenant: user_id/org_id sent as X-HM-* headers so memory recall is
scoped per user. Universal server-side API key (Authorization: Bearer).

NDJSON contract (proven against prod):
  {"type":"status", ...}                 -> ignored (progress)
  {"type":"text","text"|"content": "x"}  -> token
  {"type":"done", "full_response": "...", "usage": {...}, "is_final": true}
  {"type":"error","message": "..."}      -> upstream error

Yields dict events: {"type":"token","text":str} | {"type":"final","full_text":str,
"usage":dict|None} | {"type":"error","error":str}. Never raises — errors are events.
"""
from __future__ import annotations

import json
import logging
from typing import AsyncGenerator, Dict, Any, Optional

import httpx

from . import config

log = logging.getLogger("tara_aaas.stream")

_RETRYABLE = {429, 500, 502, 503, 504}

# Persistent client — keepalive pool kills the per-call TLS handshake (~1s).
_client = None


def _get_client():
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(
                connect=config.STREAM_CONNECT_TIMEOUT,
                read=config.STREAM_READ_TIMEOUT,
                write=10.0, pool=5.0,
            ),
            verify=config.VERIFY_TLS,
            limits=httpx.Limits(max_keepalive_connections=10, keepalive_expiry=300),
        )
    return _client


def _headers(user_id: Optional[str], org_id: Optional[str]) -> Dict[str, str]:
    h = {"Content-Type": "application/json"}
    if config.HIVEMIND_API_KEY:
        h["Authorization"] = f"Bearer {config.HIVEMIND_API_KEY}"
        h["X-API-Key"] = config.HIVEMIND_API_KEY
    if user_id:
        h["X-HM-User-Id"] = user_id
    if org_id:
        h["X-HM-Org-Id"] = org_id
    return h


def _parse_line(line: str) -> Optional[Dict[str, Any]]:
    line = line.rstrip("\r")
    if not line:
        return None
    try:
        data = json.loads(line)
    except json.JSONDecodeError:
        log.warning("tara_stream: bad NDJSON line: %s", line[:160])
        return None
    etype = str(data.get("type", "")).strip().lower()
    if etype == "text":
        token = data.get("text") or data.get("content") or ""
        return {"type": "token", "text": token} if token else None
    if etype == "done":
        return {
            "type": "final",
            "full_text": (data.get("full_response") or "").strip(),
            "usage": data.get("usage") or data.get("llm_usage"),
        }
    if etype == "error":
        return {"type": "error", "error": data.get("message") or "upstream error"}
    return None  # status/other -> ignore


async def stream_tara(
    *,
    query: str,
    session_id: str,
    user_id: Optional[str] = None,
    org_id: Optional[str] = None,
    language: str = "en",
    tenant_id: Optional[str] = None,
    agent_name: Optional[str] = None,
    mode: str = "external",   # 'internal' = direct recall, no clinical reasoning
    extra: Optional[Dict[str, Any]] = None,
) -> AsyncGenerator[Dict[str, Any], None]:
    """Stream tokens from HIVEMIND /api/tara/stream. Yields event dicts."""
    payload: Dict[str, Any] = {
        "query": query,
        "session_id": session_id,
        "user_id": user_id,
        "language": language,
    }
    if tenant_id:
        payload["tenant_id"] = tenant_id
    if agent_name:
        payload["agent_name"] = agent_name
    if user_id:
        payload["hivemind_user_id"] = user_id
    # Use the user's configured TARA prompts (system + clinical) from /api/tara/config.
    # configStore is keyed by (tenant_id, agent_name) + scoped by X-HM-User-Id, matching
    # what the /tara page saves (default/default).
    payload.setdefault("tenant_id", "default")
    payload.setdefault("agent_name", "default")
    payload["mode"] = mode
    # Voice path: keep replies short (cap + concise hint) for low total latency.
    payload.setdefault("max_tokens", int(config.STREAM_MAX_TOKENS))
    if extra:
        payload.update(extra)

    headers = _headers(user_id, org_id)
    client = _get_client()

    last_err = "unknown"
    for attempt in range(config.STREAM_MAX_RETRIES + 1):
        produced = False
        try:
            if True:
                async with client.stream(
                    "POST", config.HIVEMIND_TARA_STREAM_URL, json=payload, headers=headers
                ) as resp:
                    if resp.status_code != 200:
                        body = (await resp.aread()).decode("utf-8", "replace")[:300]
                        last_err = f"http_{resp.status_code}: {body}"
                        if resp.status_code in _RETRYABLE and attempt < config.STREAM_MAX_RETRIES:
                            log.warning("tara_stream retryable %s (attempt %d)", resp.status_code, attempt)
                            continue
                        yield {"type": "error", "error": last_err}
                        return
                    async for line in resp.aiter_lines():
                        evt = _parse_line(line)
                        if evt is None:
                            continue
                        produced = True
                        yield evt
                        if evt["type"] in ("final", "error"):
                            return
                    # stream ended without explicit done
                    if produced:
                        yield {"type": "final", "full_text": "", "usage": None}
                    else:
                        yield {"type": "error", "error": "empty_stream"}
                    return
        except (httpx.ConnectError, httpx.ReadTimeout, httpx.RemoteProtocolError) as e:
            last_err = f"{type(e).__name__}: {e}"
            if attempt < config.STREAM_MAX_RETRIES:
                log.warning("tara_stream transient %s (attempt %d) — retrying", last_err, attempt)
                continue
            yield {"type": "error", "error": last_err}
            return
        except Exception as e:  # noqa: BLE001 — never crash the caller
            log.exception("tara_stream unexpected error")
            yield {"type": "error", "error": f"{type(e).__name__}: {e}"}
            return
