# -*- coding: utf-8 -*-
"""Cloudflare AI Gateway transport for hm-agent-runtime-v2.

Routes AgentScope model calls through the SAME Cloudflare AI Gateway that
hm-core already uses, so the runtime shares one egress path, one set of
provider credentials, and one observability/caching surface.

Configuration comes from the environment (verified live against the running
``hivemind-core`` container):

    CLOUDFLARE_AI_GATEWAY_ENABLED=true
    CLOUDFLARE_ACCOUNT_ID=<account>
    CLOUDFLARE_AI_GATEWAY_ID=hivemind-prod
    CLOUDFLARE_AI_GATEWAY_TOKEN=<gateway token>
    CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS=first-bundb
    CLOUDFLARE_AI_GATEWAY_BASE_URL=https://gateway.ai.cloudflare.com


Verified request shape (this is the part that is easy to get wrong)
-------------------------------------------------------------------
Through ``.../openrouter/chat/completions``:

    cf-aig-authorization: Bearer <CLOUDFLARE_AI_GATEWAY_TOKEN>
    cf-aig-byok-alias:    <ALIAS>
    cf-aig-skip-cache:    true

and **no ``Authorization`` header at all**. The BYOK alias selects the provider
key stored in the gateway; anything that looks like a real provider credential
in ``Authorization`` makes the gateway reject the call.

Live results (both HTTP 200, model served correctly):

    no Authorization                    -> 200 OK
    with ``Authorization: Bearer sk-…`` -> 401 'Missing Authentication header'
    without cf-aig-authorization        -> 401 AiGatewayError 2009 Unauthorized
    unknown alias                       -> 400 AiGatewayError 2040
                                           "Provider 'openrouter' has no BYOK
                                            credential named 'default'."

That last error is the important one: it proves the route REQUIRES a BYOK alias
and will not fall back to a client-supplied key. Passing the real OpenRouter key
(option E in testing) still failed with 2040.

Why the SDK needs a shim
------------------------
The OpenAI SDK always sends ``Authorization: Bearer <api_key>``, which is exactly
what the gateway rejects. A request event hook on the shared ``httpx.AsyncClient``
removes it just before the request goes on the wire — verified working in-container:

    auth before: Bearer sk-placeholder | auth after: None -> HTTP 200


Security note
-------------
The gateway token is read from the environment and never persisted. Credentials
created through the API carry a schema-required ``api_key`` that is **never
transmitted** (see ``CloudflareGatewayOpenAICredential``).
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, AsyncGenerator

import httpx

# The Cloudflare "provider route" name for OpenRouter. All model ids are sent as
# OpenRouter ids ("deepseek/deepseek-v4-flash").
OPENROUTER_ROUTE = "openrouter"

CONNECT_TIMEOUT_S = float(os.getenv("AGENTSCOPE_GATEWAY_CONNECT_TIMEOUT_S", "10"))
READ_IDLE_TIMEOUT_S = float(os.getenv("AGENTSCOPE_GATEWAY_READ_IDLE_TIMEOUT_S", "45"))
WRITE_TIMEOUT_S = float(os.getenv("AGENTSCOPE_GATEWAY_WRITE_TIMEOUT_S", "30"))
MODEL_CALL_DEADLINE_S = float(os.getenv("AGENTSCOPE_MODEL_CALL_DEADLINE_S", "180"))
DEFAULT_TIMEOUT_S = MODEL_CALL_DEADLINE_S


async def deadline_stream(
    stream: AsyncGenerator[Any, None],
    deadline_s: float,
    model: str,
) -> AsyncGenerator[Any, None]:
    loop = asyncio.get_running_loop()
    expires_at = loop.time() + deadline_s
    aiter = stream.__aiter__()
    try:
        while True:
            remaining = expires_at - loop.time()
            if remaining <= 0:
                raise TimeoutError(
                    f"model stream exceeded wall-clock deadline of {deadline_s:g}s "
                    f"(model={model})",
                )
            try:
                chunk = await asyncio.wait_for(aiter.__anext__(), timeout=remaining)
            except StopAsyncIteration:
                break
            except asyncio.TimeoutError as exc:
                raise TimeoutError(
                    f"model stream exceeded wall-clock deadline of {deadline_s:g}s "
                    f"(model={model})",
                ) from exc
            yield chunk
    finally:
        aclose = getattr(stream, "aclose", None)
        if callable(aclose):
            await aclose()


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _debug_enabled() -> bool:
    """Whether to log rejected request/response bodies (see build_gateway_http_client)."""
    return _env("AGENTSCOPE_GATEWAY_DEBUG", "").lower() in ("1", "true", "yes")


def enabled() -> bool:
    """Whether gateway routing is configured.

    Mirrors the hm-core contract: fail-closed. Anything missing means direct
    routing, which is the explicit rollback, rather than a half- configured
    gateway that fails at request time.
    """
    if _env("CLOUDFLARE_AI_GATEWAY_ENABLED", "").lower() != "true":
        return False
    return all(
        _env(name)
        for name in (
            "CLOUDFLARE_ACCOUNT_ID",
            "CLOUDFLARE_AI_GATEWAY_ID",
            "CLOUDFLARE_AI_GATEWAY_TOKEN",
            "CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS",
        )
    )


def describe() -> str:
    """One-line description for startup logging. Never includes secrets."""
    if not enabled():
        return "disabled (direct provider routing)"
    return (
        f"enabled account={_env('CLOUDFLARE_ACCOUNT_ID')[:6]}… "
        f"gateway={_env('CLOUDFLARE_AI_GATEWAY_ID')} "
        f"route={OPENROUTER_ROUTE} alias={_env('CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS')}"
    )


def gateway_base_url() -> str:
    """The OpenAI-compatible base URL for the gateway's OpenRouter route.

    This is what an ``OpenAICredential.base_url`` must be set to, so the SDK
    appends ``/chat/completions`` correctly.
    """
    if not enabled():
        raise RuntimeError(
            "Cloudflare AI Gateway is not configured; call enabled() first.",
        )
    base = _env("CLOUDFLARE_AI_GATEWAY_BASE_URL", "https://gateway.ai.cloudflare.com")
    base = base.rstrip("/")
    return (
        f"{base}/v1/{_env('CLOUDFLARE_ACCOUNT_ID')}"
        f"/{_env('CLOUDFLARE_AI_GATEWAY_ID')}/{OPENROUTER_ROUTE}"
    )


def gateway_default_headers() -> dict[str, str]:
    """Headers the gateway requires on every routed request."""
    if not enabled():
        return {}
    return {
        # Authenticates the caller to the GATEWAY (not to the provider).
        "cf-aig-authorization": f"Bearer {_env('CLOUDFLARE_AI_GATEWAY_TOKEN')}",
        # Selects the provider credential stored in the gateway. Required —
        # without it the gateway answers 400 "no BYOK credential named 'default'".
        "cf-aig-byok-alias": _env("CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS"),
        # Match hm-core: never let a cached completion masquerade as a live one.
        "cf-aig-skip-cache": "true",
    }


def build_gateway_http_client() -> httpx.AsyncClient:
    """An ``httpx.AsyncClient`` that strips ``Authorization`` before sending.

    The OpenAI SDK always attaches an ``Authorization`` header, but the gateway's
    BYOK-alias route rejects any such header. Removing it in a request hook is the
    one place that can intercept after the SDK has built the request and before it
    reaches the network.

    ``follow_redirects`` / limits mirror the OpenAI SDK's own default client so
    swapping it in does not change unrelated behaviour.

    Set ``AGENTSCOPE_GATEWAY_DEBUG=1`` to log the request payload and the upstream
    error body whenever the gateway answers 4xx/5xx. Without this, a rejected
    request surfaces only as AgentScope's generic
    "The request to the model was rejected as invalid." — which says nothing about
    *which* field the provider disliked.
    """

    async def _strip_authorization(request: httpx.Request) -> None:
        # The alias supplies the provider key gateway-side. Presenting one here
        # is what produced 401 'Missing Authentication header' in testing.
        request.headers.pop("authorization", None)

    async def _log_rejection(response: httpx.Response) -> None:
        if not _debug_enabled() or response.status_code < 400:
            return
        request = response.request
        body = ""
        try:
            body = request.content.decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - diagnostics must never raise
            body = "<unreadable>"
        try:
            upstream = response.read().decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            upstream = "<unreadable>"
        # Truncated deliberately: enough to identify the offending field without
        # dumping a whole conversation into the logs.
        print(
            f"[gateway] {response.status_code} {request.method} {request.url}\n"
            f"[gateway] request  : {body[:1500]}\n"
            f"[gateway] upstream : {upstream[:1500]}",
            flush=True,
        )

    return httpx.AsyncClient(
        event_hooks={
            "request": [_strip_authorization],
            "response": [_log_rejection],
        },
        timeout=httpx.Timeout(
            connect=CONNECT_TIMEOUT_S,
            read=READ_IDLE_TIMEOUT_S,
            write=WRITE_TIMEOUT_S,
            pool=CONNECT_TIMEOUT_S,
        ),
        follow_redirects=True,
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
    )


def gateway_client_kwargs() -> dict[str, Any]:
    """``client_kwargs`` for ``OpenAIChatModel``.

    Deliberately does NOT include ``base_url``: ``OpenAIChatModel.__init__``
    forwards ``credential.base_url`` positionally and then splats
    ``client_kwargs``, so supplying it twice raises a duplicate-keyword error.
    The base URL belongs on the credential (see ``install_on_credential``).
    """
    if not enabled():
        return {}
    return {
        "default_headers": gateway_default_headers(),
        "http_client": build_gateway_http_client(),
        # Retry 429/5xx with the SDK's exponential backoff + jitter. Provider
        # rate limits must not silently drop an agent turn.
        "max_retries": 3,
    }


def install_on_credential(credential: Any) -> Any:
    """Point an ``OpenAICredential`` at the gateway's OpenRouter route.

    Mutates ``base_url`` in place and returns the credential. When the gateway is
    disabled this is a no-op, so the caller can use it unconditionally.
    """
    if enabled():
        credential.base_url = gateway_base_url()
    return credential