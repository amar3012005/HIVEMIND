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
- The existing Chat V2 planner and single authoritative recall/synthesis remain
  intact. Durable recovery is additive and bounded; there is no second answer
  synthesis loop and no hidden message history in Cloudflare.

Local resources use the `-local` Worker name and local Flagship targeting.
Production configuration has `DURABLE_CHAT_AGENT_ENABLED=false`; promotion is a
separate governed release after schema deployment and production canary approval.
