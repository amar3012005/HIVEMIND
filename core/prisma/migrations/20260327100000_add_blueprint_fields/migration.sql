ALTER TABLE op_trails ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'raw';
ALTER TABLE op_trails ADD COLUMN IF NOT EXISTS blueprint_meta JSONB;
CREATE INDEX IF NOT EXISTS op_trails_kind_idx ON op_trails(kind);
