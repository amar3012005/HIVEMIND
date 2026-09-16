# Nightly memory batch

This Worker is the cost-control dispatcher for tenant-scoped knowledge/dream work.

- The hourly Cron invocation asks HIVEMIND for organizations currently inside their configured local night window.
- It puts only tenant/job identifiers on a Cloudflare Queue; source evidence never leaves core for the queue.
- Queue batching, retries, and a dead-letter queue absorb spikes without changing tenant isolation.
- Core remains authoritative for eligibility, idempotency, workflow state, and persistence. The existing durable dream lifecycle performs the entity walk, cross-entity synthesis, compression, and reconciliation.
- Configure `NIGHT_BATCH_SECRET` with `wrangler secret put NIGHT_BATCH_SECRET`; set the same value as `HIVEMIND_DREAM_WORKFLOW_SECRET` in core.
- Configure the ModelArk custom provider in AI Gateway and set `CLOUDFLARE_AI_GATEWAY_MODELARK_PROVIDER` only if the account uses a different slug. The default is `custom-byteplus-modelark`. Store the provider key in AI Gateway BYOK under alias `modelark` and set core's `CLOUDFLARE_AI_GATEWAY_BYTEPLUS_MODELARK_BYOK_ALIAS=modelark`.

The worker is intentionally not deployed by repository tests. Production deployment requires the governed release process and Cloudflare account approval.
