# TARA Grok Session Handoff

Read this after `.claude/ONBOARDING.md` before changing or deploying TARA.

## Current implementation

Canonical source checkout: `/root/hivemind-main`, branch `codex/tara-grok`.
Compose/run checkout: `/root/hivemind` (never build here).

The latest complete follow-up branch is:

```text
/root/hivemind/.worktrees/tara-grok-hardening
branch: codex/tara-grok-live-captions
commit: f674d332d fix(tara): stream Grok live captions
```

This commit is based on the current Grok work and includes the frontend
submodule pointer to `fb04df1` (which includes `4de6738`, the multilingual
voice-picker fix).

## What is already implemented

- Parallel `tara-grok` adapter, pinned to `grok-voice-think-fast-1.0`.
- Capability is carried in a WebSocket subprotocol, not a query string.
- Core owns sessions, tenant scope, tool mediation, audit events, config, and
  the selected TARA skill prompt snapshot. Grok owns realtime voice reasoning.
- Adapter uses binary PCM16 16 kHz, server VAD, xAI session resumption, bounded
  frames, parallel function-call batching, and scoped Core service callbacks.
- Core callback route fix: `/internal/v1/tara/calls/*` must be outside the
  `/api/` branch. This is in `03edfb6b1` and the current source line of work.
- The control-plane runtime-config route was stale in production, then deployed;
  unauthenticated `GET /v1/tara/runtime-config` returning `401` is correct.
- Frontend provider toggle waits for runtime config before becoming interactive.

## Latest pending fix: live captions and startup

`f674d332d` adds:

- `audio.input.transcription.model = grok-transcribe`.
- xAI event normalization to the existing provider-neutral widget messages:
  `ready`, `speech_start`, `transcript`, `agent_text`, `turn_done`, `error`.
- Grok Core capability issuance runs concurrently with browser microphone
  permission, eliminating one serial startup wait.

Do not forward raw xAI events directly to `AaasVoiceWidget`: it expects the
normalized contract above. Do not replace the adapter with direct browser xAI
ephemeral-token sessions; that bypasses Core-controlled tools, audit, tenant
scope, and durable call state.

## Deployment rules and blockers

- Read `.claude/ONBOARDING.md` and `TARA_GROK_DEPLOYMENT.md` first.
- Build only from `/root/hivemind-main`; compose only from `/root/hivemind`.
- Deploy exactly one named service with `--no-deps --dry-run` before `up`.
- Never use a bare Compose `up`, `compose down`, or `prisma migrate deploy`.
- Preserve `tara-deepgram` and `/voice2` unchanged.
- This Codex session lacked write access to `/root/hivemind-main` and `/opt`,
  and Docker socket access. Verify the new session has those capabilities before
  attempting a rollout.

## User-confirmed symptoms (live, 2026-07-25) — these are what `f674d332d` targets

Reported against the deployed build, so treat as reproducible, not theoretical:

1. **No realtime transcription.** Deepgram shows live STT/TTS captions; Grok shows
   none. Cause: the adapter forwards raw xAI events, but `AaasVoiceWidget` only
   renders the normalized contract (`ready`, `speech_start`, `transcript`,
   `agent_text`, `turn_done`, `error`). Nothing maps xAI → that contract yet, and
   `audio.input.transcription.model = grok-transcribe` was not set, so xAI never
   emitted `conversation.item.input_audio_transcription.*` in the first place.
2. **Start takes too long.** Capability issuance was serial with microphone
   permission; `f674d332d` runs them concurrently.

### Console-noise triage — do NOT chase these
From the user's console dump, only ONE line is ours:
- `contentscript.js … ObjectMultiplex orphaned data` → MetaMask extension. Unrelated.
- `Access to storage is not allowed from this context` → extension/iframe. Unrelated.
- `THREE.Clock deprecated` → the 3D orb component. Cosmetic, unrelated.
- **`ScriptProcessorNode is deprecated … g.onopen`** → OURS. The widget captures mic
  audio with the deprecated `ScriptProcessorNode`. It still works (warning, not
  error) and is fired from the Grok WS `onopen`, so it is *not* the caption bug —
  but it is the real migration debt (`AudioWorkletNode`) if audio ever glitches.

## Immediate next action

1. Reconcile/cherry-pick `f674d332d` into the canonical clean checkout, without
   discarding its existing user changes.
2. Deploy only `tara-grok` for adapter changes; deploy only `core` if the Core
   callback commit is not already in its running image; deploy FE only when its
   submodule gitlink is updated and built.
3. Verify public `/voice-grok/health/ready`, unchanged `/voice2/health`, Core,
   control-plane runtime-config (`401` without cookie), then a browser Grok
   session with live user/assistant captions.
