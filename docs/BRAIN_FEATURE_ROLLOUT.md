# Brain feature rollout contract

## Authority boundary

Cloudflare Flagship is the only authority for **product behaviour rollout**.
Core remains authoritative for identity, sessions, jobs, documents, evidence,
memories, citations, relationship rows, and final job settlement. PostgreSQL
and Qdrant are never replaced by a feature flag service.

Environment configuration is limited to secrets and deployment topology:

- credentials and signing material;
- database/vector/Redis connection details;
- protected Cloudflare Workflow transport credentials;
- immutable service addresses, resource limits, and operational timeouts.

It must not decide whether a customer receives a product capability. The
legacy `*_ENABLED`, canary-percent, and production-acknowledgement variables
are retired from a path only after its Cloudflare decision has an explicit
default and canary policy.

## Ingestion transport

Flag: `knowledge_ingest_workflow_v1`

1. Core asks the Workflow Worker to evaluate the tenant and user.
2. The decision is persisted on the knowledge job as either
   `cloudflare_workflow` or `bullmq` before any dispatch.
3. A selected Workflow job writes source bytes to R2 and sends only job
   identifiers to Cloudflare Queue/Workflow. Core remains the canonical
   extraction, chunking, embedding, evidence, memory, provenance, and
   settlement executor.
4. If Flagship admission or R2 source persistence is unavailable **before**
   Workflow start, Core changes the durable job to `bullmq` and uses the
   existing local raw-file queue with the same job identity.
5. Once `/start` has been attempted, Core never switches to BullMQ: an
   ambiguous network timeout might already have started the Workflow.

This makes Cloudflare Workflow the primary path for enabled tenants and BullMQ
the safe secondary path. It never allows two orchestrators to process one job
version. The same transport applies to `evidence` and `both`; ingest mode is
separately stored and cannot be changed while active.

## Connected sessions and chat

Composio Tool Router sessions are persisted in `governed_composio_sessions`
under the exact `(org_id, user_id, connection_scope)` key. A continuation
reuses its stored session ID after verifying its subject. Process-local caches
are an optimisation only; they are never authorization.

Flags:

| Flag | Default | Latching rule |
| --- | --- | --- |
| `use-tools-durable-agent` | off | store on the governed run before tool discovery |
| `enable-tools-hitl` | off | store on the pending action/turn before displaying approval |
| `chat_orchestrator_v2` | existing chat path | store selected variant on turn creation; streaming retries reuse it |
| `composio_session_primary_v1` | existing verified session path | store on governed run; no cross-user fallback |

Flag evaluation failure is off, never a hidden switch to a new chat or
connector path. `use_tools:false` remains a direct native chat path.

## Meeting Notes consent canary

The production Meeting Notes path remains unchanged until the new consent
integration has a separate Flagship flag:

`meeting_notes_consent_v2` — default **off** for every tenant, including
production. Enable only for a named dev/canary organization after verifying:

- an explicit, attributable consent receipt before recording or transcription;
- purpose, provider, and retention recorded with the session;
- revocation prevents further audio processing and is auditable;
- no consent state leaks across organizations or users.

The flag must be latched when a meeting session is created. A later flag
change cannot alter a live session's consent regime.

## Enigma promotion

Enigma stays under `dev.*` while the target organization allowlists are tested.
Promotion to a future production subdomain is a routing/release action, not a
code fork: deploy the exact signed, tested source image; move the Cloudflare
route and hostname configuration; then add the exact OAuth/OTP redirects for
the new hostname. The same feature definitions and per-tenant decisions travel
with the release.
