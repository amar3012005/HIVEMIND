-- Room-level connector toggles (HyperAgents×Connectors, simplified model).
-- One switch per connector, like the web tool: when enabled, every agent in
-- the room can use that connector's tools during the run. Replaces the
-- per-character agent_connectors grant matrix (column kept, now unused).
--
-- Additive + back-compat: empty array default.
--
-- Rollback (down):
--   ALTER TABLE "hyper_rooms" DROP COLUMN "enabled_connectors";
ALTER TABLE "hyper_rooms" ADD COLUMN "enabled_connectors" TEXT[] NOT NULL DEFAULT '{}';
