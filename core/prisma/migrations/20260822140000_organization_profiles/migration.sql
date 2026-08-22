CREATE TABLE "organization_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "value" TEXT NOT NULL,
    "category" VARCHAR(50) NOT NULL DEFAULT 'identity',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "organization_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "organization_profiles_org_id_key_key"
  ON "organization_profiles"("org_id", "key");
CREATE INDEX "organization_profiles_org_deleted_idx"
  ON "organization_profiles"("org_id", "deleted_at");
