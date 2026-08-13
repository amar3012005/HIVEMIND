-- Fine-grained, per-action-type approval rules — the gap vs xAI's Grok Bot
-- reference: today HIVEMIND has one coarse per-room "autoSend" toggle for
-- ALL outbound email; Grok Bot lets a user say "always allow: create a
-- Drive doc" while still requiring approval for "send an email", per action
-- type. This table is the durable store for that: an org (not room-scoped —
-- an action type like gmail_send should mean the same thing everywhere in
-- that org) opts a specific action label into always_allow or always_deny.
-- Nothing here changes default behavior: with no row, the existing per-turn
-- write policy (ask/deny/authorized) applies exactly as before.
CREATE TABLE IF NOT EXISTS "hivemind"."hyper_approval_rules" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "action_label" VARCHAR(160) NOT NULL,
  "decision" VARCHAR(20) NOT NULL,
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "hyper_approval_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hyper_approval_rules_decision_check"
    CHECK ("decision" IN ('always_allow', 'always_deny')),
  CONSTRAINT "hyper_approval_rules_org_action_key" UNIQUE ("org_id", "action_label")
);

CREATE INDEX IF NOT EXISTS "hyper_approval_rules_org_id_idx"
  ON "hivemind"."hyper_approval_rules"("org_id");
