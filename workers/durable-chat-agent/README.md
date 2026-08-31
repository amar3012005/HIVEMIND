# Durable Chat Agent

Metadata-only Cloudflare session coordinator for HIVEMIND Chat V2. It mirrors
opaque turn lifecycle state so connections can recover while PostgreSQL remains
the authority for messages, prompts, memory/evidence packets, tool outputs,
citations, checkpoints, and final responses.

`durable_chat_agent_v1` is multivariate: `off`, `shadow`, `session`, `workflow`,
and `full`. The production environment master switch defaults to `false`.

The Worker contract deliberately rejects fields whose names could carry customer
content. Do not replace this Agent with `AIChatAgent`: its default resumable chat
implementation persists message and stream content in Durable Object SQLite.

## Ownership and recovery contract

- Core authenticates the user, resolves tenant/project scope, evaluates and
  latches the flag, and owns all semantic execution.
- PostgreSQL stores the complete request, ordered lifecycle events, checkpoint
  receipts, final response, and error state. Browser resume always goes through
  authenticated Core `/api/chat/turn-events`; the Worker secret is never exposed.
- The Agent Durable Object stores only turn ID, phase, status, sequence, a hashed
  trace ID, and timestamps. Cloudflare failure is non-blocking after local
  persistence, so it cannot delay or fail a chat answer.
- In `workflow` and `full`, Core starts the deterministic Workflow instance
  `chat-{turn_id}`. The Workflow waits for a `chat-terminal` event for up to
  seven days and returns only turn ID, terminal status/phase, sequence, and
  timestamp. Duplicate starts reuse the same instance; no semantic payload is
  accepted by the Workflow contract.
- Compound-turn continuations are authoritative in PostgreSQL. Only a SHA-256
  token digest is stored. Claiming is lease-fenced, invalid input releases the
  lease, successful settlement consumes it once, and an idempotency-key replay
  returns the already persisted response without rerunning tools.
- The existing Chat V2 planner and single authoritative recall/synthesis remain
  intact. Durable recovery is additive and bounded; there is no second answer
  synthesis loop and no hidden message history in Cloudflare.

Local resources use the `-local` Worker name and local Flagship targeting.
Production has an enabled infrastructure gate but remains fail-closed through
Flagship: the default variation is `off`, and only explicitly targeted canaries
enter a durable mode. The Core environment gate is a second independent kill
switch.

## Answer coverage contract

- Standard bounded answers expose at most the unified top five ranked records.
- Detailed and comprehensive answers expose at most the unified top fifteen.
- These are evidence-window ceilings, not fabricated minimums: fewer records are
  returned when fewer authorized, relevant records exist.
- Timeline, snapshot, diff, relationship, aggregate, project, exact-source, and
  ordinary recall operations retain their existing V2 semantics. Missing
  temporal or exact-source coverage fails closed rather than substituting nearby
  or current evidence.
- Filename stems can still be retrieved semantically without an extension; an
  unsupported requested facet is reported as a gap instead of being invented.
