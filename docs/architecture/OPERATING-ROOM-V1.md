# HIVEMIND Operating Room V1

## Product contract

Operating Room is a reusable, multi-person voice room under **Employees**. It is not a Day-3-only workflow and it does not create a second memory or meeting pipeline.

- Each participant joins from their own authenticated HIVEMIND session.
- Core resolves the participant's name, user ID, organization ID, and role from `UserOrganization`; browser identity fields are never authoritative.
- Cloudflare RealtimeKit carries the live multi-party media session.
- `HyperRoom(roomMode=operating)` is the durable room envelope. Its versioned `roomPlaybook` stores the RealtimeKit meeting ID, verified roster, bounded live transcript, and lifecycle state.
- The existing meeting transcript/finalization pipeline remains the canonical destination for long-lived meeting evidence and memories.
- HIVEMIND/TARA is a disclosed facilitator. A deterministic wake gate recognizes `HIVEMIND` or `TARA` before any model call.

## Request flow

```text
Authenticated member
  -> POST /v1/operating-rooms
  -> Control Plane creates RealtimeKit meeting
  -> Control Plane persists tenant-scoped room envelope

Authenticated member opens shared room URL
  -> POST /v1/operating-rooms/:id/join
  -> membership and org boundary verified
  -> server adds participant using stable internal user UUID
  -> short-lived RealtimeKit participant token returned
  -> browser joins voice-only media room

Browser final transcript
  -> POST /v1/operating-rooms/:id/transcript
  -> speaker identity overwritten from authenticated membership
  -> transcript appended with bounded retention in live envelope
  -> deterministic wake gate
  -> compact room context (roster + goal + last 10 turns) prepared for TARA
  -> the addressing browser makes exactly one existing V2 chat turn
  -> the grounded answer is broadcast through RealtimeKit chat
  -> every participant browser speaks the same answer locally

Admin closes room
  -> one idempotent MeetingSession + attributed MeetingSegment are persisted
  -> existing meeting-finalization reconciler is queued
  -> existing insight and durable meeting-report lifecycle owns retries and receipts
```

## Required production configuration

Set these only on the Control Plane service:

```dotenv
CLOUDFLARE_ACCOUNT_ID=<Cloudflare account ID>
CLOUDFLARE_REALTIMEKIT_APP_ID=<RealtimeKit App ID>
CLOUDFLARE_REALTIMEKIT_API_TOKEN=<API token with Realtime permission>
CLOUDFLARE_REALTIMEKIT_HOST_PRESET=group_call_host
CLOUDFLARE_REALTIMEKIT_MEMBER_PRESET=group_call_participant
OPERATING_ROOMS_V1=true
```

Build the frontend with `REACT_APP_OPERATING_ROOMS_V1=true`. Keep both flags off until the two-device canary passes.

Create both presets in RealtimeKit. The host preset may admit/remove participants; the member preset must not. Enable audio and transcription; keep camera off for V1. Never expose the API key to the frontend.

## Release acceptance

1. `node --test core/src/operating-room/room-contract.test.mjs`
2. `node --check core/src/control-plane-server.js`
3. `npm run build` in `frontend/Da-vinci`
4. Deploy Control Plane and frontend from the same canonical parent SHA.
5. With two real organization members on separate devices, create one room and join the same URL.
6. Verify both names come from membership records, audio is bidirectional, and a non-member receives `404`/`403`.
7. Say “HIVEMIND, what do you think?” and verify the attributed transcript event reports `addressed_to_hivemind=true` with a compact group context.
8. Close the room as an admin and verify a member cannot close it.

## Intentionally not claimed by this slice

The current slice completes secure room creation, multi-party media admission, attributed live transcript capture, compact group context, deterministic facilitator addressing, one V2 chat response per addressed turn, synchronized browser TTS through RealtimeKit chat, and idempotent handoff to the existing durable meeting finalizer. A later media-bot bridge may replace synchronized browser TTS when RealtimeKit exposes a supported server-side agent participant path. Do not report production completion without a two-device canary and persisted finalization receipt.
