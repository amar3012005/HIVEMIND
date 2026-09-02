# Runtime Event Ingress Canary Contract

This directory intentionally contains no deployed Worker until the Core wake
truth release has completed 24 hours with clean duplicate and no-op metrics.

The future Worker is an ingress adapter only. It may authenticate a provider
webhook, validate its minimal envelope, and enqueue exactly:

```json
{ "outbox_id": "uuid", "provider": "provider-name", "external_event_id": "provider-event-id" }
```

The consumer calls a service-token-only Core endpoint with `outbox_id`. Core
re-reads the PostgreSQL outbox row, deduplicates the provider event, appends the
canonical Runtime event, and creates the material-cause wake. Queue redelivery
is therefore harmless.

The Worker and Queue must never receive transcripts, artifacts, campaign
content, credentials, authority state, task state, or playbook transitions.
Cloudflare Workflows may later coordinate an admitted non-authoritative edge
job through Core claim/reconcile endpoints. A repeated admission must map to
the existing PostgreSQL `edge_job_id`; PostgreSQL remains the provider-action,
checkpoint, approval, and completion authority.
