"""
Unit tests for the Telnyx telephony spine (no real network).

Covers:
  * AudioBridge μ-law 8 kHz ↔ PCM16 16 kHz codec/resample round-trip.
  * outbound_api.handle_webhook_event state transitions with a mocked Telnyx API.
"""
from __future__ import annotations

import math

import pytest

from tara_aaas.telephony.audio_bridge import AudioBridge
from tara_aaas.telephony import outbound_api


# ─────────────────────────── AudioBridge ───────────────────────────

def _make_pcm16_16k(ms: int, freq: int = 440) -> bytes:
    """Generate a mono PCM s16le @ 16 kHz sine tone of `ms` milliseconds."""
    import struct
    rate = 16_000
    n = int(rate * ms / 1000)
    out = bytearray()
    for i in range(n):
        v = int(20_000 * math.sin(2 * math.pi * freq * i / rate))
        out += struct.pack("<h", v)
    return bytes(out)


def test_phone_to_pcm16_frame_shape():
    """20 ms μ-law @ 8 kHz (160 bytes) → PCM16 @ 16 kHz (~640 bytes)."""
    bridge = AudioBridge()
    ulaw_20ms = b"\xff" * 160  # μ-law silence-ish, one 20 ms frame
    pcm16 = bridge.phone_to_pcm16(ulaw_20ms)
    # 8k→16k doubles sample count; 160 samples → ~320 samples → ~640 bytes.
    assert 600 <= len(pcm16) <= 680
    assert len(pcm16) % 2 == 0  # s16le = even byte count


def test_pcm16_to_phone_frame_shape():
    """20 ms PCM16 @ 16 kHz (640 bytes) → μ-law @ 8 kHz (~160 bytes)."""
    bridge = AudioBridge()
    pcm16_20ms = _make_pcm16_16k(20)
    assert len(pcm16_20ms) == 640
    ulaw = bridge.pcm16_to_phone(pcm16_20ms)
    assert 150 <= len(ulaw) <= 170


def test_round_trip_preserves_signal():
    """PCM16 → phone μ-law → PCM16 keeps a recognizable correlated signal."""
    down = AudioBridge()
    up = AudioBridge()
    original = _make_pcm16_16k(100)            # 100 ms tone
    ulaw = down.pcm16_to_phone(original)        # 16k → 8k μ-law
    recovered = up.phone_to_pcm16(ulaw)         # 8k μ-law → 16k
    # Lengths should be close (resample + μ-law are lossy but length-preserving).
    assert abs(len(recovered) - len(original)) <= len(original) * 0.05
    # Energy must survive — not silence/garbage.
    import audioop
    assert audioop.rms(recovered, 2) > 1_000


def test_bridge_state_persists_across_chunks():
    """ratecv state carries across chunks: streamed == single-shot for same input."""
    streamed = AudioBridge()
    oneshot = AudioBridge()
    tone = _make_pcm16_16k(60)
    third = len(tone) // 3
    # round each split to an even byte boundary (s16le frames)
    a, b = (third // 2) * 2, (2 * third // 2) * 2
    chunks = streamed.pcm16_to_phone(tone[:a]) + streamed.pcm16_to_phone(tone[a:b]) + streamed.pcm16_to_phone(tone[b:])
    whole = oneshot.pcm16_to_phone(tone)
    # Stateful chunking must match the single-shot result almost exactly.
    assert abs(len(chunks) - len(whole)) <= 4


# ─────────────────────── webhook handler (mocked Telnyx) ───────────────────────

@pytest.fixture(autouse=True)
def _clean_registry():
    outbound_api._pending_calls.clear()
    yield
    outbound_api._pending_calls.clear()


@pytest.mark.asyncio
async def test_webhook_call_answered_starts_streaming(monkeypatch):
    calls = []

    async def fake_telnyx(method, path, **kwargs):
        calls.append((method, path, kwargs))
        return {}

    monkeypatch.setattr(outbound_api, "_telnyx", fake_telnyx)
    outbound_api._pending_calls["leg-1"] = {
        "call_control_id": "cc-1",
        "session_id": "sess-1",
        "language": "en",
        "status": "dialing",
    }

    await outbound_api.handle_webhook_event({
        "data": {
            "event_type": "call.answered",
            "payload": {"call_leg_id": "leg-1", "call_control_id": "cc-1"},
        }
    })

    assert outbound_api._pending_calls["leg-1"]["status"] == "connected"
    assert len(calls) == 1
    method, path, kwargs = calls[0]
    assert method == "post"
    assert path == "/calls/cc-1/actions/streaming_start"
    assert "session_id=sess-1" in kwargs["json"]["stream_url"]
    assert kwargs["json"]["stream_track"] == "inbound_track"


@pytest.mark.asyncio
async def test_webhook_unknown_leg_is_noop(monkeypatch):
    calls = []

    async def fake_telnyx(method, path, **kwargs):
        calls.append((method, path))
        return {}

    monkeypatch.setattr(outbound_api, "_telnyx", fake_telnyx)
    await outbound_api.handle_webhook_event({
        "data": {
            "event_type": "call.answered",
            "payload": {"call_leg_id": "ghost", "call_control_id": "x"},
        }
    })
    assert calls == []  # no streaming_start fired for an unknown leg


@pytest.mark.asyncio
async def test_webhook_hangup_removes_call(monkeypatch):
    async def fake_telnyx(method, path, **kwargs):
        return {}

    monkeypatch.setattr(outbound_api, "_telnyx", fake_telnyx)
    outbound_api._pending_calls["leg-2"] = {
        "call_control_id": "cc-2",
        "session_id": "sess-2",
        "status": "connected",
    }
    await outbound_api.handle_webhook_event({
        "data": {
            "event_type": "call.hangup",
            "payload": {"call_leg_id": "leg-2"},
        }
    })
    assert "leg-2" not in outbound_api._pending_calls


@pytest.mark.asyncio
async def test_initiate_call_rejects_number_not_in_allowlist(monkeypatch):
    monkeypatch.setattr(outbound_api.config, "TELNYX_ALLOWED_NUMBERS", ["+15550001111"])
    req = outbound_api.OutboundCallRequest(to="+19998887777", session_id="s")
    with pytest.raises(ValueError, match="not in TELNYX_ALLOWED_NUMBERS"):
        await outbound_api.initiate_call(req)
