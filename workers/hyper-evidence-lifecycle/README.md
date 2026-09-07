# Hyper Evidence Lifecycle

Cloudflare Workflow boundary for a single Evidence Roundtable refill. The workflow receives only organization, user, room, turn, and evidence-job UUIDs. The control plane retains the research query, provider route, tenant connection state, and credentials.

Stages are durable and idempotent: prepare, acquire with bounded retries, then persist one digest-bound evidence receipt. Provider prose without URL receipts is rejected. This candidate is not deployed by the local shadow implementation.
