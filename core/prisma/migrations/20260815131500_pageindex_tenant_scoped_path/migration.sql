-- PageIndex paths are canonical only inside a user's hierarchy. The original
-- global path index prevented a second user from creating `/hivemind`; retain
-- the existing composite unique index on (user_id, path) as the authority.
DROP INDEX IF EXISTS "hivemind"."PageIndexNode_path_key";
