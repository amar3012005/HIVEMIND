-- Meeting notes + full-insights persistence (additive, backward-compatible).
-- `notes`    — the user's own typed notes from the live recording view (were
--              previously sent to the insights LLM but never persisted).
-- `insights` — the COMPLETE insights object returned by the LLM, so the
--              Past-meetings detail view can render every section (including
--              new ones like quotes/risks/next_steps) without further schema
--              changes per section.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS insights JSONB NOT NULL DEFAULT '{}'::jsonb;
