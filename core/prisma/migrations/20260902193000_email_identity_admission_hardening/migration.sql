ALTER TABLE "email_auth_challenges"
  ADD COLUMN "signup_ticket_ciphertext" TEXT,
  ADD COLUMN "request_fingerprint_hash" VARCHAR(64);

CREATE INDEX "email_auth_challenges_request_fingerprint_hash_created_at_idx"
  ON "email_auth_challenges"("request_fingerprint_hash", "created_at" DESC);
