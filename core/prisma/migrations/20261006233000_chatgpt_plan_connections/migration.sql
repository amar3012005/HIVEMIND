-- Staged only: this migration does not activate hosted plan usage.
CREATE TABLE "hivemind"."chatgpt_plan_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "hivemind"."organizations"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "hivemind"."users"("id") ON DELETE CASCADE,
  "encrypted_grant" text NOT NULL,
  "status" varchar(24) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("org_id", "user_id")
);
