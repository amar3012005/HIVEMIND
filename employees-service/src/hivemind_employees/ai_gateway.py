"""Cloudflare AI Gateway transport for server-owned Employees inference.

Gateway mode is fail-closed: disabling the feature is the explicit direct
provider rollback. Provider credentials are never forwarded to Cloudflare.
"""
from __future__ import annotations

import os
from typing import Any, Mapping
from urllib.parse import urlsplit

import httpx


def enabled() -> bool:
    return os.getenv("CLOUDFLARE_AI_GATEWAY_ENABLED", "").lower() == "true" and all(
        os.getenv(name, "").strip() for name in (
            "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AI_GATEWAY_ID", "CLOUDFLARE_AI_GATEWAY_TOKEN"
        )
    )


def provider(url: str) -> str | None:
    host = urlsplit(url).hostname or ""
    return {
        "openrouter.ai": "openrouter",
        "api.groq.com": "groq",
        "api.cerebras.ai": "cerebras",
        "api.openai.com": "openai",
        "api.mistral.ai": "mistral",
        "api.cohere.com": "cohere",
        "api.cohere.ai": "cohere",
        "api.anthropic.com": "anthropic",
        "api.together.xyz": "together-ai",
        "api.deepgram.com": "deepgram",
        "api.cartesia.ai": "cartesia",
    }.get(host.lower())


def _alias(name: str) -> str:
    return os.getenv(f"CLOUDFLARE_AI_GATEWAY_{name.upper()}_BYOK_ALIAS", "").strip()


def provider_url(url: str) -> str:
    name = provider(url)
    if not enabled() or not name:
        return url
    parts = urlsplit(url)
    path = parts.path
    if name == "openrouter" and path.startswith("/api/v1/"):
        path = path[len("/api/v1"):]
    base = os.getenv("CLOUDFLARE_AI_GATEWAY_BASE_URL", "https://gateway.ai.cloudflare.com").rstrip("/")
    return f"{base}/v1/{os.environ['CLOUDFLARE_ACCOUNT_ID']}/{os.environ['CLOUDFLARE_AI_GATEWAY_ID']}/{name}{path}" + (f"?{parts.query}" if parts.query else "")


def gateway_headers(url: str, source: Mapping[str, str] | None = None) -> dict[str, str]:
    name = provider(url)
    if not enabled() or not name:
        return dict(source or {})
    alias = _alias(name)
    out = dict(source or {})
    if alias:
        out = {k: v for k, v in out.items() if k.lower() != "authorization"}
    out.update({
        "cf-aig-authorization": f"Bearer {os.environ['CLOUDFLARE_AI_GATEWAY_TOKEN'].strip()}",
        "cf-aig-skip-cache": "true",
    })
    if alias:
        out["cf-aig-byok-alias"] = alias
    return out


async def post(client: httpx.AsyncClient, url: str, *, headers: Mapping[str, str] | None = None,
               json: Mapping[str, Any] | None = None, **kwargs: Any) -> httpx.Response:
    return await client.post(provider_url(url), headers=gateway_headers(url, headers), json=json, **kwargs)


def sdk_target(url: str, api_key: str) -> tuple[str, str, dict[str, str]]:
    """Return a Gateway base URL and headers for OpenAI-compatible SDKs.

    SDKs synthesize their own Authorization header, so this path deliberately
    uses Cloudflare provider passthrough instead of BYOK; otherwise the SDK's
    unavoidable placeholder credential could override the stored key.
    """
    name = provider(url)
    if not enabled() or not name:
        return url, api_key, {}
    routed = provider_url(url.rstrip("/") + "/chat/completions")
    base = routed.rsplit("/chat/completions", 1)[0]
    headers = {
        "cf-aig-authorization": f"Bearer {os.environ['CLOUDFLARE_AI_GATEWAY_TOKEN'].strip()}",
        "cf-aig-skip-cache": "true",
    }
    alias = _alias(name or "")
    if alias:
        # OpenAI-compatible SDKs always synthesize an Authorization header.
        # An empty explicit override prevents a stale provider key from taking
        # precedence over the server-owned Gateway BYOK alias.
        headers["Authorization"] = ""
        headers["cf-aig-byok-alias"] = alias
    return base, api_key, headers
