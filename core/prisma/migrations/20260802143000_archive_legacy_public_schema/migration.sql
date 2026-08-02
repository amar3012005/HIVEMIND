-- Manual production migration. Do not run with prisma migrate deploy.
--
-- The application schema is `hivemind`. An earlier deployment accidentally
-- created a second application tree in `public`; it contains historical rows,
-- so preserve it intact instead of deleting data. PostgreSQL extensions remain
-- in a newly-created, minimal `public` schema because recall calls
-- public.word_similarity explicitly.

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'hivemind') THEN
    RAISE EXCEPTION 'hivemind application schema is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'public') THEN
    RAISE EXCEPTION 'public schema is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'legacy_public') THEN
    ALTER SCHEMA public RENAME TO legacy_public;
    CREATE SCHEMA public AUTHORIZATION CURRENT_USER;
  ELSIF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
  ) THEN
    RAISE EXCEPTION 'public contains application relations after archival; refusing ambiguous migration';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    ALTER EXTENSION pg_trgm SET SCHEMA public;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    ALTER EXTENSION pgcrypto SET SCHEMA public;
  END IF;

  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  GRANT USAGE ON SCHEMA public TO PUBLIC;
END
$migration$;

COMMENT ON SCHEMA legacy_public IS
  'Read-only archive of the pre-2026-08-02 accidental public application schema.';
COMMENT ON SCHEMA public IS
  'Extension-only namespace. Application tables belong in hivemind.';

REVOKE CREATE ON SCHEMA legacy_public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA legacy_public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA legacy_public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA legacy_public FROM PUBLIC;
