-- Stripe billing state for each Organization.
--
-- The org's actual plan + entitlements still come from billing/plans.js;
-- this migration adds the columns we need to round-trip with Stripe:
--   - stripe_customer_id        — created on first checkout, reused thereafter
--   - stripe_subscription_id    — active subscription, null on free / cancelled
--   - subscription_status       — mirror of Stripe sub.status
--                                 (active | trialing | past_due | canceled | unpaid | incomplete)
--   - current_period_end        — for "next bill on" UI + grace-period gating
--   - trial_ends_at             — for trial banners
--   - billing_email             — override of org owner email used on invoices
--
-- All nullable so existing rows continue working (defaults to free plan,
-- no Stripe customer yet).

ALTER TABLE hivemind.organizations
  ADD COLUMN IF NOT EXISTS stripe_customer_id      VARCHAR(64),
  ADD COLUMN IF NOT EXISTS stripe_subscription_id  VARCHAR(64),
  ADD COLUMN IF NOT EXISTS subscription_status     VARCHAR(32),
  ADD COLUMN IF NOT EXISTS current_period_end      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_ends_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS billing_email           VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS organizations_stripe_customer_idx
  ON hivemind.organizations (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS organizations_stripe_subscription_idx
  ON hivemind.organizations (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- Idempotent webhook receipts: every Stripe event we successfully process is
-- recorded so we can safely retry on transient failures.
CREATE TABLE IF NOT EXISTS hivemind.stripe_events (
  event_id    VARCHAR(64) PRIMARY KEY,
  event_type  VARCHAR(64) NOT NULL,
  org_id      UUID REFERENCES hivemind.organizations(id) ON DELETE SET NULL,
  payload     JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stripe_events_org_idx ON hivemind.stripe_events (org_id, processed_at DESC);
CREATE INDEX IF NOT EXISTS stripe_events_type_idx ON hivemind.stripe_events (event_type, processed_at DESC);
