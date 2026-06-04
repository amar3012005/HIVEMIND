"""TARA AaaS configuration — all from env, no per-tenant hardcoding."""
import os

# tara_stream (HIVEMIND /api/tara/stream) — the LLM brain.
HIVEMIND_TARA_STREAM_URL = os.getenv(
    "HIVEMIND_TARA_STREAM_URL",
    "https://core.hivemind.davinciai.eu:8050/api/tara/stream",
)
# Universal server-side key (master or scoped). Never client-supplied.
HIVEMIND_API_KEY = os.getenv("HIVEMIND_API_KEY", "").strip()

# HIVEMIND control-plane (session whoami auth — used later by WS layer).
HIVEMIND_CONTROL_PLANE_URL = os.getenv(
    "HIVEMIND_CONTROL_PLANE_URL", "https://api.hivemind.davinciai.eu:8040"
)

# HIVEMIND core base (for call-history ingest: /api/tara/calls/*).
HIVEMIND_CORE_URL = os.getenv(
    "HIVEMIND_CORE_URL", HIVEMIND_TARA_STREAM_URL.rsplit("/api/", 1)[0]
)

# Timeouts (seconds).
STREAM_CONNECT_TIMEOUT = float(os.getenv("TARA_STREAM_CONNECT_TIMEOUT", "5"))
STREAM_READ_TIMEOUT = float(os.getenv("TARA_STREAM_READ_TIMEOUT", "30"))
STREAM_MAX_RETRIES = int(os.getenv("TARA_STREAM_MAX_RETRIES", "1"))
# Voice replies short → lower total latency + less audio.
STREAM_MAX_TOKENS = int(os.getenv("TARA_STREAM_MAX_TOKENS", "180"))

VERIFY_TLS = os.getenv("HIVEMIND_TARA_VERIFY_TLS", "true").lower() == "true"
