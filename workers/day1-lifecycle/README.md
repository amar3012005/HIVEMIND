# HIVEMIND Day-1 lifecycle

Cloudflare Queue + Workflow authority for the first autonomous company move.
This is the reusable lifecycle-admission pattern for future episodes; adapters
define their own control-plane endpoints, while this layer carries identifiers,
due time, retries, bounded launch concurrency, and receipts.

1. Admit an identifier-only lifecycle message to `hivemind-lifecycle-admission-v1`.
2. Let its Queue consumer launch at most ten room starts concurrently; delayed
   messages keep future work out of a hot Worker.
3. Atomically claim and start a research-tagged task through the Control Plane.
4. Use a Workflow for the long wait for the real HyperAgent room seal event.
5. Ask the Control Plane to render the unchanged sealed output as a portrait
   report and send it through the existing Cloudflare Email Service path.

The Queue and Workflow store no tenant report body and use no R2 bucket.
PostgreSQL remains the lifecycle authority. The Queue has explicit individual
acknowledgements, ten retries, and a DLQ (`hivemind-lifecycle-admission-dlq-v1`).
The five-minute reconciliation scans up to 500 eligible lifecycle receipts;
this is a recovery path, not the primary admission path.

## Release gates

The lifecycle is fail-closed behind two independent production gates:

1. Control Plane requires `HIVEMIND_D1_WORKFLOW_ENABLED=true` exactly. Missing values and every other spelling are disabled.
2. The Worker evaluates Cloudflare Flagship boolean `day1_first_move_v1` with `targetingKey` and `org_id` set to the organization UUID. Its fallback and default variation are `false`.

Keep the Flagship default off. Production activation must use an exact `org_id` canary rule; never change the default variation to on before canary acceptance. The Worker re-evaluates before instance creation, prepare, event delivery, and final delivery. The backend gate protects scheduling, reconciliation, prepare, event notification, and delivery if the edge configuration is wrong.

Required secret on both this Worker and the HIVE-MIND control plane:

`HIVEMIND_D1_WORKFLOW_SECRET`

Required control-plane variable:

`HIVEMIND_D1_WORKFLOW_URL=https://hivemind-day1-lifecycle.<workers-subdomain>.workers.dev`

Required backend master gate:

`HIVEMIND_D1_WORKFLOW_ENABLED=false`
