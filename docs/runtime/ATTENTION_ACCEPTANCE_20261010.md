# Runtime attention acceptance checks

## Confirmed intake findings

- Native Slack routes verified workspace events to an explicitly bound organization. The connected-account owner is the routing principal, not automatically the message author.
- On the inspected production connection, both public `all-davinci-ai` and private `test` are bot-visible members; public and private history/read scopes are present. A missing private event therefore needs Slack `message.groups` subscription and delivery evidence, rather than an invented invitation requirement.
- Existing event leases persist transient decision/context failures as `pending`. Before this fix, recovery depended on a new webhook or opening connected activity; concurrent arrivals could miss their classifier kick, and only six events were attempted.
- Recovery now sweeps the same durable ledger, merges concurrent account scopes, and drains bounded batches. It does not introduce a second queue, a second classifier, or permission changes.
- Sender verification is narrow: native Slack `event.user` must exactly equal the stored OAuth `authed_user_id`, and that profile must remain an active organization owner/admin. Other authors remain unverified evidence. Recheck current authority before interpreting any signal as an instruction.

## Combined release acceptance

1. Preserve current mobile layout, security settings, image rollback identity, pending answers, calendar cards, and reset fix. Root owns the serialized cutover.
2. Post one fresh public Slack company scenario and one private scenario through the authorized browser. Capture upstream event, durable ledger identity, attention reason, native Inbox receipt, delegated task, employee artifact, accepted review and user notification. Missing upstream delivery is distinct from a retain decision.
3. For a verified direct admin request, preserve author provenance in the native decision state. An ambient signal remains evidence. Obvious promotions can remain quiet; ordinary company signals must not require a predefined goal.
4. Repeat one event identity and restart with a pending transient failure. Confirm one native admission and one final notification, no discarded pending signal, and recovery without a browser visit.
5. Run Gmail and saved Dreamer output through the same ledger and decision boundary. Check active connection, fresh activation window and persisted output receipt. Do not invent private-memory evidence or broaden Dreamer privacy.
6. Independently verify chat history reload, stable sent bubble, sidebar spinner/bell/calendar, fresh reset walkthrough, employee blocker pause/resume, and one saved nightly review occurrence with actual employee replies and detailed HTML delivery. Native acceptance is not business completion or email reading.

## Evidence to retain

For each scenario: source event identity and time, author verification outcome, attention reason/distribution, target native session, saved Inbox receipt, task/checkpoint identifiers, artifact revision, review decision and email delivery receipt. Never put credentials or raw provider diagnostics in user-facing chat.
