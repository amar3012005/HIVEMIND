-- Population-Sim cast size (FE slider, 10-100). Additive + idempotent; existing rooms
-- default to 24. Paired with sim_mode (the on/off toggle).
ALTER TABLE hivemind.hyper_rooms ADD COLUMN IF NOT EXISTS sim_agents INTEGER DEFAULT 24;
