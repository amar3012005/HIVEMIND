-- Extend RelationshipType enum with PartOf + Mentions.
--
-- PartOf:   section/turn/message → parent document/session/thread
-- Mentions: memory  → entity node (when entity nodes ship in next phase)
--
-- Postgres requires ALTER TYPE ADD VALUE to run OUTSIDE a transaction.
-- Prisma migrate executes each statement separately so this lands as
-- two non-tx commits.

ALTER TYPE "RelationshipType" ADD VALUE IF NOT EXISTS 'PartOf';
ALTER TYPE "RelationshipType" ADD VALUE IF NOT EXISTS 'Mentions';
