# Phase 2 Manual Operations Checklist

Items that need clicks in dashboards / dev consoles / real OAuth apps —
the code is ready but production hookup is a human step.

---

## 1. Coolify dashboard env mirror (#13)

Mirror the runtime env vars from `/opt/HIVEMIND/.runtime/hm-core.env` into the
Coolify hm-core service's "Environment Variables" tab:

```
DOCLING_URL=http://docling:5001
ENABLE_DOCUMENT_FIRST_INGEST=true
ENABLE_EVIDENCE_RECALL=true
ENABLE_ENTITY_EXTRACTION=true
ENABLE_TOPIC_STATE=true
ENABLE_HYGIENE_CRON=true
ENABLE_MEMORY_PROMOTION_JOBS=true
ENABLE_CONTRADICTION_SCAN=true
ENABLE_MEMORY_SYNTHESIS=true
EVIDENCE_QDRANT_COLLECTION=hivemind_evidence
MEMORY_QDRANT_COLLECTION=BUNDB AGENT
SLACK_SIGNING_SECRET=<from Slack app>
GITHUB_WEBHOOK_SECRET=<from GitHub App>
LINEAR_WEBHOOK_SECRET=<from Linear>
JIRA_WEBHOOK_SECRET=<from Jira Connect>
CONFLUENCE_WEBHOOK_SECRET=<from Confluence Connect>
```

After save: redeploy via Coolify so future container restarts pick up env from dashboard.

---

## 2. Docling sidecar Coolify service (#12)

Currently running via `systemctl start hm-core.service` + `docker run` manual.
Add Docling as Coolify service:

- Service type: Docker Image
- Image: `ghcr.io/docling-project/docling-serve:latest`
- Hostname: `docling`
- Network: `hmtest`
- Resources: 2 CPU / 4 GB RAM
- Healthcheck: `curl -fsS http://localhost:5001/health`
- Env: `DOCLING_SERVE_HOST=0.0.0.0`, `DOCLING_SERVE_PORT=5001`, `OMP_NUM_THREADS=4`

Once managed by Coolify, `systemctl stop hm-core.service` and let Coolify
own both hm-core + docling.

---

## 3. Provider webhook registration (#14-17)

### Slack (manual app config)
1. https://api.slack.com/apps → DAVINCI AI → Event Subscriptions
2. Request URL: `https://core.hivemind.davinciai.eu:8050/webhooks/slack`
3. Subscribe events: `message.channels`, `message.groups`, `app_mention`
4. Signing Secret → copy to `SLACK_SIGNING_SECRET` env

### GitHub App
1. https://github.com/settings/apps → DAVINCI AI HIVEMIND
2. Webhook URL: `https://core.hivemind.davinciai.eu:8050/webhooks/github`
3. Webhook secret: generate + paste into `GITHUB_WEBHOOK_SECRET`
4. Permissions: `Issues:Read`, `Pull requests:Read`, `Metadata:Read`
5. Subscribe events: Issues, Pull request, Issue comment, Push

### Linear
- Automatic via adapter.registerWebhook() on Nango connect. Secret in
  `LINEAR_WEBHOOK_SECRET` env.

### Jira / Confluence (Atlassian)
1. https://developer.atlassian.com → your Connect app
2. Webhook → `https://core.hivemind.davinciai.eu:8050/webhooks/jira`
   and `.../webhooks/confluence`
3. Subscribe: `jira:issue_*`, `comment_*`, `page_*`
4. Shared secret → `JIRA_WEBHOOK_SECRET` / `CONFLUENCE_WEBHOOK_SECRET`

---

## 4. E2E smoke for each provider

```bash
# Slack
curl -X POST https://core.hivemind.davinciai.eu:8050/webhooks/slack \
  -H "X-Slack-Signature: v0=$(echo -n "v0:$(date +%s):..." | openssl dgst -sha256 -hmac $SLACK_SIGNING_SECRET)" \
  ...
# Quicker: post a real message in connected channel, watch hm-core logs:
ssh root@host "docker logs hm-core -f | grep -E 'webhook|Phase1'"
```

Expected: receiver 200 → processor pickup → `ingestConnectorRecord` →
`source_artifact` + `knowledge_segment` + `memory_evidence_link` rows.

---

## 5. Jira token rotation handling (#25)

Nango auto-refreshes Atlassian access tokens. If rotation fails:
- Symptom: `Jira accessible-resources 401`
- Action: in Nango admin → Connections → re-trigger OAuth for that user
- adapter's `_cloudIdCache` is in-memory; clears on container restart

---

## 6. Run audit + backup scripts

```bash
# Tenant isolation audit (#27)
node core/scripts/audit-tenant-isolation.js core/src

# Backup cursors before destructive ops (#28)
node core/scripts/backup-nango-cursors.js

# Legacy chunk cleanup (#10)
node core/scripts/cleanup-legacy-bundb-chunks.js --dry-run
# verify, then:
node core/scripts/cleanup-legacy-bundb-chunks.js --execute
```

---

## 7. New admin endpoints (post-deploy verification)

```bash
TOK="Bearer hmk_live_..."
curl -sk -H "$TOK" "https://core.hivemind.davinciai.eu:8050/api/admin/topic-states?limit=20"
curl -sk -H "$TOK" "https://core.hivemind.davinciai.eu:8050/api/admin/contradictions?limit=20"
curl -sk -H "$TOK" "https://core.hivemind.davinciai.eu:8050/api/admin/webhook-subscriptions/health"
curl -sk -H "$TOK" "https://core.hivemind.davinciai.eu:8050/api/admin/webhook-events/dead-letter?status=failed"
curl -sk -H "$TOK" "https://core.hivemind.davinciai.eu:8050/metrics" | head -30
```

---

## 8. Source-artifact blob backup (#11)

Set env on hm-core if using R2 / S3:
```
SOURCE_ARTIFACT_BUCKET=hivemind-artifacts
SOURCE_ARTIFACT_ENDPOINT=https://<account>.r2.cloudflarestorage.com
SOURCE_ARTIFACT_ACCESS_KEY=...
SOURCE_ARTIFACT_SECRET_KEY=...
SOURCE_ARTIFACT_REGION=auto
```

Service class instantiates on boot; current ingestion code does not yet
auto-invoke `backup()` — wire into `ingestKnowledgeDocument` / `ingestEnterpriseDocument`
as a follow-up if blob retention required.
