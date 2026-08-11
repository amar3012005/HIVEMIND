-- Room-level learned METHOD playbook (self-evolving skill-sequence lessons per room).
-- Written by the post-turn reflection (employees sidecar via asyncpg); read to prime
-- the next turn's skill choice. Not in the Prisma model (raw-SQL access only, same
-- pattern as evo_mode).
-- Down: ALTER TABLE "hivemind"."hyper_rooms" DROP COLUMN IF EXISTS room_playbook;
ALTER TABLE "hivemind"."hyper_rooms" ADD COLUMN IF NOT EXISTS room_playbook JSONB;
