---
name: tara-voice-platform
description: Build or repair Tara voice sessions, speech adapters, transcription, and voice artifacts without altering HIVE-MIND memory or Harness ownership.
---

# Tara voice platform

Read `../../platform.yaml` and `../../capability-contracts.md` first.

1. Identify whether the fault is capture, transport, speech-to-text, model
   dispatch, text-to-speech, or voice-session projection before editing.
2. Keep Deepgram, Grok, and any future provider behind typed speech adapters.
   Provider response fields are normalized at the adapter boundary.
3. Persist call/session artifacts through Tara/Core contracts; do not use browser
   audio buffers or provider payloads as durable truth.
4. Verify microphone permission denial, network failure, transcription success,
   reconnect, and authorization boundaries with the smallest relevant canary.
5. Release only Tara/frontend artifacts that changed; do not rebuild Harness or
   Core unless their typed contract changed.
