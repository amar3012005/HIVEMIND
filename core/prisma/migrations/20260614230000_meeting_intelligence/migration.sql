-- Meeting Intelligence (Phase B): grounded cross-reference of a meeting
-- against existing HIVEMIND memory. Additive, backward-compatible.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS intelligence JSONB;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS intelligence_status VARCHAR(16) NOT NULL DEFAULT 'none';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS intelligence_generated_at TIMESTAMPTZ(6);
