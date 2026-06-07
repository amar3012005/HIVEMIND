-- Pin a lead per HyperRoom so orchestration does not re-select the lead on
-- every turn. The room owner can still change it later via PATCH.
ALTER TABLE "hyper_rooms"
  ADD COLUMN IF NOT EXISTS "permanent_lead_id" uuid;

CREATE INDEX IF NOT EXISTS "hyper_rooms_lead_idx"
  ON "hyper_rooms" ("permanent_lead_id");
