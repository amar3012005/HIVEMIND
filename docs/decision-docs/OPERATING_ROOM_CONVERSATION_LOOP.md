# Operating Room multi-person conversation loop

## Scope and ownership

Operating Rooms reuse RealtimeKit media, the independent TARA browser bridge,
Core's existing organization-scoped knowledge chat, and the durable meeting
finalization pipeline. This change does not modify general chat, retrieval,
memory ingestion, or graph policies. All speaker identity comes from Control
Plane authentication and the durable room participant row, not client names.

## Live path

1. A member joins the tenant-scoped room through Control Plane. RealtimeKit
   participant identity is bound to that authenticated user. HIVEMIND is a
   separate disclosed AI participant, not a browser impersonating the host.
2. Each human's browser forwards only that user's final RealtimeKit transcript
   events. Partial captions are not durable turns. A stable client event ID,
   room ID and verified user ID derive one immutable event ID for retries.
3. Unaddressed speech is retained as discussion. Saying HIVEMIND or TARA (or
   submitting the room question box) requests an answer to a persisted turn.
4. Control verifies turn ownership and takes a PostgreSQL response lease.
   Busy requests retry their original turn; they do not create another answer.
5. Context contains the shared goal/agenda, verified roster/current speaker,
   a bounded rolling brief and the last 24 human/AI turns. Core receives the
   current speaker's authority with organization scope and connected tools off.
   Native knowledge recall remains available. Private personal facts must not
   be exposed to the room merely because the speaker can access them privately.
6. The answer is persisted before speech. Only the authenticated bridge service
   can make TARA speak; participant broadcasts cannot inject facilitator audio.
   Speech is serialized and deduplicated by turn ID for the bridge lifetime.
7. The FE polls shared state every 2.5 seconds and shows activity, agenda, brief,
   unresolved items and the participant addressed by each response.
8. End/finalize uses the existing durable meeting lifecycle, including both
   human and explicitly AI-labelled turns. Ending waits for the current answer.

## Rolling history

The canonical transcript stays in OperatingRoomEvent. The room brief advances
through stable `(createdAt,id)` cursors in batches of 32; at most two batches per
addressed request. Long backlogs catch up on subsequent requests. Recent turns
are always supplied separately. A model summary is not a verbatim transcript
or proof of agreement. Structured decisions/open items require source turn IDs;
unresolved items are retained conservatively. Model failure preserves the old
brief, not a fabricated replacement. A large backlog can therefore make the
brief stale; do not advertise unlimited context or complete historical recall.

## Cloudflare transcription configuration

The dedicated Operating Rooms app's `group_call_host` and
`group_call_participant` presets must have `permissions.transcription_enabled`
set to true. Enabling `meeting.ai` listeners alone does not enable STT. These
two presets were enabled and read back on 2026-09-07. No credential is stored
in this document. Rejoining may be necessary to acquire updated permissions.

Reference: https://developers.cloudflare.com/realtime/realtimekit/ai/transcription/

The client ingests only self-authored human events, so TARA's transcript does
not trigger another facilitator response. Browser speech recognition is only
a compatibility fallback, with a visible text-input alternative when absent.

## Verification and limits

`node --test core/src/operating-room/room-contract.test.mjs` covers five-speaker
ID isolation, stable retries, bounded context, summary references/cursors,
tenant-scoped SQL leases and authenticated bridge requests. Its one-hour
transcript scenario is accelerated; it is not a one-hour live audio soak.

`core/tests/operating-room-live-canary.mjs` is an explicitly opted-in disposable
production probe run inside the Control container. It checks five authenticated
participants, spoof rejection, duplicate transcript handling, shared agenda,
grounded cross-speaker answer and TARA speech receipt. It does not prove five
physical microphones, mobile audio, barge-in or hour-long network stability.

Current response handling is bounded request/lease based, not an autonomous
background agenda scheduler. It steers when addressed; it does not interrupt
human conversation on a timer. Barge-in and interrupted speech resume are not
implemented by this patch. Leases expire after a crashed process; do not claim
exactly-once physical audio across a bridge crash after playback started.

## Release safety

Merge frontend first, then pin its merged commit in the canonical parent.
Release only affected Control and Playwright services from the canonical clean
release runner, then deploy the pinned frontend Worker. Never build from the
shared dirty server checkout. Verify a live disposable canary before declaring
the feature accepted. No new database migration is required.
