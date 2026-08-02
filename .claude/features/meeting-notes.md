# AI Meeting Notes

**Group:** Your Brain  
**Route:** `/hivemind/app/meeting-notes`  
**Status:** PRODUCTION VERIFIED  
**Release:** backend `1b72fac9f`, frontend `1a8d2d0`

## Product Contract

AI Meeting Notes keeps transcript checkpoints independently recoverable, produces a progressive report, optionally promotes the completed meeting into HIVEMIND memory, and meters exact recording duration against the organization plan. A transcript remains usable when analysis, context, or memory promotion fails later.

The cover page contains the minute meter, start action, compact history, and meeting flow. Completed meetings open in the shared responsive report view rather than expanding into the cover page.

## Canonical Implementation

### Frontend

- `frontend/Da-vinci/src/components/hivemind/app/pages/MeetingNotes.jsx`
- `frontend/Da-vinci/src/components/hivemind/app/shared/QuickRecorderProvider.jsx`
- `frontend/Da-vinci/src/components/hivemind/app/shared/UsageTracker.jsx`
- `frontend/Da-vinci/src/components/hivemind/app/layout/AppShell.jsx`

`QuickRecorderProvider` owns the active/recoverable recording session. IndexedDB keys include organization, user, and session identity. Acknowledged audio is removed while transcript checkpoints remain until durable meeting finalization.

### Backend

- `core/src/server.js`
- `core/src/llm/stt-route.js`
- `core/src/meetings/meeting-intelligence.js`
- `core/src/billing/plans.js`
- `core/src/billing/plan-enforcer.js`
- `core/src/storage/driver.js`
- `core/src/storage/embedded-agent.js`
- `core/src/storage/byod-agent.js`
- `core/src/storage/remote-backend.js`

Canonical supporting operations:

- `GET /api/meetings/usage`
- `POST /api/meetings/sessions`
- Existing meeting, transcription, segment, analysis, ingestion, retry, read, and delete routes

## Language Handling

Transcription does not force a language and does not request translation. The selected model detects language changes inside the audio and preserves the spoken text across code switches.

Production route:

1. Configured `STT_PROVIDER` (`openrouter`) with `MEETING_STT_MODEL=google/gemini-2.5-flash`
2. OpenRouter `nvidia/parakeet-tdt-0.6b-v3`
3. Groq `whisper-large-v3`

The mixed-language regression fixture preserves a German-English-German utterance exactly and verifies that no `language` form field is sent.

## Subscription Limits

Backend billing plans are the source of truth:

- Free: 30 minutes/month
- Pro: 100 minutes/month
- Scale: 500 minutes/month
- Enterprise: unlimited

Usage is stored in exact seconds, organization scoped, initiating-user attributed, and settled idempotently from durable meeting duration.

## Production Guardrails

- [x] **Tenant isolation** - organization and user come from the authenticated principal; reads, segments, retries, ingestion, deletion, and recovery are scope checked.
- [x] **AuthZ** - unauthenticated usage returns `401`; missing and unauthorized resources use the same not-found behavior.
- [x] **Consent** - session admission rejects false or missing consent with `400 recording_consent_required`.
- [x] **Input bounds** - audio is streamed with a bounded body and media-type validation.
- [x] **Failure isolation** - transcript, analysis, company context, and memory promotion are independent stages.
- [x] **Idempotency** - segment acknowledgement, meeting finalization, usage settlement, and memory promotion are retry safe.
- [x] **Storage parity** - hybrid, `amr_embedded`, and `byod_amr` expose the same meeting contract; unavailable remote storage fails closed.
- [x] **Privacy** - complete audio is not retained server side; transcripts are excluded from production error payloads.
- [x] **Observability** - safe stage/error states and model attempts are exposed without transcript content.

## Verification Evidence

Focused backend command:

```bash
docker run --rm -v "$PWD/core:/app" -w /app node:20 node --test \
  tests/unit/meeting-intelligence.test.js \
  tests/unit/plan-enforcer.test.js \
  tests/unit/stt-route.test.js \
  tests/control-plane/session-store.test.js
```

Result: 29 tests passed, 0 failed. The Core image build release gate also passed 21/21 tests. Storage driver conformance passed 16/16 in the release run.

Production API canary:

```text
GET usage with scoped key       200
GET usage without credentials   401
POST session consent=false      400 recording_consent_required
POST session consent=true       201, consent_recorded=true
Scale allowance                 0 / 30000 seconds used
```

Signed-in Playwright ran at 1440x1000 and 390x844. Both rendered the page, minute meter, history, recorder setup, and default HIVEMIND save option with no horizontal overflow, page exception, or HTTP 5xx. Mobile navigation no longer compresses the page and the Talk-to-HIVE control no longer covers recorder content.

Production images:

- Core: `hivemind/core-api:prod-20260802-meeting-notes-1b72fac9f`
- Frontend: `hivemind/fe:prod-20260802-meeting-notes-960b42e54`

Control Plane, Employees, TARA, Deepgram, `/voice2`, Campaign Intelligence, and HQ Runtime were not modified by this release.

## Deferred

- Permanent audio storage
- Live meeting coaching
- Calendar/video integrations
- Psychological or personality analysis
- A generic workflow engine
