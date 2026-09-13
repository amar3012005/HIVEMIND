-- Prisma scopes application connections to the `hivemind` schema. The legacy
-- stateful relationship functions call pgcrypto's `digest()` without schema
-- qualification, so their SECURITY DEFINER execution could not resolve the
-- extension installed in `public`. Pin a deterministic function search path;
-- no data rewrite is required and existing triggers keep their identities.

ALTER FUNCTION hivemind.handle_memory_update_trigger()
  SET search_path = hivemind, public;

ALTER FUNCTION hivemind.handle_memory_extend_trigger()
  SET search_path = hivemind, public;

ALTER FUNCTION hivemind.handle_memory_derive_trigger()
  SET search_path = hivemind, public;

ALTER FUNCTION hivemind.detect_memory_conflicts(uuid, uuid)
  SET search_path = hivemind, public;

ALTER FUNCTION hivemind.resolve_conflicts_latest(uuid, uuid)
  SET search_path = hivemind, public;
