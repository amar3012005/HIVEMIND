#!/bin/bash
# Gmail Pub/Sub provisioning — one-shot script.
# Creates topic, IAM, push subscription, service account. Idempotent.
#
# Prereq:
#   gcloud auth login
#   gcloud config set project <your-project-id>
#
# Usage:
#   bash scripts/provision-gmail-pubsub.sh
#
# Optional env overrides:
#   PROJECT_ID         (default: gcloud config get-value project)
#   TOPIC_NAME         (default: gmail-changes)
#   SUBSCRIPTION_NAME  (default: gmail-changes-sub)
#   WEBHOOK_URL        (default: https://core.hivemind.davinciai.eu:8050/api/connectors/gmail/pubsub-webhook)
#   SERVICE_ACCOUNT    (default: hivemind-pubsub)

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
TOPIC_NAME="${TOPIC_NAME:-gmail-changes}"
SUBSCRIPTION_NAME="${SUBSCRIPTION_NAME:-gmail-changes-sub}"
WEBHOOK_URL="${WEBHOOK_URL:-https://core.hivemind.davinciai.eu:8050/api/connectors/gmail/pubsub-webhook}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-hivemind-pubsub}"
SA_EMAIL="${SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
TOPIC_FQN="projects/${PROJECT_ID}/topics/${TOPIC_NAME}"

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
log() { echo -e "${GREEN}[provision]${NC} $1"; }
warn() { echo -e "${YELLOW}[provision]${NC} $1"; }

if [ -z "${PROJECT_ID}" ]; then
  echo "ERROR: No GCP project. Run: gcloud config set project <id>"
  exit 1
fi

log "Project: ${PROJECT_ID}"
log "Topic:   ${TOPIC_FQN}"
log "Webhook: ${WEBHOOK_URL}"
log "SA:      ${SA_EMAIL}"
echo ""

# 1. Enable Pub/Sub API
log "Enabling pubsub.googleapis.com..."
gcloud services enable pubsub.googleapis.com --project="${PROJECT_ID}"

# 2. Create topic (idempotent — ignore "already exists")
log "Creating topic ${TOPIC_NAME}..."
if gcloud pubsub topics describe "${TOPIC_NAME}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  warn "Topic already exists. Skipping create."
else
  gcloud pubsub topics create "${TOPIC_NAME}" --project="${PROJECT_ID}"
fi

# 3. Grant Gmail system SA publisher on topic
log "Granting Gmail system SA publisher role..."
gcloud pubsub topics add-iam-policy-binding "${TOPIC_NAME}" \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher" \
  --project="${PROJECT_ID}" >/dev/null

# 4. Create service account for push auth (idempotent)
log "Creating service account ${SERVICE_ACCOUNT}..."
if gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  warn "Service account already exists. Skipping create."
else
  gcloud iam service-accounts create "${SERVICE_ACCOUNT}" \
    --display-name="HIVEMIND Pub/Sub Push Caller" \
    --project="${PROJECT_ID}"
fi

# 5. Grant the SA permission to invoke the webhook (Cloud Run / token creator)
log "Granting token creator role..."
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project="${PROJECT_ID}" >/dev/null || true

# 6. Pub/Sub service agent must impersonate the SA
PUBSUB_SA="service-$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')@gcp-sa-pubsub.iam.gserviceaccount.com"
log "Granting Pub/Sub service agent (${PUBSUB_SA}) token creator on SA..."
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --member="serviceAccount:${PUBSUB_SA}" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project="${PROJECT_ID}" >/dev/null

# 7. Create push subscription (idempotent)
log "Creating push subscription ${SUBSCRIPTION_NAME}..."
if gcloud pubsub subscriptions describe "${SUBSCRIPTION_NAME}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  warn "Subscription already exists. Updating push config..."
  gcloud pubsub subscriptions update "${SUBSCRIPTION_NAME}" \
    --push-endpoint="${WEBHOOK_URL}" \
    --push-auth-service-account="${SA_EMAIL}" \
    --push-auth-token-audience="${WEBHOOK_URL}" \
    --project="${PROJECT_ID}"
else
  gcloud pubsub subscriptions create "${SUBSCRIPTION_NAME}" \
    --topic="${TOPIC_NAME}" \
    --push-endpoint="${WEBHOOK_URL}" \
    --push-auth-service-account="${SA_EMAIL}" \
    --push-auth-token-audience="${WEBHOOK_URL}" \
    --ack-deadline=20 \
    --message-retention-duration=1d \
    --expiration-period=never \
    --project="${PROJECT_ID}"
fi

echo ""
log "DONE."
echo ""
echo "Add these env vars to hm-core .env (or Coolify env panel):"
echo ""
echo "  GCP_PUBSUB_TOPIC=${TOPIC_FQN}"
echo "  GCP_PUBSUB_AUDIENCE=${WEBHOOK_URL}"
echo "  HIVEMIND_PUBLIC_URL=$(echo ${WEBHOOK_URL} | sed 's|/api/connectors/gmail/pubsub-webhook||')"
echo "  CRON_TOKEN=$(openssl rand -hex 16)"
echo ""
echo "Then redeploy: bash scripts/deploy.sh core"
echo ""
echo "Then add 'gmail.modify' to OAuth scopes (required for users.watch) in:"
echo "  core/src/connectors/providers/gmail/adapter.js line ~18"
echo "  core/src/connectors/providers/gmail/oauth.js"
