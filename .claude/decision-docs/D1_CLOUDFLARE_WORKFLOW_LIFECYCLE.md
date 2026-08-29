# Day-1 HyperAgent First-Move Lifecycle With Cloudflare Workflows

_Decision status: accepted; implementation deployed but production activation not yet canaried_  
_Last updated: 2026-08-29_  
_Owner boundary: Cloudflare Workflows coordinates time; HIVEMIND remains execution and data authority_

## 1. Executive decision

Day 1 is the first proof that HIVEMIND is not another empty workspace the user must operate manually.
After Day-0 onboarding and its report email, HIVEMIND waits until Day 1, selects the company's pending
research-tagged starter task, starts a real HyperAgent room turn, waits for the canonical sealed output,
and emails that exact output back to the workspace owner as both:

1. a branded HTML email; and
2. an attached A4 portrait PDF rendered with the existing README-style report renderer.

Cloudflare Workflows is the durable clock and retry coordinator. It does **not** execute the research,
own tenant data, rewrite the report, or become a second system of record. PostgreSQL, Control Plane,
Employees, the room turn, and the seal remain authoritative.

The first release deliberately does **not** persist the PDF to R2. The email attachment is rendered at
delivery time and sent through the existing Cloudflare Email Service integration. This keeps the first
activation lifecycle small, auditable, and aligned with the product promise: real completed work, not a
second feature announcement.

## 2. Product experience

### Day 0

The user completes onboarding. HIVEMIND:

- researches and records company context;
- hires the initial HyperAgents;
- creates the company HQ and permanent domain rooms;
- creates one pending starter task for every specialist domain;
- shows the completed onboarding view;
- sends the existing Day-0 onboarding email and portrait report.

The accepted Day-0 email receipt is the boundary that schedules Day 1. If the immediate handoff to
Cloudflare fails, the Worker's 15-minute reconciliation cron can discover the same eligible company from
persisted PostgreSQL state.

### Day 1

The desired user-facing idea is:

> Your HyperAgents worked while you slept.

The lifecycle:

1. Wait until 24 hours after `company.onboarded_at`.
2. Select the first `todo` starter task whose room tag is `research`.
3. Create or reuse one deterministic task work room and one deterministic kickoff turn.
4. Dispatch that turn through the existing Employees room execution seam.
5. Let the normal HyperAgent room execute, use tools, debate, and synthesize.
6. Wait for the normal canonical `seal` event and a persisted `complete` turn.
7. Read the final sealed room output without asking another model to summarize or rewrite it.
8. Render the room's existing README-style Markdown into the email and A4 portrait report.
9. Send the message through the existing Cloudflare Email Service provider.
10. Persist the delivery receipt and make retries return the already-sent result.

The room remains available in the product. The email links back to:

```text
https://next.singulancelabs.com/hivemind/app/employees/rooms/<room-id>
```

## 3. Architecture and authority boundaries

```text
Day-0 email accepted
        |
        v
Control Plane schedules deterministic Workflow instance
        |
        v
Cloudflare Workflow sleeps until Day 1
        |
        v
POST /internal/lifecycle/day1/prepare
        |
        v
PostgreSQL claims company + creates/reuses room turn
        |
        v
Employees executes the real HyperAgent room
        |
        v
Control Plane persists events and canonical seal
        |
        +---- POST Worker /event (wake signal only)
        |
        v
Workflow calls /internal/lifecycle/day1/deliver
        |
        v
Control Plane re-reads sealed turn from PostgreSQL
        |
        +---- render email HTML
        +---- render A4 portrait PDF via hm-playwright
        +---- send via Cloudflare Email Service
        |
        v
Persist provider receipt in company.day1_first_move
```

### Cloudflare owns

- the 24-hour durable sleep;
- workflow instance state;
- retry timing;
- buffering the room-completed wake event;
- the 15-minute reconciliation cron;
- transactional email transport through the existing email provider integration.

### HIVEMIND owns

- tenant identity and authorization;
- company and starter-task state;
- room selection and creation;
- HyperAgent execution;
- tool calls and research;
- turn lines, final report, and canonical seal;
- exactly-once delivery claim;
- email/report rendering;
- provider delivery receipt.

### PostgreSQL remains canonical

Cloudflare never receives the full research report during scheduling or waiting. The Workflow carries only:

```json
{
  "org_id": "uuid",
  "hq_room_id": "uuid",
  "target_at": "ISO-8601 timestamp"
}
```

The final report leaves Control Plane only as the requested email and PDF attachment. No new copy is saved
to R2 in this version.

## 4. Implemented code

### Backend lifecycle module

File: `core/src/lifecycle/day1-first-move.js`

Responsibilities:

- bearer authentication for internal D1 endpoints;
- research-task detection and selection;
- deterministic Workflow scheduling;
- cron reconciliation eligibility;
- deterministic room/turn creation and kickoff;
- room-completion event notification;
- final sealed output extraction;
- safe README-style Markdown rendering;
- branded Day-1 email rendering;
- A4 portrait report rendering;
- Playwright PDF generation through the existing internal service;
- Cloudflare Email Service delivery;
- persisted exact-once delivery state.

Important invariants:

- the report is taken from `final_report` first;
- executable HTML in Markdown is escaped;
- the output is not re-synthesized;
- delivery refuses a turn that is not both `sealedAt` and `status = complete`;
- an atomic database lease prevents concurrent retries from sending duplicate email;
- a sent receipt makes all later retries no-ops.

### Control Plane integration

File: `core/src/control-plane-server.js`

Internal endpoints:

```text
POST /internal/lifecycle/day1/eligible
POST /internal/lifecycle/day1/prepare
POST /internal/lifecycle/day1/deliver
```

These endpoints are service-token-only. Browser cookies, generic API keys, and ordinary sessions cannot
start complimentary autonomous work or send lifecycle mail.

The Day-0 email path schedules D1 only after its provider receipt is persisted. The room event path notifies
the Workflow only after the ordinary turn-event handler reaches the canonical `seal` boundary.

### Cloudflare Worker and Workflow

Directory: `workers/day1-lifecycle/`

Worker name:

```text
hivemind-day1-lifecycle
```

Worker URL:

```text
https://hivemind-day1-lifecycle.amarsai2005.workers.dev
```

Endpoints:

```text
POST /start   create or recover the deterministic D1 instance
POST /event   send the buffered room-completed event
GET  /status  inspect a Workflow instance
```

Cron:

```text
*/15 * * * *
```

Workflow instance IDs are deterministic:

```text
d1-<hq-room-id>
```

This prevents page refreshes, repeated Day-0 callbacks, and the reconciliation cron from creating parallel
Day-1 executions for the same company.

Workflow behavior:

- sleep until `target_at`;
- retry prepare up to eight times with exponential delay;
- wait for `room-completed` for up to 12 hours;
- reconcile from persisted turn state after an event timeout;
- retry delivery up to 24 times at two-minute intervals;
- treat invalid identity, missing company, and missing research task as non-retryable contract failures.

Cloudflare Workflows buffers an event that arrives before `waitForEvent`, so a fast research room cannot lose
its completion signal. Delivery still re-reads PostgreSQL and refuses unsealed output, so the event is a wake
signal rather than proof of completion.

## 5. Persisted lifecycle state

State is stored under the HQ room's existing company JSON:

```text
hyper_rooms.agent_connectors._company.day1_first_move
```

Representative progression:

```text
absent
  -> preparing
  -> running
  -> completed
  -> sending
  -> sent
```

Failure can transition to `failed`; a later reconciliation may retry after the sending lease expires.

Relevant fields include:

```json
{
  "version": "day-1-first-move-v1",
  "status": "running",
  "workflow_instance_id": "d1-<hq-room-id>",
  "task_id": "t8",
  "room_id": "uuid",
  "turn_id": "uuid",
  "claimed_at": "ISO timestamp",
  "started_at": "ISO timestamp",
  "completed_at": "ISO timestamp",
  "delivery_claimed_at": "ISO timestamp",
  "sent_at": "ISO timestamp",
  "provider": "cloudflare",
  "delivery_status": "accepted-or-provider-status",
  "message_id": "provider message id",
  "complimentary": true
}
```

## 6. Security model

The Worker and Control Plane share one dedicated secret:

```text
HIVEMIND_D1_WORKFLOW_SECRET
```

The Control Plane also receives:

```text
HIVEMIND_D1_WORKFLOW_URL
```

Security rules:

- the secret is never committed;
- both Worker and backend compare an `Authorization: Bearer ...` value;
- backend comparison is timing-safe;
- identifiers are validated as UUIDs;
- internal endpoints are mounted before browser SSO but remain inaccessible without the dedicated token;
- the email recipient is loaded from the authoritative workspace owner record;
- report HTML escapes untrusted room Markdown;
- the Workflow carries identifiers and timestamps, not tenant report contents.
- backend execution requires the exact master gate `HIVEMIND_D1_WORKFLOW_ENABLED=true`;
- Worker execution requires Cloudflare Flagship `day1_first_move_v1=true` for the exact organization context;
- both gates default off and either gate independently stops new execution;
- production rollout uses an exact `org_id` canary rule while the flag's default variation remains off.

## 7. Idempotency and retry design

There are four independent deduplication layers:

1. **Workflow instance**: `d1-<hq-room-id>`.
2. **Task turn**: `day1-<hq-room-id>-<task-id>` idempotency key.
3. **Persisted lifecycle state**: stores selected task, room, turn, and Workflow instance.
4. **Delivery lease**: an atomic PostgreSQL `UPDATE ... RETURNING` claims `sending`; a valid lease rejects a
   concurrent sender, while a lease older than ten minutes can be recovered.

The provider receipt is written only after Cloudflare accepts delivery. If the process fails after provider
acceptance but before receipt persistence, exactly-once delivery cannot be mathematically guaranteed without a
provider-side idempotency key. The current design minimizes this window and prevents ordinary Worker retries
from duplicating sends. A future provider API that accepts an idempotency key should use the D1 turn ID.

## 8. Email and report contract

Subject theme:

```text
Day 1 - Your HyperAgents completed <research task>
```

Hero message:

```text
Your HyperAgents worked while you slept.
```

The email and PDF must both contain the exact final room report. Allowed transformation is presentation only:

- Markdown headings become styled headings;
- lists, emphasis, links, quotes, and code are rendered;
- unsafe HTML is escaped;
- line wrapping and pagination may change;
- words, claims, citations, and conclusions are not rewritten.

The PDF uses `@page { size: A4 portrait; margin: 0 }` and is rendered by `hm-playwright`. The generated bytes
are attached directly to the outgoing email and are not saved to R2.

## 9. Validation completed before merge

Feature commit:

```text
922248e0 feat: automate Day 1 research lifecycle
```

Feature merge:

```text
aa049779 Merge pull request #654 from amar3012005/codex/d1-cloudflare-workflow
```

Validated locally:

- 20 focused lifecycle, room-route, transactional-email, and welcome-dispatch tests passed;
- Day-1 task selection selects research rather than a generic todo;
- prepare retry reuses the same room turn and dispatches once;
- final report extraction is verbatim;
- README renderer escapes executable HTML;
- email and report contain the exact output;
- report declares A4 portrait;
- Worker TypeScript check passed;
- Wrangler deployment dry-run passed.

## 10. Production state at the 2026-08-29 stop point

This section is deliberately exact so another session does not repeat or assume work.

### Completed

- PR `#654` is merged into `singulance-main`.
- Production Core, Control Plane, and Employees run canonical SHA:

  ```text
  701a0504391764763cf479306db839b305c8320a
  ```

  That SHA contains the D1 merge plus PRs `#655`, `#656`, and `#657`.
- All three coupled containers passed canonical release health verification.
- Cloudflare Worker `hivemind-day1-lifecycle` is deployed.
- Initial Worker deployment version was:

  ```text
  5400eb12-deb0-44e4-8e9c-6d64e566077e
  ```

- The `*/15 * * * *` trigger and `hivemind-day1-lifecycle` Workflow binding are deployed.
- A 64-character shared secret is stored in Cloudflare and `/root/hivemind/.env`.
- An authenticated Worker request returned `400 instance_id_required` rather than `401`, proving the two stored
  secret values match.
- `/root/hivemind/.env` also contains `HIVEMIND_D1_WORKFLOW_URL`.

### Intentionally not completed

- No Workflow instance has been started.
- No production research task has been auto-run.
- No D1 email has been sent.
- No customer state was used as a canary.

### Remaining production wiring

At the stop point, `hm-control` was healthy but its container environment contained zero
`HIVEMIND_D1_WORKFLOW_*` variables. The host `.env` was updated **after** the canonical container release, so
Control Plane must be recreated through the canonical release flow before D1 can schedule or authenticate.

The Worker configuration also currently declares:

```text
HIVEMIND_CONTROL_URL=https://admin.hivemind.singulancelabs.com
```

That host is the frontend/admin route, not the documented Control Plane API route. Before starting a canary,
the next session must verify routing and change the Worker variable to the Control Plane host, expected to be:

```text
https://api.singulancelabs.com
```

Do not start a D1 instance until both points are corrected and verified.

## 11. Exact remaining checklist for the next session

### A. Correct and redeploy Worker configuration

1. Confirm `/internal/lifecycle/day1/eligible` is reachable through `https://api.singulancelabs.com` and routes
   to `hm-control`.
2. Change `HIVEMIND_CONTROL_URL` in `workers/day1-lifecycle/wrangler.jsonc` from the admin host to the verified
   API host.
3. Run:

   ```bash
   cd workers/day1-lifecycle
   npm run check
   npx wrangler deploy --dry-run
   npx wrangler deploy
   ```

4. Preserve the existing `HIVEMIND_D1_WORKFLOW_SECRET`; do not rotate only one side.
5. Verify unauthenticated Worker access returns `401` and authenticated access reaches validation (`400` for
   a deliberately incomplete request).

### B. Recreate the coupled backend services canonically

Use the current merged `singulance-main`, never the dirty root checkout:

```bash
ssh singulance '/root/quick-deploy.sh singulance-main'
```

The canonical release deploys `core,control-plane,employees` together. After release, verify:

```bash
docker inspect hm-control --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -E '^HIVEMIND_D1_WORKFLOW_(SECRET|URL)=' \
  | sed -E 's/=.*/=<configured>/'
```

Expected count: `2`. Never print the secret value.

Also verify the three container revision labels match the same canonical SHA and each is healthy.

### C. Verify internal endpoint auth before autonomous work

Using the production secret from the host, call the Control Plane endpoint with a harmless eligible request:

```text
POST https://api.singulancelabs.com/internal/lifecycle/day1/eligible
```

Expected:

- without bearer: `401`;
- with bearer: `200` and `{ "companies": [...] }`;
- no research turn is created by this read/reconciliation-source endpoint.

### D. Select a controlled canary

Do not blindly use the first eligible customer. Select one explicitly authorized workspace owned by the user
or a disposable production canary organization. Confirm before starting:

- Day-0 email state is `sent`;
- company has exactly one intended pending research starter task;
- task detail is appropriate for autonomous complimentary work;
- owner email is the intended canary recipient;
- no `day1_first_move.status = sent` receipt already exists.

### E. Start and observe one canary

Start `/start` with `target_at` set to the current time for the canary only. Observe without inventing success:

1. Workflow instance becomes running.
2. `day1_first_move` stores the Workflow, task, room, and turn IDs.
3. One room and one kickoff turn exist.
4. Employees accepts the dispatch.
5. Turn events accumulate.
6. Turn reaches `status = complete` and has `sealed_at`.
7. `final_report` exists and its hash/length are recorded for comparison.
8. Workflow receives or reconciles the completion event.
9. Delivery lease moves `completed -> sending -> sent`.
10. Cloudflare returns a provider message ID/status.
11. The received email contains the same report text.
12. The PDF is portrait, opens successfully, and contains the same report text.
13. The email room link opens the exact source room.
14. A repeated `/start` or delivery retry does not create another turn or send another email.

### F. Record evidence

The release is complete only when the handoff records:

- merged SHA;
- Worker version;
- Workflow instance ID;
- org/HQ/task/room/turn IDs (internal evidence only);
- turn seal timestamp;
- final report hash and length;
- provider and message ID;
- persisted `sent` receipt;
- duplicate retry result;
- relevant health/log excerpts with secrets and personal data redacted.

## 12. Failure handling and operations

### Day-0 handoff fails

The 15-minute Worker cron asks Control Plane for eligible companies and creates the same deterministic instance.

### Worker prepare call fails transiently

Workflow retries eight times with exponential backoff. The deterministic turn key prevents repeated kickoff.

### Room runs longer than 12 hours

The event wait times out, then delivery re-reads PostgreSQL. If the turn is not sealed, delivery returns a
retryable conflict and continues retrying.

### Room seals as failed

Control Plane persists `day1_first_move.status = failed` and sends a failed completion event. The Workflow does
not send a success report.

### PDF rendering fails

Email is not sent without the requested portrait attachment. State becomes failed and remains observable.

### Email provider rejects delivery

State becomes failed with a bounded failure reason. The sending lease allows later recovery.

### Worker event notification fails

Delivery can still recover after the wait timeout because PostgreSQL seal state is authoritative.

### Secret mismatch

Calls fail closed with `401`. Rotate both Worker and `/root/hivemind/.env`, then canonically recreate
`hm-control` before resuming.

## 13. Observability recommendations

For the first canary, correlate by:

- Workflow instance ID;
- HQ room ID;
- D1 room ID;
- turn ID;
- provider message ID.

After the canary, add a platform-admin lifecycle panel showing counts by state:

```text
scheduled | preparing | running | completed | sending | sent | failed
```

Alerts should focus on:

- Workflow error rate;
- prepare retries exhausted;
- rooms running longer than the accepted SLA;
- missing final reports at a seal;
- delivery leases older than ten minutes;
- email permanent bounces;
- cron-eligible companies with an existing terminal Workflow instance that cannot be restarted.

## 14. D2-D7 product lifecycle direction

Do not implement D2-D7 until the D1 canary proves the complete lifecycle. Reuse the same architecture rather
than creating separate timers or frontend automations.

Recommended progression:

| Day | User value | Suggested owner room | Delivery |
|---|---|---|---|
| D0 | Company understood, team hired, first tasks prepared | HQ | Onboarding email + portrait report |
| D1 | Highest-risk market/company assumption researched | Research | Exact sealed report + source room |
| D2 | One evidence-backed audience/ICP decision | Marketing or Research | Decision brief |
| D3 | One qualified growth experiment prepared | Marketing/Campaign | Approval-ready experiment brief |
| D4 | One product or journey priority validated | Product/Design | Priority brief with acceptance signals |
| D5 | One bounded prospect set prepared, no unapproved outreach | Outreach | Reviewable prospect set |
| D6 | Cross-room synthesis of findings and contradictions | HQ | Weekly operating synthesis |
| D7 | Human checkpoint: approve, change, pause, or scale | HQ | Interactive weekly review |

Rules for all future days:

- every action must use a real room lifecycle;
- every outbound action remains authority-gated;
- email reports link to source rooms and artifacts;
- sealed persisted state is proof, not Worker chronology;
- retries are deterministic and idempotent;
- the user can pause the lifecycle;
- avoid daily noise when there is no meaningful completed work;
- do not send a rewritten marketing summary when a canonical artifact already exists.

## 15. Non-goals for the first release

- No Kubernetes requirement.
- No Cloudflare Container for room execution.
- No Durable Object as a second company database.
- No R2 archive of every report.
- No new report-generation LLM pass.
- No mass email campaign system.
- No autonomous external outreach.
- No replacement of PostgreSQL, Qdrant, Employees, or room seal contracts.

## 16. Definition of done

### Local cloud canary evidence (2026-08-29)

The isolated `hivemind-day1-lifecycle-local` Workflow completed an end-to-end
canary against the preview control plane with the development Flagship app.
It recovered the already-sealed HyperAgent turn instead of creating a new room
or turn, rendered the attachment through the canonical Day 0 `hm-playwright`
PDF service, and received a Cloudflare Email provider receipt. Repeating the
same deterministic Workflow start returned the completed instance and the same
receipt, with no second delivery. The persisted output evidence was 4,831 bytes
with SHA-256 `3e4912694bd0a7987b5d0cbd07b32a53ad31a7ce798258f7cd79465feef90c04`.

This proves the local/preview path only. It does not satisfy production
acceptance and does not authorize changing the production Flagship default.

D1 is done only when one controlled production canary proves all of the following:

- correct company selected;
- correct pending research task selected;
- exactly one room kickoff turn created;
- real HyperAgent execution completed;
- canonical turn sealed;
- exact final output rendered in email and portrait PDF;
- Cloudflare accepted delivery;
- recipient received and opened a valid report;
- source room link resolves;
- PostgreSQL stores the sent receipt;
- duplicate retry produces no second turn and no second email;
- no R2 report object was created;
- all three coupled backend services remain healthy at one canonical SHA.

Until this evidence exists, describe the implementation as **deployed but not production-accepted**.
