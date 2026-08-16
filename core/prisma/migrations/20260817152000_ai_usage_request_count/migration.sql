ALTER TABLE hivemind.ai_usage_events
  ADD COLUMN IF NOT EXISTS request_count integer NOT NULL DEFAULT 1;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_events_request_count_positive') THEN
    ALTER TABLE hivemind.ai_usage_events ADD CONSTRAINT ai_usage_events_request_count_positive CHECK (request_count > 0) NOT VALID;
  END IF;
END $$;
ALTER TABLE hivemind.ai_usage_events VALIDATE CONSTRAINT ai_usage_events_request_count_positive;
