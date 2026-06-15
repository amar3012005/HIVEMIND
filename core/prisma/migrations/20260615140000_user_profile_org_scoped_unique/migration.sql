-- M6: scope UserProfile uniqueness per (user, org, key) instead of (user, key).
-- The old unique allowed only ONE fact per key across ALL of a user's orgs, so an
-- org-A write overwrote the org-B fact for the same key (cross-org identity bleed).
-- The new key is strictly more permissive, so no existing row can collide.
-- org_id is populated on every current row (0 NULLs).
DROP INDEX IF EXISTS hivemind.user_profiles_user_id_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_user_id_org_id_key_key
  ON hivemind.user_profiles (user_id, org_id, key);
