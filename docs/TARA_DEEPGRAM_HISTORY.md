# TARA Deepgram Architecture And Upgrade History

## Purpose

This document is the source-backed history and current-state record for the
production TARA voice sidecar. It separates four facts that must not be
conflated:

1. code committed in Git;
2. code contained in the running image;
3. runtime configuration supplied by the production host;
4. behavior accepted through a real voice call.

Append a new dated verification section after future accepted TARA releases.
Do not rewrite older evidence. Never record secret values in this file.

## Verified Baseline - 2026-07-23 UTC

### Canonical repository

- Parent repository: `HIVEMIND`, branch `singulance-main`.
- Verified parent SHA: `8eaf4e35963d3664c88a2c0f818849e0486caa87`.
- The only Git submodule is `frontend/Da-vinci` at
  `1ab5f621661a8751e58eeb863ddbc063fd1dc48f`.
- `services/tara-deepgram` is ordinary versioned monorepo source, not a
  submodule and not an untracked `/opt` application checkout.
- A fresh recursive clone completed with a clean working tree.

### Live SINGULANCE runtime

- Host: `singulance`.
- Container: `tara-deepgram`.
- Image tag: `hivemind/tara-deepgram:prod-20260722-rmye01367541`.
- Image ID: `sha256:ddf0b1e9ea87b2d733abea4d9652074a7f09f59b12af92cc2a99962ba570a096`.
- Started: `2026-07-22T17:03:15Z`.
- Runtime: `running`, `healthy`, zero restarts at verification time.
- Every Python source file under `/app/tara_deepgram` matched the canonical
  `services/tara-deepgram/tara_deepgram` SHA-256 checksum.
- `/app/requirements.txt` matched the canonical dependency file SHA-256:
  `b9b0a7819c9883d89fe8c0e9966bcd0c417ccb11377de173951ed369809f8104`.
- The running image therefore contains the current canonical TARA service
  source from `8eaf4e3`, even though its OCI revision label is empty.

### Safe runtime configuration observations

Only non-secret state was inspected:

| Setting | Live value |
|---|---|
| Listen engine | Deepgram `nova-3` |
| Speak provider | Cartesia |
| Cartesia configured | yes |
| Telephony provider | Twilio |
| Telnyx configured | no |
| Turn strategy | `router` |
| Outbound enabled | yes |
| Dial/think/listen shared secrets | configured |
| Connector Runtime projection | flag off |
| Campaign parallel cap | 3 |

No customer call, paid TTS preview, connector action, or write was executed as
part of this audit.

## What TARA Deepgram Is

The production voice path is a shared sidecar with these responsibilities:

```text
Browser microphone or Twilio/Telnyx phone stream
  -> services/tara-deepgram
  -> Deepgram Voice Agent: STT, turn detection, barge-in, audio session
  -> HIVEMIND think shim and Core /api/tara/stream: reasoning and recall
  -> Cartesia Sonic or Deepgram Aura: speech generation
  -> transcript/usage/call-end events back to Core
  -> Core post-call analysis, lead/learning persistence, and metering
```

### Ownership by component

| Capability | Canonical owner |
|---|---|
| HTTP/WebSocket routes, voice catalogs, previews | `services/tara-deepgram/tara_deepgram/app.py` |
| Browser audio bridge and call-history events | `services/tara-deepgram/tara_deepgram/browser_voice.py` |
| Deepgram settings, audio bridge, disclosure, function calls | `services/tara-deepgram/tara_deepgram/agent_session.py` |
| Turn routing, direct answer versus grounded recall | `services/tara-deepgram/tara_deepgram/think_shim.py` and `turn_router.py` |
| Core recall stream client | `services/tara-deepgram/tara_deepgram/tara_stream.py` |
| Twilio/Telnyx dialing and call state | `services/tara-deepgram/tara_deepgram/telephony.py` |
| Voice-safe built-in tools | `services/tara-deepgram/tara_deepgram/functions.py` |
| Flag-gated read-only connector tools | `services/tara-deepgram/tara_deepgram/connectors.py` |
| Listen-only in-flight call tap | `services/tara-deepgram/tara_deepgram/listen.py` |
| Sidecar-to-Core identity and history posts | `services/tara-deepgram/tara_deepgram/core_client.py` |
| Durable call rows, turns, post-call insights and metering | `core/src/server.js` and Prisma TARA models |
| Outreach-to-TARA dispatch | `core/src/outreach/campaigns.js` and `core/src/control-plane-server.js` |
| Production topology | `infra/docker-compose.hetzner.yml` |

## Claims Matrix

| Claim | Status on 2026-07-23 | Evidence boundary |
|---|---|---|
| Deepgram handles voice listening, turn-taking and barge-in | verified in canonical and live image source | Not re-proven with a paid call in this audit. |
| Cartesia is the active production speak provider | verified from safe live runtime state | Voice quality/latency was not re-measured. |
| Deepgram Aura remains a fallback/provider option | verified in source | Not active in the inspected runtime. |
| Twilio is the active phone provider | verified from health and safe runtime state | No call placed. |
| Telnyx remains supported | verified in source | No live Telnyx credentials and not active. |
| TARA uses HIVEMIND Core for grounded recall | verified in source wiring | Answer quality was not re-canary-tested here. |
| Browser and phone turns feed Core call history | verified in source wiring | No customer session written during audit. |
| Core triggers post-call insights and learning | verified in Core source | No fresh call-end acceptance in this audit. |
| Live-listen exists | verified in canonical and live image source | Browser acceptance not rerun. |
| Voice-safe connector projection exists | verified in source | Disabled in the inspected runtime. |
| `tara-deepgram` is the production TARA container | verified from Compose and Docker | `tara-aaas` source still exists but is not running. |

## Boundary With Meeting Notes

TARA voice and Meeting Notes are separate ingestion surfaces:

- `tara-deepgram` handles real-time TARA browser/phone conversations.
- Meeting recording, transcription, diarization and canonical meeting
  ingestion live in Core and the frontend Meeting Notes modules.
- Meeting Notes commits must not be cited as proof that TARA voice works, and
  TARA voice commits must not be cited as proof of Meeting Notes transcription.
- Both can eventually write through canonical memory ingestion, but they have
  different capture, authentication, latency and acceptance requirements.

## Boundary With Legacy `tara-aaas`

- `services/tara-aaas` remains in the repository as legacy source.
- No `tara-aaas` container was running on SINGULANCE during this audit.
- Production Compose defines `tara-deepgram`, and Core dispatches managed calls
  to `http://tara-deepgram:8091`.
- `scripts/quick-deploy.sh` currently rebuilds `tara-deepgram` when either
  `services/tara-aaas` or `services/tara-deepgram` changes. This is conservative
  but preserves conceptual coupling to legacy source and should eventually be
  narrowed after legacy removal is proven safe.
- New TARA features must target `services/tara-deepgram`; changes made only in
  `services/tara-aaas` are not production TARA changes.

## Service Upgrade Ledger

The following are all 24 commits that changed `services/tara-deepgram` between
its introduction and the verified canonical baseline. Related Core and
frontend-only upgrades are listed separately afterward.

| Date | Commit | Upgrade |
|---|---|---|
| 2026-07-04 | `5b408cb9` | Introduced the Deepgram Voice Agent sidecar, Telnyx bridge and campaigns. |
| 2026-07-04 | `7ced79ec` | Removed accidentally committed Python bytecode. |
| 2026-07-05 | `3d7a1581` | Added browser voice bridge, Aura-2 catalog and preview routes. |
| 2026-07-05 | `641d0727` | Added voice-v2 strategic turn engine and self-host skill config correction. |
| 2026-07-05 | `a3f98c6b` | Added bounded session brief, goal directive, skills and full Aura catalog. |
| 2026-07-05 | `6da82050` | Added remote-org insights, anti-repeat directive and persona-aware strategy. |
| 2026-07-06 | `95e31533` | Added Twilio as a selectable telephony provider. |
| 2026-07-06 | `f481ec40` | Routed fast voice turns and recall synthesis to GPT-OSS 120B/Cerebras. |
| 2026-07-06 | `bcb85b55` | Added filler-first behavior for slow recall turns. |
| 2026-07-06 | `a0997789` | Added language-aware outbound voice selection. |
| 2026-07-06 | `969ec857` | Replaced unauthorized German/Dutch defaults that dropped calls. |
| 2026-07-06 | `7bc65f4c` | Enforced selected-skill persona and goal-driven strategy. |
| 2026-07-06 | `43e3e340` | Added pre-router filler and recall warm-up at connect. |
| 2026-07-06 | `80488582` | Added strategic opening, real company name and call-end status. |
| 2026-07-06 | `0474b979` | Added lead, token, duration and post-call insight dashboard support. |
| 2026-07-06 | `409dab4c` | Added confidence-driven convergence and rotating fillers. |
| 2026-07-06 | `3d6d9679` | Added owner-controlled open dialing while retaining allowlist behavior. |
| 2026-07-07 | `4b50caad` | Corrected per-turn metering, disabled repetitive fillers and deduplicated opening. |
| 2026-07-14 | `49d8547c` | Cut managed calls over to Deepgram TARA; added Cartesia speak seam, auth and tests. |
| 2026-07-15 | `f98dce54` | Added explicit wildcard/open-dial policy while preserving fail-closed lists. |
| 2026-07-17 | `24a8bd2b` | Added prospect context, outreach learning loop and route hardening. |
| 2026-07-17 | `ae9a14c2` | Added missing live-listen source, bridge tee and WebSocket route. |
| 2026-07-18 | `c818ca18` | Reconciled browser goal behavior and restored dial authentication. |
| 2026-07-22 | `1959a2df` | Added flag-gated, read-only, voice-safe Connector Runtime projection. |

### Related upgrades outside the sidecar directory

| Date | Commit | Upgrade |
|---|---|---|
| 2026-07-06 | `d6d6ab85`, `f59887e0` | Reserved TARA-MEMORY project and transcript-memory behavior. |
| 2026-07-14 | `bfe06b71`, `cec329ef` | TARA usage metering and room/call outcome bridge. |
| 2026-07-15 | `d6c02783` | Unified TARA and HyperAgents recall defaults. |
| 2026-07-17 | `60bf88a2` | Frontend live-listen feature lineage. |
| 2026-07-18 | `2e09cd49`, `53f9e577` | Surfaced post-call analysis without reload and corrected the frontend gitlink. |
| 2026-07-21 | `03f02431` | Routed TARA voice-session saves through the canonical V5 envelope. |

## Verified Checks

The following checks passed on 2026-07-23:

```text
fresh recursive clone                         PASS
parent SHA and frontend gitlink               PASS
clean working tree                            PASS
canonical Python compileall                   PASS
telephony allowlist unit tests                3/3 PASS
live /health                                  HTTP 200
live container health                         healthy, restarts=0
canonical/live Python source checksums        exact match
canonical/live requirements checksum          exact match
expected source markers in live image         present
```

The telephony unit suite currently proves only empty-list rejection,
unlisted-number rejection and allowed-number provider dispatch. It does not
prove browser authentication, webhook authenticity, paid-provider behavior,
post-call analysis, connector execution or a complete real phone call.

## Open Production Gaps

### P0 - Public browser voice authentication

Caddy publicly proxies `https://core.singulancelabs.com/voice2/*` directly to
the sidecar. The `/voice` WebSocket accepts `user_id` and `org_id` from query
parameters and the sidecar then calls Core with a master API key. No
sidecar-level browser session/JWT validation is visible in this path. This must
be treated as a tenant-isolation risk until a valid short-lived, tenant-bound
voice token is required and verified before accepting the WebSocket.

### P0 - Telephony route authentication completeness

- Dial and hangup routes are protected when `TARA_DG_API_KEY` is configured;
  it is configured in the inspected runtime.
- Call-status lookup does not apply the same authentication check.
- The Telnyx webhook handler accepts an event body without visible provider
  signature verification.
- These routes need one shared fail-closed authentication policy plus provider
  webhook signature validation before broad production exposure.

### P0 - Real rollback and image provenance

- The running image has no `org.opencontainers.image.revision` label.
- The `hivemind/tara-deepgram:stable` tag expected by
  `quick-deploy.sh --rollback tara-deepgram` is missing.
- `latest`, `prod-20260722-rmye01367541` and the separately named
  `stable-20260722` all resolve to image `ddf0b1e9ea87`; the latter is not a
  distinct rollback.
- The production release ledger still records the older TARA digest
  `cf7c25e2...`, not the running `ddf0b1e9...` digest.
- The next TARA release must preserve the outgoing image under a distinct
  rollback tag, build with the canonical revision label, and update the release
  ledger only after a real voice/session acceptance.

### P1 - Durable distributed state

`pending_calls`, campaign state, persona cache and turn strategy state are
in-process. A restart loses transient state, and multiple replicas would not
share it. Redis-backed session/call state is required before horizontal
replication.

### P1 - Acceptance coverage

Add contract and integration coverage for:

- authenticated browser WebSocket tenant binding;
- Deepgram settings and Cartesia fallback behavior;
- signed Twilio/Telnyx webhook handling;
- start, turn, end, usage and post-call insight persistence;
- connector projection grant, read-only enforcement and timeout behavior;
- call-listen authorization and cleanup;
- restart behavior and duplicate event idempotency;
- real-call canary with no customer side effects.

## Required Update Procedure

For every future TARA change:

1. Work on an isolated branch from current `origin/singulance-main`.
2. Update `services/tara-deepgram`; do not implement production behavior only
   in `services/tara-aaas` or `/opt/tara-deepgram`.
3. Add or update focused tests.
4. Record the service commit in this append-only ledger.
5. Merge the complete tested change into `singulance-main`.
6. Build the TARA image from that exact SHA with an OCI revision label.
7. Preserve the outgoing image as a distinct rollback image.
8. Verify image markers, health and one authenticated voice/session canary.
9. Update `docs/PRODUCTION_RELEASE.md` with the actual running digest and
   rollback tag.
10. Append the accepted runtime evidence here without deleting earlier history.
