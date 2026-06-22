-- Swarm journal — ordered compact per-turn entries giving a room CONTINUITY (a turn recalls prior
-- turns). Episodic memory, distinct from evo_playbooks (skills). Additive + idempotent; existing
-- rooms start empty. Proven before wiring: employees-service/scripts/swarm_spike/journal_spike.py
-- (journal arm recalls a prior-turn figure 0.45 vs blank arm 0.00 — blank fabricates).
ALTER TABLE hivemind.hyper_rooms ADD COLUMN IF NOT EXISTS evo_journal JSONB DEFAULT '[]'::jsonb;
