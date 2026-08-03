-- Manual production migration. Do not run prisma migrate deploy.
CREATE SCHEMA IF NOT EXISTS hivemind;

CREATE TABLE IF NOT EXISTS hivemind.usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  initiating_user_id uuid NULL,
  api_key_id uuid NULL,
  source varchar(80) NOT NULL,
  metric varchar(80) NOT NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  state varchar(16) NOT NULL CHECK (state IN ('reserved','settled','released')),
  idempotency_key varchar(180) NOT NULL,
  provider_receipt jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz NULL,
  released_at timestamptz NULL,
  UNIQUE (org_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS usage_events_org_metric_state_idx ON hivemind.usage_events (org_id, metric, state, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_member_idx ON hivemind.usage_events (org_id, initiating_user_id, created_at DESC) WHERE initiating_user_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS hivemind.usage_projection_receipts (
  usage_event_id uuid PRIMARY KEY REFERENCES hivemind.usage_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Control Plane has always read this schema. Copy legacy webhook receipts first;
-- retain the legacy table for one release until production parity is recorded.
CREATE TABLE IF NOT EXISTS hivemind.stripe_events (
  event_id varchar(255) PRIMARY KEY,
  event_type varchar(255) NOT NULL,
  org_id uuid NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  processed_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF to_regclass('public.stripe_events') IS NOT NULL THEN
    INSERT INTO hivemind.stripe_events (event_id, event_type, org_id, payload, processed_at)
    SELECT event_id, event_type, org_id, COALESCE(payload, '{}'::jsonb), COALESCE(processed_at, now())
    FROM public.stripe_events ON CONFLICT (event_id) DO NOTHING;
  END IF;
END $$;
