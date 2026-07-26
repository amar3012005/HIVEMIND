from __future__ import annotations

import os

XAI_API_KEY = os.environ.get("XAI_API_KEY", "").strip()
XAI_REALTIME_URL = os.environ.get("XAI_REALTIME_URL", "wss://api.x.ai/v1/realtime").strip()
TARA_GROK_MODEL = os.environ.get("TARA_GROK_MODEL", "grok-voice-think-fast-1.0").strip()
CORE_EVENTS_URL = os.environ.get("HIVEMIND_CORE_EVENTS_URL", "http://core:3000/internal/v1/tara/calls").rstrip("/")
SERVICE_TOKEN = os.environ.get("TARA_GROK_SERVICE_TOKEN", "").strip()

# ── Telephony (PSTN) ─────────────────────────────────────────────────────────
# Zernio (a Telnyx reseller) carries the PSTN leg. Telnyx media streaming sends
# G.711 μ-law @8kHz, and xAI's realtime API accepts `audio/pcmu` at 8000 Hz
# natively — so the bridge is a base64 PASSTHROUGH with no transcode.
ZERNIO_API_BASE = os.environ.get("ZERNIO_API_BASE", "https://zernio.com/api/v1").rstrip("/")
ZERNIO_API_KEY = os.environ.get("ZERNIO_API_KEY", "").strip()
ZERNIO_FROM_NUMBER = os.environ.get("ZERNIO_FROM_NUMBER", "").strip()
# Public wss base Zernio dials back into (Caddy: /voice-grok/* -> :8092).
PUBLIC_WS_BASE = os.environ.get("TARA_GROK_PUBLIC_WS", "wss://core.singulancelabs.com/voice-grok").rstrip("/")
# Shared secret on side-effectful dial routes (same contract as tara-deepgram's
# x-tara-key). Empty = open, for backward-compatible rollout.
DIAL_API_KEY = os.environ.get("TARA_GROK_API_KEY", os.environ.get("TARA_DG_API_KEY", "")).strip()
# Fail-closed E.164 allowlist; "*" (or DIAL_ALLOW_ALL) opts out explicitly.
ALLOWED_NUMBERS = [n.strip() for n in os.environ.get(
    "TARA_GROK_ALLOWED_NUMBERS", os.environ.get("TELNYX_ALLOWED_NUMBERS", "")).split(",") if n.strip()]
DIAL_ALLOW_ALL = os.environ.get("DIAL_ALLOW_ALL", "").lower() in ("1", "true", "yes")
# Core-minted live-listen capability signing key (verify only).
LISTEN_SECRET = os.environ.get("TARA_DG_LISTEN_SECRET", "").strip()


def telephony_enabled() -> bool:
    """True when this adapter can place PSTN calls itself."""
    return bool(ZERNIO_API_KEY and ZERNIO_FROM_NUMBER)


def ready_error() -> str | None:
    if not XAI_API_KEY:
        return "XAI_API_KEY is not configured"
    if not SERVICE_TOKEN:
        return "TARA_GROK_SERVICE_TOKEN is not configured"
    if TARA_GROK_MODEL != "grok-voice-think-fast-1.0":
        return "TARA_GROK_MODEL must pin grok-voice-think-fast-1.0"
    if not XAI_REALTIME_URL.startswith("wss://"):
        return "XAI_REALTIME_URL must use wss"
    return None
