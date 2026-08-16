"""Cloudflare AI Gateway transport for TARA HTTP inference."""
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


def route(url: str, headers: Mapping[str, str] | None = None) -> tuple[str, dict[str, str]]:
    host = (urlsplit(url).hostname or "").lower()
    name = {"api.groq.com": "groq", "openrouter.ai": "openrouter", "api.cartesia.ai": "cartesia"}.get(host)
    if not _enabled() or not name:
        return url, dict(headers or {})
    parsed = urlsplit(url)
    path = parsed.path
    if name == "openrouter" and path.startswith("/api/v1/"):
        path = path[len("/api/v1"):]
    base = os.getenv("CLOUDFLARE_AI_GATEWAY_BASE_URL", "https://gateway.ai.cloudflare.com").rstrip("/")
    routed = f"{base}/v1/{os.environ['CLOUDFLARE_ACCOUNT_ID']}/{os.environ['CLOUDFLARE_AI_GATEWAY_ID']}/{name}{path}"
    if parsed.query:
        routed += f"?{parsed.query}"
    alias = os.getenv(f"CLOUDFLARE_AI_GATEWAY_{name.upper()}_BYOK_ALIAS", "").strip()
    out = dict(headers or {})
    if alias:
        out = {key: value for key, value in out.items() if key.lower() != "authorization"}
    out["cf-aig-authorization"] = f"Bearer {os.environ['CLOUDFLARE_AI_GATEWAY_TOKEN'].strip()}"
    out["cf-aig-skip-cache"] = "true"
    if alias:
        out["cf-aig-byok-alias"] = alias
    return routed, out


async def request(client: httpx.AsyncClient, method: str, url: str, *, headers: Mapping[str, str] | None = None, **kwargs: Any) -> httpx.Response:
    routed, routed_headers = route(url, headers)
    return await client.request(method, routed, headers=routed_headers, **kwargs)


def cartesia_websocket_route(url: str, headers: Mapping[str, str] | None = None) -> tuple[str, dict[str, str]]:
    """Use Cloudflare's documented Cartesia realtime WebSocket endpoint."""
    parsed = urlsplit(url)
    if (parsed.hostname or "").lower() != "api.cartesia.ai" or not _enabled():
        return url, dict(headers or {})
    base = os.getenv("CLOUDFLARE_AI_GATEWAY_BASE_URL", "https://gateway.ai.cloudflare.com").rstrip("/")
    routed = f"{base.replace('https://', 'wss://')}/v1/{os.environ['CLOUDFLARE_ACCOUNT_ID']}/{os.environ['CLOUDFLARE_AI_GATEWAY_ID']}/cartesia"
    if parsed.query:
        routed += f"?{parsed.query}"
    alias = os.getenv("CLOUDFLARE_AI_GATEWAY_CARTESIA_BYOK_ALIAS", "").strip()
    out = dict(headers or {})
    if alias:
        out = {key: value for key, value in out.items() if key.lower() != "authorization"}
        out["cf-aig-byok-alias"] = alias
    out["cf-aig-authorization"] = f"Bearer {os.environ['CLOUDFLARE_AI_GATEWAY_TOKEN'].strip()}"
    return routed, out
