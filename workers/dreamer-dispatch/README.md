# Dreamer dispatch

This is the Cloudflare outer pipeline for DeepSeek Harness (DSH) scheduled work.
It does not discover entities, traverse the graph, call a model, or write HiveMind
memory. Each tenant has a separate SQLite Durable Object that owns its schedule
definitions and occurrence receipts. Its alarm creates due occurrences, a Queue
dispatches their opaque payloads to DSH, and DSH reports terminal status.

The Worker has no Core or Control Plane URL or binding. It is inert until
`DISPATCH_ENABLED=true` and the DSH endpoint and three secrets are configured.

## Contract with DSH

DSH registers a trigger through `PUT /v1/tenants/{tenantId}/triggers/{triggerId}`
with `Authorization: Bearer $SCHEDULER_ADMIN_TOKEN` and a JSON body:

```json
{
  "schedule": { "kind": "cron", "expression": "0 0 * * *", "timezone": "Europe/Berlin" },
  "payload": { "the": "exact DSH schedule-trigger payload" }
}
```

For a one-time trigger use `{"kind":"once","runAt":"2026-10-01T22:00:00+02:00"}`.
The ID and tenant must contain only letters, numbers, `_`, or `-` and be at
most 100 characters. DSH authenticates and authorizes the tenant before it
registers a schedule. Repeating an identical active registration is a no-op;
editing a trigger versions it and cancels occurrences that have not dispatched.
`DELETE` on the same trigger URL cancels future occurrences. `GET
/v1/tenants/{tenantId}/status` shows recent schedules and receipts without
returning DSH payloads.

At the scheduled time the Worker POSTs the registered **payload unchanged** to
the fixed `DSH_TRIGGER_URL`, with:

- `Authorization: Bearer $DSH_DISPATCH_TOKEN`
- `Idempotency-Key: {tenantId}:{triggerId}:{logicalDueAtMillis}`
- `X-Hivemind-Tenant-Id`, `X-Hivemind-Trigger-Id`,
  `X-Hivemind-Occurrence-Id`, `X-Hivemind-Scheduled-At`, and
  `X-Hivemind-Trigger-Version`.

DSH must authenticate this call, validate tenant scope, use the idempotency key
to return the **same DSH workflow run** on a duplicate call, and return JSON
containing `runId` (or `workflowId`/`id`) when the run is durably accepted.
A retry can follow an HTTP timeout even if DSH started work. Without DSH-side
idempotency, duplicate work cannot be ruled out.

DSH calls `POST /v1/tenants/{tenantId}/occurrences/{occurrenceId}/terminal`
with `Authorization: Bearer $DSH_CALLBACK_TOKEN` and
`{"status":"completed","runId":"...","receiptId":"..."}` (or
`"failed"`). The callback carries an identifier, not report or memory content.
The occurrence remains `accepted` until this callback; after 24 hours it
becomes `needs_reconciliation`, which can still be completed by a late callback.
The DSH `runId` must match the accepted run if one was recorded.

## Durability and scope

- Per-tenant Durable Object alarms drive schedules without a global tenant scan.
  Cron is five-field and uses the supplied IANA timezone. Delayed alarms backfill
  missed logical due times in bounded batches of 100.
- Each occurrence ID is deterministic. Queue messages contain only tenant and
  occurrence IDs; the DSH payload is read from that tenant's Durable Object.
- Queue consumers claim a 60-second lease before dispatch. Replays of accepted
  or terminal occurrences are acknowledged. Failed dispatches retry and go to
  the configured dead-letter queue after the retry limit; the occurrence records
  `dispatch_failed`. A late DSH callback can still reconcile that outcome.
- An accepted DSH workflow's internal entity batches, reasoning, validation,
  and memory writes are DSH's responsibility. Cloudflare only stores its dispatch
  and completion receipts.

## Provisioning

Create the primary and dead-letter Queues named in `wrangler.jsonc` for the
chosen environment. Set `SCHEDULER_ADMIN_TOKEN`, `DSH_DISPATCH_TOKEN`, and
`DSH_CALLBACK_TOKEN` as Worker secrets; each should be a distinct random value
of at least 24 characters. Set the fixed HTTPS `DSH_TRIGGER_URL` through the
deployment configuration and enable `DISPATCH_ENABLED` only after the DSH
endpoint implements the contract. The preview environment uses separate Queue
names and Durable Object instances. There is no production deployment in this
change.

Before enabling dispatch, register one one-time preview trigger, confirm one
DSH `runId` despite a duplicate Queue delivery, complete it through the signed
callback, then repeat with a transient DSH failure and with two different
tenants. Use the status endpoint to inspect the occurrence trail.
