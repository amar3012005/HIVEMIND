# Connector Runtime V1 — Phase 3: Safety pipeline + Gmail writes

**Status: PASS (34/34, real `hm-core` Node v20).** Additive; still nothing
existing imports the runtime. Reuses ajv, the `pending_writes` table, and the
existing `AuditLogger` — no new subsystems.

## What shipped (new files under `core/src/connectors/runtime/`)

| File | Role | Reuse |
|---|---|---|
| `input-validator.js` | ajv validate + coerce + strip-undeclared + defaults | existing `ajv`/`ajv-formats` dep |
| `policy-engine.js` | authorize hook: role floor + read-only-surface/write block | — (new, thin) |
| `approval-hash.js` | `stableJson`/`hashArgs`/`idempotencyKeyFor`/`draftTtlMs` | **ported verbatim** from `draft-approval.js` (single source; chat delegates here at Phase 8) |
| `approval-store.js` | `gateWrite` + `executeApproved` over `pending_writes` | existing `PendingWrite` table + formulas |
| `runtime-audit.js` | audit hook (fail-closed on completed writes) + metrics hook | existing `AuditLogger` (injected) |

Plus: Gmail plugin extended with 3 write tools (`gmail__create_draft`,
`gmail__send_draft`, `gmail__send`) mapping to legacy `runGoogleTool`; runtime
gained `executeApproved()` + real hook wiring in `buildDefaultHooks`.

## Full pipeline now live (plan §4)

`validateContext → resolve(+legacy alias) → flag-gate → surface-check →
authorize(role/read-only) → getConnection → validateInput(ajv) →
gateWrite(approval+idempotency) → acquireSlot → execute(deadline) →
classifyError → normalize → truncate → audit(fail-closed) → metrics`

## Acceptance (plan §8 Phase 3) — all met, real execution

- **Read executes immediately** — no approval, provider called once.
- **Write creates one approval** — `gmail__send` → `approval_required` with `{id,summary,expiresAt}`, provider **NOT** called, exactly one `pending_writes` row (status `draft`).
- **Tampered approval arguments fail** — approve-execute replays the **stored** validated args only; a corrupted `toolArgs` (hash ≠ `argsHash`) → `forbidden`, provider not called.
- **Double approval sends once** — concurrent `executeApproved` → atomic `updateMany` claim (`count===1`) → one `completed`, one `forbidden`; provider invoked exactly once.
- **OAuth credentials never leak** — `ya29.…` / `Bearer …` redacted from any error output.

## Additional invariants proven

- **ajv:** missing required arg → `invalid_input`, provider not called; undeclared props stripped; `"7"`→`7` coerced; declared defaults (`markdown:false`) applied **and persisted** with the approved draft.
- **Idempotency:** same write twice while pending → same approval id, one row (unique `idempotencyKey`).
- **Formula parity (drift guard):** a test pins the runtime `idempotencyKey` to the exact `draft-approval.js` string — the two implementations can never silently diverge while both exist.
- **Policy:** role floor enforced (viewer denied a `minimumRole:manager` tool; admin allowed).
- **Audit fail-closed:** a completed write whose audit sink throws renders `failed` (never reports success without an audit trail). Caught adversarially — the first implementation fired audit without `await`, leaking an unhandledRejection; fixed to await + propagate for completed writes only (approval_required/reads log-and-continue).

## Deliberately deferred

- Wiring `approval_required` → the FE `draft_created` card, and pointing `draft-approval.js` at `approval-hash.js` (deleting its inline copies) — that is the **Phase 8 Chat cutover**, behind `CONNECTOR_RUNTIME_CHAT`. Until then chat is untouched.
- Capability-token verification in `authorize` — Phase 5.
- Audit-**before**-irreversible-execute (true two-phase) — hardening note; current fail-closed is report-level.

## Next

Toolkit build is now read+write complete with the full safety pipeline. Per the
user's redirect, pausing the connector runtime here and switching to
**phase-rosemary** (production chat/recall/ingestion root-cause fixes). Connector
Phases 4–11 resume after rosemary.
