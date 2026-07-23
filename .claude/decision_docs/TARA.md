# TARA Decision

The current voice runtime is `services/tara-deepgram`, with Core coordination
under `core/src/tara/`. `tara-aaas` is legacy and must not be used as an active
implementation or deployment target.

TARA shares platform identity, organization/project scope, plan gates, memory,
connectors, approvals, audit, and usage metering. The voice sidecar handles
real-time media/provider concerns; Core owns durable platform truth. Post-call
transcript, insight, lead, outcome, and memory processing must be idempotent and
observable.

Primary code:

- `services/tara-deepgram/tara_deepgram/`
- `core/src/tara/routes.js`
- `core/src/tara/stream-handler.js`
- `core/src/tara/session-analytics.js`
- `frontend/Da-vinci/.../pages/TaraConfig.jsx`

Verify browser voice, telephony, language behavior, call history, post-call
analysis, role/plan gates, and fresh errors. Provider credentials remain only
in runtime secrets.
