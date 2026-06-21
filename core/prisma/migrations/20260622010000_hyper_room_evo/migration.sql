-- Self-evolving HyperAgents employees (ADDITIONAL, opt-in). Additive + idempotent.
--   evo_mode      — 'on'/'off' toggle (default 'off' → existing rooms untouched)
--   evo_playbooks — per-employee learned playbooks {"<slug>":["lesson",...]}, stored
--                   here (NOT the vector KB) so reflected lessons never pollute recall.
-- Proven before wiring: employees-service/scripts/swarm_spike/self_evolve_spike.py
-- (weak 8B employee: control 0.354 → learned 0.669 on UNSEEN held-out tasks, +0.315).
ALTER TABLE hivemind.hyper_rooms ADD COLUMN IF NOT EXISTS evo_mode VARCHAR(16) DEFAULT 'off';
ALTER TABLE hivemind.hyper_rooms ADD COLUMN IF NOT EXISTS evo_playbooks JSONB DEFAULT '{}'::jsonb;
