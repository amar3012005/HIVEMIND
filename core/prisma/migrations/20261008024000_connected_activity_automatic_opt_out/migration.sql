-- Preserve explicit routing disable independently from legacy suggestions-only subscriptions.
-- The trigger store can be absent on instances which have never used connected activity.
ALTER TABLE IF EXISTS hivemind.hivemind_trigger_subscriptions
 ADD COLUMN IF NOT EXISTS runtime_attention_opt_out boolean NOT NULL DEFAULT false;
