"""Cloudflare AI Gateway transport for TARA HTTP inference.

Realtime WebSockets and provider control/catalog APIs remain direct because
AI Gateway's provider endpoints proxy inference HTTP, not those protocols.
"""
from __future__ import annotations

import os
from typing import Any, Mapping
from urllib.parse import urlsplit

import httpx


def _enabled() -> bool:
    return os.getenv("CLOUDFLARE_AI_GATEWAY_ENABLED", "").lower() == "true" and all(
        os.getenv(name, "").strip() for name in (
            "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AI_GATEWAY_ID", "CLOUDFLARE_AI_GATEWAY_TOKEN"
        )
    )


def _provider(url: str) -> str | None:
    return {
        "openrouter.ai": "openrouter", "api.groq.com": "groq",
        "api.deepgram.com": "deepgram", "api.cartesia.ai": "cartesia",
        "api.openai.com": "openai", "api.mistral.ai": "mistral",
        "api.cohere.com": "cohere", "api.cohere.ai": "cohere", "api.anthropic.com": "anthropic",
        "api.together.xyz": "together-ai",
    }.get((urlsplit(url).hostname or "").lower())


def websocket_route(url: str, headers: Mapping[str, str] | None = None) -> tuple[str, dict[str, str]]:
    """Route Deepgram's realtime agent socket through its native Gateway path."""
    parsed = urlsplit(url)
    if (parsed.hostname or "").lower() != "agent.deepgram.com" or not _enabled():
        return url, dict(headers or {})
    base = os.getenv("CLOUDFLARE_AI_GATEWAY_BASE_URL", "https://gateway.ai.cloudflare.com").rstrip("/")
    routed = f"{base.replace('https://', 'wss://')}/v1/{os.environ['CLOUDFLARE_ACCOUNT_ID']}/{os.environ['CLOUDFLARE_AI_GATEWAY_ID']}/deepgram{parsed.path}"
    if parsed.query:
        routed += f"?{parsed.query}"
    alias = os.getenv("CLOUDFLARE_AI_GATEWAY_DEEPGRAM_BYOK_ALIAS", "").strip()
    out = dict(headers or {})
    if alias:
        out = {key: value for key, value in out.items() if key.lower() != "authorization"}
        out["cf-aig-byok-alias"] = alias
    out["cf-aig-authorization"] = f"Bearer {os.environ['CLOUDFLARE_AI_GATEWAY_TOKEN'].strip()}"
    return routed, out


def route(url: str, headers: Mapping[str, str] | None = None) -> tuple[str, dict[str, str]]:
    name = _provider(url)
    if not _enabled() or not name:
        return url, dict(headers or {})
    alias = os.getenv(f"CLOUDFLARE_AI_GATEWAY_{name.upper()}_BYOK_ALIAS", "").strip()
    parsed = urlsplit(url)
    path = parsed.path
    if name == "openrouter" and path.startswith("/api/v1/"):
        path = path[len("/api/v1"):]
    base = os.getenv("CLOUDFLARE_AI_GATEWAY_BASE_URL", "https://gateway.ai.cloudflare.com").rstrip("/")
    routed = f"{base}/v1/{os.environ['CLOUDFLARE_ACCOUNT_ID']}/{os.environ['CLOUDFLARE_AI_GATEWAY_ID']}/{name}{path}"
    if parsed.query:
        routed += f"?{parsed.query}"
    source = dict(headers or {})
    if alias:
        source = {k: v for k, v in source.items() if k.lower() != "authorization"}
    source.update({
        "cf-aig-authorization": f"Bearer {os.environ['CLOUDFLARE_AI_GATEWAY_TOKEN'].strip()}",
        "cf-aig-skip-cache": "true",
    })
    if alias:
        source["cf-aig-byok-alias"] = alias
    return routed, source


async def request(client: httpx.AsyncClient, method: str, url: str, *, headers: Mapping[str, str] | None = None, **kwargs: Any) -> httpx.Response:
    routed, source = route(url, headers)
    return await client.request(method, routed, headers=source, **kwargs)
