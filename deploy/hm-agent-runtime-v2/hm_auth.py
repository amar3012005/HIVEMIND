# -*- coding: utf-8 -*-
"""hm-core identity for the Agent Service.

Replaces AgentScope's `X-User-ID` placeholder — which is **not authentication**:
any caller could set the header and impersonate any user, which is why the
service was bound to 127.0.0.1 only.

This module mirrors hm-core's own internal-auth contract so the runtime speaks
the same dialect as every other hm-core sidecar:

    core/src/security/internal-auth.js   -> getInternalApiKey() / hasInternalApiKey()
    core/src/internal/internal-fetch.js  -> buildInternalHeaders()

Two accepted credential shapes, in priority order:

1. **Internal (service-to-service).** hm-core's control plane calls this service
   with `X-API-Key: <HIVEMIND_MASTER_API_KEY>` plus the resolved principal in
   `X-HM-User-Id` / `X-HM-Org-Id`. This is exactly what `buildInternalHeaders()`
   emits, so hm-core needs no new client code. The master key is compared with
   `hmac.compare_digest` (constant time).

2. **User bearer (browser / external client).** `Authorization: Bearer <token>`
   is verified against hm-core's Core API (`POST /api/auth/verify` or the
   configured introspection endpoint). The returned canonical `userId` is the
   tenant boundary for every resource in this service.

The canonical identity is `(user_id, org_id)`. `user_id` is what AgentScope
keys every record on, so it must be hm-core's stable id — never an email or a
display name, or changing the scheme orphans existing sessions.

Configuration (all optional; absent means that path is disabled):

    HIVEMIND_MASTER_API_KEY   shared secret for the internal path
    HM_CORE_URL               base URL of hm-core's Core API, for bearer verify
    HM_CORE_VERIFY_PATH       default /api/auth/verify
    AGENTSCOPE_ALLOW_DEV_AUTH when "1", accept the legacy X-User-ID header
                              (LOCAL DEV ONLY — logs a loud warning)
"""

from __future__ import annotations

import hmac
import logging
import os
from dataclasses import dataclass
from typing import Optional

import httpx

_log = logging.getLogger("hm-agent-runtime.auth")

# hm-core's dev fallback, mirrored from core/src/security/internal-auth.js.
# It is rejected in production there, and we reject it here too unless dev auth
# is explicitly enabled.
_DEV_MASTER_KEY = "hm_master_key_99228811"

MASTER_API_KEY = os.getenv("HIVEMIND_MASTER_API_KEY", "").strip()
HM_CORE_URL = os.getenv("HM_CORE_URL", "").strip().rstrip("/")
HM_CORE_VERIFY_PATH = os.getenv("HM_CORE_VERIFY_PATH", "/api/auth/verify").strip()
ALLOW_DEV_AUTH = os.getenv("AGENTSCOPE_ALLOW_DEV_AUTH", "0") == "1"

# How long to wait on hm-core's verify endpoint. Short: this is on the request
# path of every authenticated call.
_VERIFY_TIMEOUT = float(os.getenv("HM_CORE_VERIFY_TIMEOUT", "5"))


@dataclass(frozen=True)
class Principal:
    """A resolved caller identity.

    `user_id` is the AgentScope tenant boundary. `org_id` is carried for
    logging/forwarding and for org-scoped policy decisions hm-core may add.
    """

    user_id: str
    org_id: Optional[str] = None
    scopes: tuple[str, ...] = ()
    is_internal: bool = False


class AuthError(Exception):
    """Raised when a credential is present but invalid."""


def _constant_time_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def _master_key() -> str:
    """The configured master key, or "" when unset.

    The dev fallback is only honoured when dev auth is explicitly enabled, so a
    production deployment that forgets the env var fails closed rather than
    silently accepting a well-known key.
    """
    if MASTER_API_KEY:
        return MASTER_API_KEY
    if ALLOW_DEV_AUTH:
        return _DEV_MASTER_KEY
    return ""


def is_internal_key(candidate: str) -> bool:
    """Constant-time check of a service-to-service key."""
    expected = _master_key()
    if not expected or not candidate:
        return False
    return _constant_time_eq(candidate, expected)


async def verify_bearer(token: str) -> Optional[Principal]:
    """Verify a user bearer token against hm-core.

    Returns the principal, or None when hm-core says the token is invalid.
    Raises AuthError when hm-core is unreachable — an outage must not be
    indistinguishable from a bad token, or a transient failure would silently
    downgrade to "unauthenticated" instead of failing the request.
    """
    if not HM_CORE_URL:
        return None
    url = f"{HM_CORE_URL}{HM_CORE_VERIFY_PATH}"
    try:
        async with httpx.AsyncClient(timeout=_VERIFY_TIMEOUT) as client:
            resp = await client.post(
                url,
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.HTTPError as exc:
        raise AuthError(f"hm-core unreachable at {url}: {exc}") from exc

    if resp.status_code in (401, 403):
        return None
    if resp.status_code >= 400:
        raise AuthError(f"hm-core verify returned {resp.status_code}")

    try:
        body = resp.json()
    except ValueError as exc:
        raise AuthError("hm-core verify returned non-JSON") from exc

    # Accept the shapes hm-core actually returns: either the principal at the
    # top level or nested under `user` / `principal` / `data`.
    node = body
    for key in ("user", "principal", "data"):
        if isinstance(node, dict) and isinstance(node.get(key), dict):
            node = node[key]
            break

    user_id = (
        node.get("userId")
        or node.get("user_id")
        or node.get("id")
        or node.get("sub")
    )
    if not user_id:
        return None

    org_id = node.get("orgId") or node.get("org_id")
    scopes = node.get("scopes") or ()
    if isinstance(scopes, str):
        scopes = tuple(s for s in scopes.split() if s)

    return Principal(
        user_id=str(user_id),
        org_id=str(org_id) if org_id else None,
        scopes=tuple(scopes),
        is_internal=False,
    )


async def resolve_principal(
    *,
    api_key: Optional[str],
    authorization: Optional[str],
    legacy_user_id: Optional[str],
) -> Principal:
    """Resolve a caller to a Principal, or raise AuthError.

    Order matters: the internal key is checked first because hm-core's control
    plane is the primary caller and its request also carries the resolved
    principal in headers.
    """
    # 1. Internal service-to-service (hm-core control plane).
    if api_key and is_internal_key(api_key):
        if not legacy_user_id:
            raise AuthError(
                "internal key presented without X-HM-User-Id; hm-core must "
                "propagate the resolved principal",
            )
        return Principal(
            user_id=legacy_user_id,
            org_id=None,
            scopes=("*",),
            is_internal=True,
        )

    # 2. User bearer token, verified against hm-core.
    if authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise AuthError("Authorization header must be 'Bearer <token>'")
        principal = await verify_bearer(token)
        if principal is None:
            raise AuthError("invalid or expired token")
        return principal

    # 3. Legacy X-User-ID — LOCAL DEV ONLY, and only when explicitly enabled.
    if ALLOW_DEV_AUTH and legacy_user_id:
        _log.warning(
            "DEV AUTH: accepting unauthenticated X-User-ID=%r. This is not "
            "authentication and must never be enabled in production.",
            legacy_user_id,
        )
        return Principal(user_id=legacy_user_id, scopes=("*",))

    raise AuthError("no credentials presented")


def describe() -> str:
    """One-line summary for the boot log — never prints the secret."""
    parts = []
    parts.append("internal-key=set" if _master_key() else "internal-key=UNSET")
    parts.append(f"hm-core={HM_CORE_URL or 'UNSET'}")
    parts.append("dev-auth=ON" if ALLOW_DEV_AUTH else "dev-auth=off")
    return " ".join(parts)
