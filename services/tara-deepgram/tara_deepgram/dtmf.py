"""In-band DTMF generation for PSTN calls.

Why in-band: Zernio exposes no send-DTMF endpoint (probing
`/voice/calls/{id}/dtmf` and friends returns the marketing SPA — a Next.js
catch-all, not an API), and we have no Telnyx credentials of our own because
Zernio owns that account. But we already control the outbound audio: the bridge
sends G.711 μ-law frames to the carrier. DTMF *is* audio — two superimposed sine
waves — so we can synthesise the tones ourselves and push them down the same
socket. Works on any carrier, needs zero API support, and is exactly what a
human handset does.

Output is 8 kHz μ-law, matching the media bridge, so frames drop straight into
`{"event":"media","media":{"payload": <base64>}}`.
"""
from __future__ import annotations

import base64
import math
from typing import List

SAMPLE_RATE = 8000
# Standard DTMF grid: (low Hz, high Hz) per key.
_TONES = {
    "1": (697, 1209), "2": (697, 1336), "3": (697, 1477), "A": (697, 1633),
    "4": (770, 1209), "5": (770, 1336), "6": (770, 1477), "B": (770, 1633),
    "7": (852, 1209), "8": (852, 1336), "9": (852, 1477), "C": (852, 1633),
    "*": (941, 1209), "0": (941, 1336), "#": (941, 1477), "D": (941, 1633),
}
# ITU-T Q.24 says a tone must be >=40ms and the gap >=40ms. IVRs are happier with
# a bit more, and a phone tree that misses a digit costs a whole call.
TONE_MS = 180
GAP_MS = 120
# Well under full scale: summing two sines at high amplitude clips into μ-law and
# an IVR reads a clipped tone as noise.
AMPLITUDE = 0.35


def _linear_to_ulaw(sample: int) -> int:
    """16-bit linear PCM -> 8-bit μ-law (G.711), no external deps."""
    BIAS = 0x84
    CLIP = 32635
    sign = 0x80 if sample < 0 else 0x00
    if sample < 0:
        sample = -sample
    if sample > CLIP:
        sample = CLIP
    sample += BIAS
    exponent = 7
    mask = 0x4000
    while exponent > 0 and not (sample & mask):
        exponent -= 1
        mask >>= 1
    mantissa = (sample >> (exponent + 3)) & 0x0F
    return ~(sign | (exponent << 4) | mantissa) & 0xFF


def _tone_ulaw(low_hz: int, high_hz: int, duration_ms: int) -> bytes:
    out = bytearray()
    total = int(SAMPLE_RATE * duration_ms / 1000)
    for n in range(total):
        t = n / SAMPLE_RATE
        value = AMPLITUDE * (math.sin(2 * math.pi * low_hz * t)
                             + math.sin(2 * math.pi * high_hz * t)) / 2.0
        out.append(_linear_to_ulaw(int(value * 32767)))
    return bytes(out)


def _silence_ulaw(duration_ms: int) -> bytes:
    # 0xFF is μ-law silence (not 0x00 — that is near full-scale negative).
    return b"\xff" * int(SAMPLE_RATE * duration_ms / 1000)


def digits_to_ulaw(digits: str) -> bytes:
    """Render a digit string as one μ-law buffer, tone/gap alternating.

    Unknown characters are skipped rather than raising: the model may hand us
    "press 1" or "1-2-3", and dropping a stray char beats dropping the call.
    """
    buf = bytearray()
    for ch in str(digits or "").upper():
        pair = _TONES.get(ch)
        if not pair:
            continue
        buf += _tone_ulaw(pair[0], pair[1], TONE_MS)
        buf += _silence_ulaw(GAP_MS)
    return bytes(buf)


def digits_to_media_frames(digits: str, frame_ms: int = 20) -> List[str]:
    """Base64 μ-law frames ready for `{"event":"media","media":{"payload":…}}`.

    Chunked to the carrier's usual 20 ms cadence so the tones are paced like real
    audio; blasting one huge frame can be dropped or garbled by the far end.
    """
    payload = digits_to_ulaw(digits)
    if not payload:
        return []
    size = int(SAMPLE_RATE * frame_ms / 1000)
    return [base64.b64encode(payload[i:i + size]).decode()
            for i in range(0, len(payload), size)]
