# Cloudflare Think Harness playbook

Use this after the `cordis-harness-platform` skill when changing `workers/task-agents`. The current Worker, room Durable Object, Workflow, local playbooks, and Core WorkRun ledger are the baseline. Preserve their behavior and deployment identities; apply focused changes on the current source branch. Never restore a whole older Worker or frontend tree to recover one feature.

## Boundaries

- The Durable Object owns room/session events and streams each accepted event immediately. Cloudflare Workflow owns durable task steps, retries, and terminal results. Core owns company WorkRun authority. The browser renders receipts; it does not infer success from model prose.
- A tool name in the transcript must correspond to an actual tool or runtime operation. For direct Workflow operations such as browser capture, emit one stable `tool-call` ID with started and returned/failed phases. The UI collapses those phases into one expandable row. Emit the start before awaiting slow I/O.
- The model may choose tools and plan work, but a completed artifact, exact source quote, connected write, or memory save needs a real receipt. Never announce one from an intention or a draft. Keep final synthesis behind required artifact/verification/governance receipts.
- A short direct answer should not pay for company-plan setup. For company tasks, load progressive context at the stage that uses it: identity, relevant company facts, matching local playbook, action skill, then cited evidence. Bound page text and preserve source URLs; do not accumulate entire pages in every model call.
- A tool validation/protocol error should get one repaired or stronger-model retry for that step from saved receipts, then a visible recoverable error. Avoid repeating identical invalid calls or restarting completed research. Reconcile uncertain external writes before retry.
- Private operating memory is separate from HIVEMIND company memory. It uses scoped, typed, idempotent records; a failed private-memory write is logged and may be reconciled, but cannot hold a delivered task open through long Workflow retries. Company-memory writes still require their authorization and receipt.

## Before deploying preview

1. Record the currently deployed Worker and frontend versions and current source commit. Inspect the diff for unrelated route, persona, tool, or room changes.
2. Run TypeScript and focused tests. Exercise a direct answer, a source-backed artifact, a direct browser operation, a failed tool, and a stopped/recovered run as relevant.
3. Deploy only the changed preview boundary with `--env preview` for task-agents. Do not deploy production by default. Keep the previous preview version for rollback.
4. In the authenticated browser, start a fresh canary. Verify the first progress/tool event appears while the operation is still running, the tool result is inspectable, the artifact is attached only after saving, and WorkRun reaches a terminal state promptly.
5. Use Workflow instance traces to compare step start/end/attempts. Aggregate token counts are not a single model request. If UI is silent, inspect event production, WebSocket delivery, transcript filtering, and scroll position separately.

## Regression lessons

- A direct `browser_capture` Workflow path once completed in about 12 seconds while the room showed only employee setup. The capture had no transcript tool event, so the UI could not display its in-flight operation. Instrument the boundary, not an artificial typing animation.
- A delivered image was followed by repeated `operating_memory_unavailable` attempts in `record-operating-memory`; the Workflow stayed running and rejected another room request. Nonessential memory persistence must not delay the terminal WorkRun.
- The Control log later identified `memory_idempotency_conflict`: an earlier stopped attempt saved `incomplete`, then a successful recovery tried to save `completed` under the same key. Outcome transitions are distinct private-memory events with distinct idempotency keys; replay of each event must retain its own receipt.
- The room UI optimistically displayed a new turn even when the Worker rejected `room-start` because prior work was active. A rejection must terminate that optimistic working state and expose recovery status.
- Preserve a user's existing FE session/room layout and Worker persona/tool contracts. Compare exact diffs and test a live room before promotion; a deployment UUID alone is not a source SHA.
