-- Additional Population-Sim toggle on a HyperAgents room. 'on' runs an extra many-voice
-- social simulation (ontology → personas → burst → report) whose report is folded into the
-- synthesis and shown as a popup dashboard; 'off' (default) leaves the main flow untouched.
-- Additive + idempotent: an existing room simply defaults to 'off'.
ALTER TABLE hivemind.hyper_rooms ADD COLUMN IF NOT EXISTS sim_mode VARCHAR(16) DEFAULT 'off';
