#!/usr/bin/env python3
"""
End-to-end audio proof for /voice — no browser/mic needed.

1. Synthesize a test phrase via Cartesia REST → raw PCM 16k mono (simulates mic).
2. Connect ws://.../voice, stream PCM in 120ms chunks, then trailing silence.
3. Collect: control frames (transcript/turn_done) + binary TTS audio out.
4. PASS = STT transcribed AND audio bytes streamed back.

Env: CARTESIA_API_KEY, CARTESIA_VOICE_ID. AaaS must be running (default :8090).
"""
import asyncio
import json
import os
import sys
import time

import httpx
import websockets

WS = os.getenv("AAAS_WS", "ws://127.0.0.1:8090/voice")
PHRASE = os.getenv("TEST_PHRASE", "What is HIVEMIND in one sentence?")
SR = 16000
CHUNK_MS = 120
CHUNK_BYTES = int(SR * CHUNK_MS / 1000) * 2  # 16-bit mono


async def synth_pcm(text: str) -> bytes:
    """Cartesia REST → raw PCM s16le 16k mono (the 'mic' input)."""
    key = os.environ["CARTESIA_API_KEY"]
    voice = os.environ["CARTESIA_VOICE_ID"]
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(
            "https://api.cartesia.ai/tts/bytes",
            headers={"X-API-Key": key, "Cartesia-Version": "2024-11-13", "Content-Type": "application/json"},
            json={
                "model_id": "sonic-2",
                "transcript": text,
                "voice": {"mode": "id", "id": voice},
                "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": SR},
                "language": "en",
            },
        )
        r.raise_for_status()
        return r.content


async def main() -> int:
    uid = os.getenv("TEST_USER_ID", "54f5568b-4d6a-4ae1-9a33-48cb2909d59b")
    oid = os.getenv("TEST_ORG_ID", "67503d34-97e9-49a8-8c52-8ee30cc7603e")
    url = f"{WS}?user_id={uid}&org_id={oid}&session_id=audio-e2e&language=en"

    print(f"synth '{PHRASE}' via Cartesia ...")
    pcm = await synth_pcm(PHRASE)
    print(f"  got {len(pcm)} PCM bytes ({len(pcm)/(SR*2):.1f}s)")

    audio_out = bytearray()
    transcript = None
    first_audio_ms = None
    started = None

    async with websockets.connect(url, max_size=None) as ws:
        # wait ready
        ready = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
        print(f"  server: {ready}")

        async def feed():
            # stream the phrase in 120ms chunks
            for i in range(0, len(pcm), CHUNK_BYTES):
                await ws.send(pcm[i:i + CHUNK_BYTES])
                await asyncio.sleep(CHUNK_MS / 1000)
            # trailing silence (1.2s) to trigger VAD SPEECH_END / finalize
            sil = b"\x00" * CHUNK_BYTES
            for _ in range(10):
                await ws.send(sil)
                await asyncio.sleep(CHUNK_MS / 1000)

        feeder = asyncio.create_task(feed())
        nonlocal_started = time.monotonic()
        try:
            while True:
                msg = await asyncio.wait_for(ws.recv(), timeout=40)
                if isinstance(msg, (bytes, bytearray)):
                    if first_audio_ms is None:
                        first_audio_ms = round((time.monotonic() - nonlocal_started) * 1000)
                    audio_out.extend(msg)
                else:
                    evt = json.loads(msg)
                    t = evt.get("type")
                    if t == "transcript":
                        transcript = evt.get("text")
                        print(f"  STT transcript: '{transcript}'")
                    elif t == "turn_done":
                        if transcript:   # ignore the greeting's turn_done; wait for our utterance
                            print("  turn_done")
                            break
                    elif t == "error":
                        print(f"  ERROR: {evt.get('error')}")
                        break
        except asyncio.TimeoutError:
            print("  (timeout waiting for events)")
        finally:
            feeder.cancel()

    print("─" * 50)
    ok = bool(transcript) and len(audio_out) > 0
    print(f"transcript={'YES' if transcript else 'NO'} | audio_out={len(audio_out)} bytes "
          f"({len(audio_out)/(SR*2):.1f}s) | first_audio={first_audio_ms}ms")
    print("✅ PASS — full voice round-trip streams audio" if ok else "❌ FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
