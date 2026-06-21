"""
μ-law G.711 @ 8 kHz  ↔  PCM s16le @ 16 kHz  codec bridge.

Uses stdlib audioop (Python 3.11) — no new dependencies.
One AudioBridge per call; it carries ratecv state across chunks
so there are no filter-reset artifacts at chunk boundaries.

Telnyx frame contract:
  Receives  20 ms μ-law @ 8 kHz = 160 bytes (mono)
  Expects   20 ms μ-law @ 8 kHz = 160 bytes back

Internal pipeline contract:
  STT  (GroqWhisperSession.process_audio_chunk): PCM s16le @ 16 kHz
  TTS  (CartesiaManager default):                PCM s16le @ 16 kHz
"""
from __future__ import annotations
import audioop

_PHONE_RATE    = 8_000
_INTERNAL_RATE = 16_000


class AudioBridge:
    """Stateful per-call codec/resample bridge. NOT thread-safe (one call = one task)."""

    __slots__ = ("_up_state", "_dn_state")

    def __init__(self) -> None:
        self._up_state = None   # ratecv state: 8 kHz → 16 kHz
        self._dn_state = None   # ratecv state: 16 kHz → 8 kHz

    def phone_to_pcm16(self, ulaw_bytes: bytes) -> bytes:
        """Telnyx μ-law 8 kHz → PCM s16le 16 kHz for STT."""
        pcm_8k = audioop.ulaw2lin(ulaw_bytes, 2)
        pcm_16k, self._up_state = audioop.ratecv(
            pcm_8k, 2, 1, _PHONE_RATE, _INTERNAL_RATE, self._up_state
        )
        return pcm_16k

    def pcm16_to_phone(self, pcm_16k: bytes) -> bytes:
        """PCM s16le 16 kHz → Telnyx μ-law 8 kHz for playback."""
        pcm_8k, self._dn_state = audioop.ratecv(
            pcm_16k, 2, 1, _INTERNAL_RATE, _PHONE_RATE, self._dn_state
        )
        return audioop.lin2ulaw(pcm_8k, 2)
