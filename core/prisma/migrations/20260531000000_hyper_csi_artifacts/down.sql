-- Manual rollback (Prisma has no native down). Run if reverting this migration.
DROP TABLE IF EXISTS "hyper_relations";
DROP TABLE IF EXISTS "hyper_trials";
DROP TABLE IF EXISTS "hyper_claims";
