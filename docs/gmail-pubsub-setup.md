# Gmail Pub/Sub Real-time Watch Setup

One-time GCP setup so HIVEMIND receives push notifications when users' Gmail inboxes change. No more polling.

---

## Architecture

```
Gmail change
   ↓
Gmail API publishes to GCP Pub/Sub topic
   ↓
Pub/Sub push subscription
   ↓
POST https://core.hivemind.davinciai.eu:8050/api/connectors/gmail/pubsub-webhook
   ↓
HIVEMIND triggers incremental sync via Gmail history API
   ↓
New threads ingested as memories
```

Watches expire after **7 days** — auto-renewed by HIVEMIND cron.

---

## Prerequisites

- GCP project owning the HIVEMIND OAuth client (same project, e.g. `hivemind-prod`)
- `gcloud` CLI installed + authenticated as a project owner
- Cloud project: `gcloud config set project hivemind-prod`

---

## Step 1: Enable Pub/Sub API

```bash
gcloud services enable pubsub.googleapis.com
```

---

## Step 2: Create the Pub/Sub topic

```bash
gcloud pubsub topics create gmail-changes
```

Topic full name will be:
```
projects/hivemind-prod/topics/gmail-changes
```

---

## Step 3: Grant Gmail permission to publish to your topic

Gmail's system service account is `gmail-api-push@system.gserviceaccount.com`. Give it Publisher on this topic only.

```bash
gcloud pubsub topics add-iam-policy-binding gmail-changes \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
```

---

## Step 4: Create a push subscription pointing at HIVEMIND

Pub/Sub will POST every notification to your webhook with a signed OIDC token.

```bash
gcloud pubsub subscriptions create gmail-changes-sub \
  --topic=gmail-changes \
  --push-endpoint="https://core.hivemind.davinciai.eu:8050/api/connectors/gmail/pubsub-webhook" \
  --push-auth-service-account="hivemind-pubsub@hivemind-prod.iam.gserviceaccount.com" \
  --push-auth-token-audience="https://core.hivemind.davinciai.eu:8050/api/connectors/gmail/pubsub-webhook" \
  --ack-deadline=20 \
  --message-retention-duration=1d \
  --expiration-period=never
```

> First create the service account `hivemind-pubsub@…iam.gserviceaccount.com` if it doesn't exist:
> ```bash
> gcloud iam service-accounts create hivemind-pubsub \
>   --display-name="HIVEMIND Pub/Sub Push Caller"
> ```

---

## Step 5: Set HIVEMIND env vars

Add to the core container `.env`:

```bash
GCP_PUBSUB_TOPIC="projects/hivemind-prod/topics/gmail-changes"
GCP_PUBSUB_AUDIENCE="https://core.hivemind.davinciai.eu:8050/api/connectors/gmail/pubsub-webhook"
CRON_TOKEN="<random 32-char string for watch renewal cron auth>"
HIVEMIND_PUBLIC_URL="https://core.hivemind.davinciai.eu:8050"
```

Restart core after setting:
```bash
bash scripts/deploy.sh core
```

---

## Step 6: Trigger watch registration

After a user completes Gmail OAuth, HIVEMIND auto-registers a watch via `registerWatch()`. To re-register manually:

```bash
curl -X POST https://core.hivemind.davinciai.eu:8050/api/connectors/gmail/watch/register \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"labels": ["INBOX"]}'
```

Response:
```json
{
  "success": true,
  "watch": {
    "historyId": "987654",
    "expirationMs": 1736899200000,
    "labelIds": ["INBOX"]
  }
}
```

---

## Step 7: Set up watch renewal cron

Watches expire every 7 days. Set up a daily cron to renew any that are within 24h of expiry.

### Option A — Coolify scheduled task

In Coolify UI:
- Service: hm-core
- Schedule: `0 3 * * *` (daily at 03:00 UTC)
- Command:
  ```bash
  curl -X POST http://hm-core:8050/api/connectors/gmail/watch/renew-all \
    -H "X-Cron-Token: $CRON_TOKEN"
  ```

### Option B — Cloud Scheduler (in GCP)

```bash
gcloud scheduler jobs create http gmail-watch-renew \
  --schedule="0 3 * * *" \
  --uri="https://core.hivemind.davinciai.eu:8050/api/connectors/gmail/watch/renew-all" \
  --http-method=POST \
  --headers="X-Cron-Token=$CRON_TOKEN"
```

---

## Step 8: Test the full loop

1. Connect a Gmail account in HIVEMIND UI
2. Tail core logs:
   ```bash
   docker logs -f hm-core | grep -E '(gmail-pubsub|gmail-watch)'
   ```
3. Send an email to that Gmail address from anywhere
4. Within seconds you should see:
   ```
   [gmail-pubsub] webhook received for alice@example.com historyId=987655
   [gmail-pubsub] sync triggered
   [knowledge] Upload xyz complete: ingested=1
   ```
5. Search HIVEMIND for the email subject → should appear as new memory

---

## Troubleshooting

### "GCP_PUBSUB_TOPIC not set"
You skipped Step 5. Set env vars + redeploy.

### "Invalid Pub/Sub auth token"
Audience mismatch. The `--push-auth-token-audience` from Step 4 must equal `GCP_PUBSUB_AUDIENCE` env var exactly.

### Webhook returns 401
- Token might be expired (Pub/Sub rotates them; retries will succeed)
- Wrong audience or issuer claim
- In dev mode, set `NODE_ENV=development` to skip verification

### Notifications stop after 7 days
Watch renewal cron isn't running. Check Step 7. Re-register manually:
```bash
curl -X POST https://core.hivemind.davinciai.eu:8050/api/connectors/gmail/watch/renew-all \
  -H "X-Cron-Token: $CRON_TOKEN"
```

### "Permission denied" when calling Gmail watch.create
The OAuth token doesn't have `gmail.modify` scope (required to set up a watch). Either:
- Re-prompt user to re-authorize with `gmail.modify` added to scopes, OR
- Use a service account with domain-wide delegation (Workspace customers only)

### Notifications received but no sync
Check that user's `historyId` cursor isn't too old (>30 days). Trigger a manual full sync to reset:
```bash
curl -X POST https://core.hivemind.davinciai.eu:8050/api/connectors/gmail/sync \
  -H "Authorization: Bearer $USER_API_KEY"
```

---

## Cost

GCP Pub/Sub pricing:
- First 10 GB/month free
- $40/TiB after that
- Gmail notifications are ~1 KB each → 10 GB ≈ **10 million notifications/month**

For 1000 active users averaging 50 emails/day = 1.5M notifications/month ≈ **free tier**.

---

## Disabling

To stop watches for a single user (e.g. on disconnect):
```js
import { stopWatch } from './connectors/providers/gmail/gmail-watch.js';
await stopWatch({ accessToken });
```

To delete the whole topic:
```bash
gcloud pubsub subscriptions delete gmail-changes-sub
gcloud pubsub topics delete gmail-changes
```
