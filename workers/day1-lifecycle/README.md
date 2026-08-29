# HIVEMIND Day-1 lifecycle

Cloudflare Workflow authority for the first autonomous company move:

1. Sleep until Day 1.
2. Ask the control plane to atomically claim and start a research-tagged task.
3. Wait for the real HyperAgent room seal event.
4. Ask the control plane to render the unchanged sealed output as a portrait report and send it through the existing Cloudflare Email Service path.

The Workflow stores no tenant report body and uses no R2 bucket. PostgreSQL remains the lifecycle authority.

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
