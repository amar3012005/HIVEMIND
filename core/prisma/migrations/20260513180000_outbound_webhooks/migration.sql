-- Outbound webhooks: let enterprise customers subscribe to org events.
--
-- Each subscription targets a single URL + event-type allowlist. Every
-- dispatch produces a webhook_deliveries row that the retry worker
-- sweeps. HMAC-SHA256 signature is computed with the subscription's
-- secret so receivers can verify authenticity.
--
-- Event taxonomy (extend as needed):
--   user.joined, user.removed, user.role_changed
--   billing.subscribed, billing.upgraded, billing.cancelled, billing.payment_failed
--   employee.created, employee.paused, employee.deleted
--   team.created, project.created
--   audit.policy_denied
--   connector.installed, connector.revoked
--
-- Backoff: 1m → 5m → 15m → 1h → 6h → 24h (6 attempts), then dead-letter.
-- Receivers respond 2xx within 10s = success; anything else = retry.

CREATE TABLE IF NOT EXISTS hivemind.webhook_subscriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES hivemind.organizations(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  description  VARCHAR(255),
  -- Empty array = subscribe to ALL event types. Specific types like
  -- ARRAY['billing.subscribed','user.joined'] subscribe to those only.
  event_types  TEXT[] NOT NULL DEFAULT '{}',
  -- HMAC secret. Generated server-side on POST; never returned in plain
  -- after creation (only the first response carries it).
  secret_hash  VARCHAR(255) NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by   UUID REFERENCES hivemind.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS webhook_subscriptions_org_idx
  ON hivemind.webhook_subscriptions (org_id, enabled);
CREATE INDEX IF NOT EXISTS webhook_subscriptions_event_types_idx
  ON hivemind.webhook_subscriptions USING GIN (event_types);


CREATE TABLE IF NOT EXISTS hivemind.webhook_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES hivemind.webhook_subscriptions(id) ON DELETE CASCADE,
  org_id          UUID NOT NULL REFERENCES hivemind.organizations(id) ON DELETE CASCADE,
  event_id        VARCHAR(64) NOT NULL,
  event_type      VARCHAR(64) NOT NULL,
  payload         JSONB NOT NULL,
  -- pending | delivered | failed | dead_lettered
  status          VARCHAR(32) NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_status_code INTEGER,
  last_error      TEXT,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Worker query: SELECT WHERE status='pending' AND next_attempt_at <= NOW()
CREATE INDEX IF NOT EXISTS webhook_deliveries_pending_idx
  ON hivemind.webhook_deliveries (next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS webhook_deliveries_subscription_idx
  ON hivemind.webhook_deliveries (subscription_id, created_at DESC);

CREATE INDEX IF NOT EXISTS webhook_deliveries_org_idx
  ON hivemind.webhook_deliveries (org_id, created_at DESC);

-- Idempotency: receivers can de-dup on event_id.
CREATE INDEX IF NOT EXISTS webhook_deliveries_event_id_idx
  ON hivemind.webhook_deliveries (event_id);
