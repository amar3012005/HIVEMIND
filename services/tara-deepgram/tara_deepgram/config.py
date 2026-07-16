"""tara-deepgram configuration — all from env, no per-tenant hardcoding.

Standalone sibling of tara-aaas: same HIVEMIND brain (/api/tara/stream), but the
voice loop (STT + turn-taking + TTS + barge-in) is Deepgram Voice Agent, and the
phone leg is Telnyx media streaming bridged straight through in mulaw@8kHz.
"""
import os

# ── HIVEMIND brain ───────────────────────────────────────────────────────────
HIVEMIND_TARA_STREAM_URL = os.getenv(
    "HIVEMIND_TARA_STREAM_URL",
    "https://core.singulancelabs.com/api/tara/stream",
)
HIVEMIND_API_KEY = os.getenv("HIVEMIND_API_KEY", "").strip()
HIVEMIND_CORE_URL = os.getenv(
    "HIVEMIND_CORE_URL", HIVEMIND_TARA_STREAM_URL.rsplit("/api/", 1)[0]
)

STREAM_CONNECT_TIMEOUT = float(os.getenv("TARA_STREAM_CONNECT_TIMEOUT", "5"))
STREAM_READ_TIMEOUT = float(os.getenv("TARA_STREAM_READ_TIMEOUT", "45"))
STREAM_MAX_RETRIES = int(os.getenv("TARA_STREAM_MAX_RETRIES", "1"))
STREAM_MAX_TOKENS = int(os.getenv("TARA_STREAM_MAX_TOKENS", "180"))
VERIFY_TLS = os.getenv("HIVEMIND_TARA_VERIFY_TLS", "true").lower() == "true"

# ── Deepgram Voice Agent ─────────────────────────────────────────────────────
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY", "")
DEEPGRAM_AGENT_URL = os.getenv(
    "DEEPGRAM_AGENT_URL", "wss://agent.deepgram.com/v1/agent/converse"
)
# Deepgram Aura-2 default voice; per-call override via voice_id.
DEEPGRAM_SPEAK_MODEL = os.getenv("DEEPGRAM_SPEAK_MODEL", "aura-2-thalia-en")
DEEPGRAM_LISTEN_MODEL = os.getenv("DEEPGRAM_LISTEN_MODEL", "nova-3")

# ── Speak provider: "deepgram" (Aura-2, default) | "cartesia" (Sonic, BYO key).
# Cartesia rides the SAME Deepgram agent as a BYO speak endpoint (tts/bytes) —
# STT/turn-taking/barge-in unchanged; also drops the agent to the BYO-TTS tier.
SPEAK_PROVIDER = os.getenv("TARA_DG_SPEAK_PROVIDER", "deepgram").lower()
CARTESIA_API_KEY = os.getenv("CARTESIA_API_KEY", "").strip()
CARTESIA_MODEL = os.getenv("TARA_DG_CARTESIA_MODEL", "sonic-3")
# Default voice: "Skylar - Friendly Guide" (US female, support/care register).
CARTESIA_VOICE_ID = os.getenv("TARA_DG_CARTESIA_VOICE", "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4")
CARTESIA_TTS_URL = os.getenv("TARA_DG_CARTESIA_URL", "https://api.cartesia.ai/tts/bytes")

# Public base URLs of THIS service (Deepgram + Telnyx call back into us).
PUBLIC_HTTP_BASE = os.getenv("TARA_DG_PUBLIC_HTTP", "https://core.singulancelabs.com/voice2")
PUBLIC_WS_BASE   = os.getenv("TARA_DG_PUBLIC_WS",   "wss://core.singulancelabs.com/voice2")

# Shared secret protecting the think-shim + internal endpoints (Deepgram sends it
# as an Authorization header we configure in Settings.think.endpoint.headers).
THINK_SHIM_SECRET = os.getenv("TARA_DG_SHIM_SECRET", "")

# ── Telephony ────────────────────────────────────────────────────────────────
TARA_DG_ENABLED   = os.getenv("TARA_DG_ENABLED", "false").lower() == "true"
# Provider switch: "telnyx" (default) | "twilio". Both bridge to the same
# Deepgram media loop (mulaw@8k); only dial + stream-start differ.
TELEPHONY_PROVIDER = os.getenv("TELEPHONY_PROVIDER", "telnyx").lower()

TELNYX_API_KEY     = os.getenv("TELNYX_API_KEY", "")
TELNYX_APP_ID      = os.getenv("TELNYX_APP_ID", "")
TELNYX_FROM_NUMBER = os.getenv("TELNYX_FROM_NUMBER", "")

TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN  = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_FROM_NUMBER = os.getenv("TWILIO_FROM_NUMBER", "")

# Unified comma-separated E.164 allowlist. Empty = ALL outbound dialing blocked
# (safe default). TELNYX_ALLOWED_NUMBERS kept as an alias for back-compat.
ALLOWED_NUMBERS = [
    n.strip() for n in (
        os.getenv("TELNYX_ALLOWED_NUMBERS", "") + "," + os.getenv("TWILIO_ALLOWED_NUMBERS", "")
    ).split(",") if n.strip()
]
TELNYX_ALLOWED_NUMBERS = ALLOWED_NUMBERS  # alias

# ── Voice-v2 turn strategy (router replaces per-turn recall + clinical loop) ─
VOICE_STRATEGY = os.getenv("TARA_DG_STRATEGY", "router")  # "router" | "legacy"
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_BASE_URL = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
ROUTER_MODEL = os.getenv("TARA_DG_ROUTER_MODEL", "openai/gpt-oss-20b")
# Direct-answer model. gpt-oss-120b on Cerebras = ~3x faster full completion
# than llama-70b (the TTS-blocking metric). Provider pin + low reasoning effort.
DIRECT_MODEL = os.getenv("TARA_DG_DIRECT_MODEL", "openai/gpt-oss-120b")
# Comma-sep OpenRouter provider order for the direct model (empty = latency sort).
DIRECT_PROVIDER = [p.strip() for p in os.getenv("TARA_DG_DIRECT_PROVIDER", "Cerebras").split(",") if p.strip()]
# gpt-oss reasoning effort for voice: low = fewer reasoning tokens = faster.
DIRECT_REASONING_EFFORT = os.getenv("TARA_DG_DIRECT_REASONING", "low")
# Model core uses for spoken recall answers (voice_model override). Same fast
# Cerebras gpt-oss-120b; empty = leave core's default.
RECALL_MODEL = os.getenv("TARA_DG_RECALL_MODEL", "openai/gpt-oss-120b")
# Speak a filler if the grounded recall answer hasn't started within this many ms.
FILLER_AFTER_MS = int(os.getenv("TARA_DG_FILLER_AFTER_MS", "400"))
# Fillers off by default now — Cerebras + warm recall make them unnecessary and
# they read as repetitive. Set TARA_DG_FILLER_ENABLED=true to re-enable.
FILLER_ENABLED = os.getenv("TARA_DG_FILLER_ENABLED", "false").lower() == "true"

# ── Campaign engine ──────────────────────────────────────────────────────────
# Deepgram PAYG cap = 15 concurrent agent sessions; stay well under.
CAMPAIGN_MAX_PARALLEL = int(os.getenv("TARA_DG_CAMPAIGN_MAX_PARALLEL", "3"))
CAMPAIGN_DAILY_CAP    = int(os.getenv("TARA_DG_CAMPAIGN_DAILY_CAP", "50"))
# JSONL event log directory (function calls, transcripts, dispositions).
LOG_DIR = os.getenv("TARA_DG_LOG_DIR", "/data/call-logs")
