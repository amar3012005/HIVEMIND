# HIVEMIND Day-1 lifecycle

Cloudflare Workflow authority for the first autonomous company move:

1. Sleep until Day 1.
2. Ask the control plane to atomically claim and start a research-tagged task.
3. Wait for the real HyperAgent room seal event.
4. Ask the control plane to render the unchanged sealed output as a portrait report and send it through the existing Cloudflare Email Service path.

The Workflow stores no tenant report body and uses no R2 bucket. PostgreSQL remains the lifecycle authority.

Required secret on both this Worker and the HIVE-MIND control plane:

`HIVEMIND_D1_WORKFLOW_SECRET`

Required control-plane variable:

`HIVEMIND_D1_WORKFLOW_URL=https://hivemind-day1-lifecycle.<workers-subdomain>.workers.dev`
