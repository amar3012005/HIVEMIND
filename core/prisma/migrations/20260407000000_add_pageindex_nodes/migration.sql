-- CreateTable
CREATE TABLE IF NOT EXISTS "PageIndexNode" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "org_id" UUID,
    "parent_id" UUID,
    "label" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "node_type" TEXT NOT NULL DEFAULT 'topic',
    "depth" INTEGER NOT NULL DEFAULT 1,
    "memory_ids" UUID[] DEFAULT '{}',
    "memory_count" INTEGER NOT NULL DEFAULT 0,
    "auto_generated" BOOLEAN NOT NULL DEFAULT true,
    "custom_branch" BOOLEAN NOT NULL DEFAULT false,
    "last_pruned_at" TIMESTAMPTZ,
    "cross_refs" TEXT[] DEFAULT '{}',
    "cached_child_paths" TEXT[] DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "PageIndexNode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PageIndexNode_user_id_idx" ON "PageIndexNode"("user_id");

-- CreateIndex
CREATE INDEX "PageIndexNode_user_id_depth_idx" ON "PageIndexNode"("user_id", "depth");

-- CreateIndex
CREATE UNIQUE INDEX "PageIndexNode_path_key" ON "PageIndexNode"("path");

-- CreateIndex
CREATE INDEX "PageIndexNode_parent_id_idx" ON "PageIndexNode"("parent_id");

-- CreateIndex
CREATE INDEX "PageIndexNode_node_type_idx" ON "PageIndexNode"("node_type");

-- AddForeignKey
ALTER TABLE "PageIndexNode" ADD CONSTRAINT "PageIndexNode_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- AddForeignKey
ALTER TABLE "PageIndexNode" ADD CONSTRAINT "PageIndexNode_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

-- AddForeignKey
ALTER TABLE "PageIndexNode" ADD CONSTRAINT "PageIndexNode_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "PageIndexNode"("id") ON DELETE CASCADE;
