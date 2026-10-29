-- Team operating memory: add the lesson, procedure, progress and agenda kinds
-- to the existing private store. Their fields, confirmations and promotion live
-- in the existing "context" JSONB, so no column or table is added. Additive:
-- every existing row and kind stays valid.
ALTER TABLE "hivemind"."hyper_agent_operating_memories"
  DROP CONSTRAINT IF EXISTS "hyper_agent_operating_memories_kind_check";
ALTER TABLE "hivemind"."hyper_agent_operating_memories"
  ADD CONSTRAINT "hyper_agent_operating_memories_kind_check"
  CHECK ("kind" IN ('learning', 'decision_note', 'handoff', 'task_status', 'trigger_status', 'user_agenda', 'uncertainty',
                    'lesson', 'procedure', 'progress', 'agenda'));

-- Head lookup for progress/agenda upserts by key.
CREATE INDEX IF NOT EXISTS "hyper_agent_operating_memories_task_key_idx"
  ON "hivemind"."hyper_agent_operating_memories" ("org_id", (context->>'task_key'), "created_at" DESC)
  WHERE kind = 'progress';
CREATE INDEX IF NOT EXISTS "hyper_agent_operating_memories_agenda_key_idx"
  ON "hivemind"."hyper_agent_operating_memories" ("org_id", (context->>'agenda_key'), "created_at" DESC)
  WHERE kind = 'agenda';
-- "Is this memory superseded" probe used by every recall.
CREATE INDEX IF NOT EXISTS "hyper_agent_operating_memories_successor_probe_idx"
  ON "hivemind"."hyper_agent_operating_memories" ("org_id", (context->>'supersedesId'))
  WHERE context->>'supersedesId' IS NOT NULL;
-- promoted:true recall filter.
CREATE INDEX IF NOT EXISTS "hyper_agent_operating_memories_promoted_idx"
  ON "hivemind"."hyper_agent_operating_memories" ("org_id", "created_at" DESC)
  WHERE kind IN ('lesson', 'procedure') AND context->>'promoted' = 'true';
