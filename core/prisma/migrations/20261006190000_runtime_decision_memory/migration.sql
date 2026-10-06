-- Extend the existing private store. No company-memory publication or parallel store.
ALTER TABLE "hivemind"."hyper_agent_operating_memories"
  DROP CONSTRAINT "hyper_agent_operating_memories_kind_check";
ALTER TABLE "hivemind"."hyper_agent_operating_memories"
  ADD CONSTRAINT "hyper_agent_operating_memories_kind_check"
  CHECK ("kind" IN ('learning', 'decision_note', 'handoff', 'task_status', 'trigger_status', 'user_agenda', 'uncertainty'));
CREATE INDEX IF NOT EXISTS "hyper_agent_operating_memories_runtime_idx"
  ON "hivemind"."hyper_agent_operating_memories" (org_id, author_user_id, kind, created_at DESC)
  WHERE kind IN ('user_agenda', 'uncertainty');
CREATE UNIQUE INDEX IF NOT EXISTS "hyper_agent_operating_memories_runtime_successor_idx"
  ON "hivemind"."hyper_agent_operating_memories" (org_id, (context->>'supersedesId'))
  WHERE kind IN ('user_agenda', 'uncertainty') AND context->>'supersedesId' IS NOT NULL;
