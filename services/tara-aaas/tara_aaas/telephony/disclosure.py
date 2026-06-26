"""
EU AI Act Art. 50 — mandatory AI disclosure spoken at the open of every
AI-initiated call. Transport-agnostic and dependency-free so it can be unit
tested in isolation (no STT/TTS imports) and reused by any call path.
"""
from __future__ import annotations

# Spoken disclosure per language. Each MUST state the caller is an AI.
_DISCLOSURE = {
    "de": "Guten Tag! Ich bin TARA, ein KI-Assistent. Dieses Gespräch wird von einer künstlichen Intelligenz geführt.",
    "en": "Hello! I'm TARA, an AI assistant. This call is handled by artificial intelligence.",
}

_DEFAULT_LANG = "en"


def ai_disclosure(language: str) -> str:
    """Return the AI-disclosure line for `language` (2-letter prefix), EN fallback."""
    key = (language or "")[:2].lower()
    return _DISCLOSURE.get(key, _DISCLOSURE[_DEFAULT_LANG])
