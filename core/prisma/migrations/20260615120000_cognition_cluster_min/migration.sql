-- Per-tenant canonical clusterMin override (NULL = adaptive). Additive.
ALTER TABLE "hivemind"."organizations"
  ADD COLUMN IF NOT EXISTS "cognition_cluster_min" INTEGER;

-- DOWN: ALTER TABLE "hivemind"."organizations" DROP COLUMN IF EXISTS "cognition_cluster_min";
