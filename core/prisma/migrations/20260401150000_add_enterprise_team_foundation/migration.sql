CREATE TABLE "org_invites" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "email" TEXT,
    "role" TEXT NOT NULL DEFAULT 'member',
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "used_by" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_invites_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "platform_integrations"
ADD COLUMN "target_scope" TEXT NOT NULL DEFAULT 'personal';

CREATE UNIQUE INDEX "org_invites_token_key" ON "org_invites"("token");
CREATE INDEX "org_invites_org_id_idx" ON "org_invites"("org_id");
CREATE INDEX "org_invites_email_idx" ON "org_invites"("email");
CREATE INDEX "org_invites_expires_at_idx" ON "org_invites"("expires_at");

CREATE UNIQUE INDEX "projects_org_id_slug_key" ON "projects"("org_id", "slug");
CREATE INDEX "projects_org_id_idx" ON "projects"("org_id");

ALTER TABLE "org_invites"
ADD CONSTRAINT "org_invites_org_id_fkey"
FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "projects"
ADD CONSTRAINT "projects_org_id_fkey"
FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
