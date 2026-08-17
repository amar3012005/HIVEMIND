-- Production already defaults account_type to personal and currently has no
-- null rows. Normalize defensively before aligning the database constraint
-- with the required Prisma field.
UPDATE "organizations"
SET "account_type" = 'personal'
WHERE "account_type" IS NULL;

ALTER TABLE "organizations"
ALTER COLUMN "account_type" SET NOT NULL;
