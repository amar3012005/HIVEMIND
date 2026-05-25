-- Migration: cluster_index
-- Purpose: Durable, queryable cluster state so cognition-loop can target
--          dirty clusters without full-scanning raw memories every tick.
-- Author:  amarsai3012005

CREATE TABLE IF NOT EXISTS cluster_index (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  user_id               uuid NOT NULL,
  cluster_hash          varchar(64) NOT NULL,
  cluster_type          varchar(40) NOT NULL,
  entity_keys           text[] NOT NULL DEFAULT '{}',
  top_tags              text[] NOT NULL DEFAULT '{}',
  evidence_count        integer NOT NULL DEFAULT 0,
  dirty_count           integer NOT NULL DEFAULT 0,
  latest_synthesis_id   uuid REFERENCES memories(id) ON DELETE SET NULL,
  latest_revision       integer NOT NULL DEFAULT 0,
  latest_confidence     decimal(3,2),
  last_tick_at          timestamptz,
  last_recall_at        timestamptz,
  recall_count_30d      integer NOT NULL DEFAULT 0,
  metadata              jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cluster_index_unique UNIQUE (organization_id, user_id, cluster_hash)
);

CREATE INDEX IF NOT EXISTS cluster_index_dirty_idx ON cluster_index (organization_id, dirty_count DESC)
  WHERE dirty_count > 0;
CREATE INDEX IF NOT EXISTS cluster_index_entity_keys_gin ON cluster_index USING gin (entity_keys);
CREATE INDEX IF NOT EXISTS cluster_index_recall_age_idx ON cluster_index (last_recall_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS cluster_index_org_idx ON cluster_index (organization_id, user_id);
