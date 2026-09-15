# Tool credit metering contract

## Scope

- Legacy `/api/chat` retains one credit per completed chat turn.
- A Harness turn with no executed tools settles one credit.
- A Harness turn with executed tools settles one credit per actual HIVE recall
  or Composio provider dispatch; it does not also settle the no-tool credit.
- Cached discovery, schema/meta calls, retries using the same operation key,
  cancelled work, and approval resumption do not create a second charge.

## Owners and source

This is a cross-service change. The required discovery base is
`singulance-main/singulance-main` at
`698eb74b5bdac41b69bf79cbece82466d8572b45`, but it does not own the deployed
Harness proxy. The production owner is the HIVE-MIND repository's deployed
`origin/singulance-main` revision
`1e656af26afe28daf28c5a70c85c97ca810bab46`; the durable receipt proxy is also
present in its Control revision `8ab9040bc1f99bc57c7b1b6ec82db1a8ed5b1d1a`.

Implementation must use new isolated worktrees, not overwrite either current
checkout:

| Owner | Required branch | Files |
| --- | --- | --- |
| HIVE Control/Core | `codex/tool-credit-metering-control` from `1e656af26…` | `core/src/routes/harness-chat.js`, `core/src/harness-chat/connected-app-receipts.js`, `core/src/billing/credit-catalog.js`, `core/src/billing/credit-service.js`, `core/src/control-plane-server.js` |
| Harness runner | `codex/tool-credit-metering-runner` from `origin/hivemind-chat` at `f1a44d04ff7c1f9aad1ff77a585b68e55bac899b` | `packages/hivemind/runtime/src/index.ts`, `packages/hivemind/connected-apps/src/index.ts` and their focused tests |

## First proven incorrect debit

`core/src/agent/compound-orchestrator.js` reserves
`composio_tool_call` for every Core-owned provider dispatch. Its catalog entry
in `core/src/billing/credit-catalog.js` prices that one unit at **2** credits.
That is the first proven boundary where one intended Composio request consumes
two credits. In contrast, a Harness direct `session.execute()` does not reach
this executor or the credit ledger, so it currently consumes zero credits.

The legacy chat path intentionally creates a chat-credit reservation and a
`searches` usage record. `CreditService.getSummary()` projects legacy chat from
the canonical search counter instead of adding the chat reservation, so this is
not a demonstrated customer-visible double debit. Do not change that projection
without a regression test.

## Patch shape

1. Change the catalog rate for `composio_tool_call` from two to one.
2. At the authenticated Harness receipt/proxy boundary, settle a Composio
   credit once per provider dispatch using a stable `session + call + dispatch`
   idempotency key. Receipt persistence itself must not make a second debit.
3. Have the runner report a completed Harness turn with its stable turn ID and
   dispatch count. Settle `chat_turn` only when that count is zero.
4. Preserve proxied `/api/recall` accounting as one HIVE credit per successful
   recall. Do not add a second Harness turn charge when recall executed.
5. Reject insufficient credit before provider dispatch, and release reservations
   for cancellation before dispatch.

## Acceptance checks

- 2 successful recalls plus 3 successful Gmail executions settle 5 credits.
- A completed Harness turn with zero dispatches settles exactly 1 credit.
- A Core compound Composio execution settles exactly 1 credit.
- Replayed call IDs, cached discovery, schema/manage/wait meta calls, cancelled
  work, and approval resume settle no duplicate credit.
- A credit limit reached between dispatches rejects the next dispatch without
  running it.
- Tenant/session mismatch cannot settle or reuse another owner's operation.
- Legacy `/api/chat` remains one displayed credit per completed turn.

Run the focused HIVE suites:

```sh
cd core && node --test tests/unit/billing.test.js tests/unit/account-billing-usage-contract.test.js \
  tests/unit/connected-app-receipts.test.js tests/unit/harness-chat-bootstrap.test.js \
  tests/unit/harness-chat-runner-service.test.js
```

Run the focused Harness runtime and connected-app tests that cover the new
dispatch counter and completion report.

## Release and rollback

This is cross-service: Harness runner plus Control/Core billing. It requires
the existing `ESCALATION_MANIFEST.json` Sol handoff and Astra review before a
production release. Do not use the incident-only divergence override.

Build immutable artifacts and recreate only affected services through the
governed release entrypoint. Roll back Control/Core using the governor's saved
per-service rollback image, and roll back the runner to immutable
`hivemind/harness-chat:sha-f1a44d04ff`; verify the authenticated Harness route
and credit totals after either rollback.
