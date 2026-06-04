#!/usr/bin/env python3
"""
Test the stream_tara → Cartesia leg in isolation (skip STT).

text query → stream_tara (HIVEMIND tokens) → CartesiaManager.stream_text_to_audio
          → collect audio bytes + measure TTFT (first audio) and total.

Env: HIVEMIND_API_KEY, CARTESIA_API_KEY, CARTESIA_VOICE_ID.
"""
import asyncio, os, sys, time
from tara_aaas.tara_stream import stream_tara
from tara_aaas.tts.cartesia_manager import CartesiaManager
from tara_aaas.tts.config import CartesiaConfig


async def main() -> int:
    q = os.getenv("Q", "In one sentence, what is HIVEMIND?")
    uid = os.getenv("TEST_USER_ID", "54f5568b-4d6a-4ae1-9a33-48cb2909d59b")
    oid = os.getenv("TEST_ORG_ID", "67503d34-97e9-49a8-8c52-8ee30cc7603e")

    tts = CartesiaManager(CartesiaConfig.from_env())
    await tts.warmup()

    audio = bytearray()
    started = time.monotonic()
    first_token_ms = None
    first_audio_ms = None

    async def tokens():
        nonlocal first_token_ms
        async for evt in stream_tara(query=q, session_id="tts-leg", user_id=uid, org_id=oid):
            if evt["type"] == "token":
                if first_token_ms is None:
                    first_token_ms = round((time.monotonic() - started) * 1000)
                yield evt["text"]
            elif evt["type"] == "error":
                print("stream_tara error:", evt["error"])

    def on_audio(chunk, sr, meta):
        nonlocal first_audio_ms
        if first_audio_ms is None:
            first_audio_ms = round((time.monotonic() - started) * 1000)
        audio.extend(chunk)

    await tts.stream_text_to_audio(tokens(), audio_callback=on_audio, context_id="tts-leg")
    total_ms = round((time.monotonic() - started) * 1000)

    print("─" * 50)
    sr = CartesiaConfig.from_env().sample_rate
    print(f"first_token={first_token_ms}ms  first_audio(TTFT)={first_audio_ms}ms  total={total_ms}ms")
    print(f"audio={len(audio)} bytes ≈ {len(audio)/(sr*2):.1f}s @ {sr}Hz")
    ok = len(audio) > 0 and first_audio_ms is not None
    print("✅ PASS — Cartesia synthesized audio from stream_tara" if ok else "❌ FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
