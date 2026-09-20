-- Versioned, server-managed in-app announcements and popup delivery receipts.
-- Additive/idempotent: existing lifecycle notifications remain untouched.
CREATE TABLE IF NOT EXISTS hivemind.workspace_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key varchar(120) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  status varchar(24) NOT NULL DEFAULT 'draft',
  placement varchar(24) NOT NULL DEFAULT 'toast',
  priority integer NOT NULL DEFAULT 0,
  title varchar(180) NOT NULL,
  body text,
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  audience jsonb NOT NULL DEFAULT '{"kind":"all"}'::jsonb,
  requires_notification boolean NOT NULL DEFAULT true,
  starts_at timestamptz,
  ends_at timestamptz,
  created_by varchar(120),
  published_by varchar(120),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_announcements_key_version_uidx UNIQUE (key, version),
  CONSTRAINT workspace_announcements_status_check CHECK (status IN ('draft','scheduled','published','paused','archived')),
  CONSTRAINT workspace_announcements_placement_check CHECK (placement IN ('toast','dialog','reader','banner')),
  CONSTRAINT workspace_announcements_window_check CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS workspace_announcements_active_idx
  ON hivemind.workspace_announcements (status, starts_at, ends_at, priority DESC);

CREATE TABLE IF NOT EXISTS hivemind.workspace_announcement_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id uuid NOT NULL REFERENCES hivemind.workspace_announcements(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  notification_id uuid,
  first_seen_at timestamptz,
  dismissed_at timestamptz,
  actioned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_announcement_delivery_uidx UNIQUE (announcement_id, org_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_announcement_deliveries_org_user_idx
  ON hivemind.workspace_announcement_deliveries (org_id, user_id, dismissed_at);
CREATE INDEX IF NOT EXISTS workspace_announcement_deliveries_announcement_idx
  ON hivemind.workspace_announcement_deliveries (announcement_id);
