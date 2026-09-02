-- Fenced delivery claims make the replay loop safe when Core is restarted or
-- horizontally scaled.  Events retain their original UUID as the D1 event id.
ALTER TABLE "platform_registry_outbox"
  ADD COLUMN "lease_owner" VARCHAR(96),
  ADD COLUMN "lease_expires_at" TIMESTAMPTZ(6);

CREATE INDEX "platform_registry_outbox_status_lease_expires_at_idx"
  ON "platform_registry_outbox"("status", "lease_expires_at");
