from __future__ import annotations

import os

XAI_API_KEY = os.environ.get("XAI_API_KEY", "").strip()
XAI_REALTIME_URL = os.environ.get("XAI_REALTIME_URL", "wss://api.x.ai/v1/realtime").strip()
TARA_GROK_MODEL = os.environ.get("TARA_GROK_MODEL", "grok-voice-think-fast-1.0").strip()
CORE_EVENTS_URL = os.environ.get("HIVEMIND_CORE_EVENTS_URL", "http://core:3000/internal/v1/tara/calls").rstrip("/")
SERVICE_TOKEN = os.environ.get("TARA_GROK_SERVICE_TOKEN", "").strip()

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
