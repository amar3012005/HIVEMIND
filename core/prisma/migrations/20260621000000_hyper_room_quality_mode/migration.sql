-- HyperAgents quality mode per room: 'auto' (multi-model: cheap gather+debate, strong
-- 120b synthesis) or 'best' (all gpt-oss-120b). Default 'auto'. Read by the sidecar
-- (get_room_quality_mode); set from the room UI toggle.
ALTER TABLE hivemind.hyper_rooms ADD COLUMN IF NOT EXISTS quality_mode VARCHAR(16) DEFAULT 'auto';
