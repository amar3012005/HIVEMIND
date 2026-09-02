-- D1 authority for control-plane data only. Memory/evidence/vector tables never belong here.
CREATE TABLE IF NOT EXISTS registry_events (
  event_id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL, operation TEXT NOT NULL, payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS registry_events_entity_revision ON registry_events(entity_type, entity_id, revision);

CREATE TABLE IF NOT EXISTS registry_users (
  id TEXT PRIMARY KEY, zitadel_user_id TEXT UNIQUE NOT NULL, email_normalized TEXT UNIQUE NOT NULL,
  display_name TEXT, avatar_url TEXT, timezone TEXT, locale TEXT, encryption_key_id TEXT,
  encryption_key_version INTEGER, created_at TEXT, updated_at TEXT, last_active_at TEXT, deleted_at TEXT,
  revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS registry_organizations (
  id TEXT PRIMARY KEY, zitadel_org_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
  profile_json TEXT NOT NULL DEFAULT '{}', commercial_json TEXT NOT NULL DEFAULT '{}', billing_json TEXT NOT NULL DEFAULT '{}',
  settings_json TEXT NOT NULL DEFAULT '{}', hosting_mode TEXT, memory_storage_mode TEXT, created_at TEXT, updated_at TEXT,
  revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS registry_memberships (
  user_id TEXT NOT NULL, org_id TEXT NOT NULL, role TEXT NOT NULL, roles_json TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1, invited_at TEXT, joined_at TEXT, deactivated_at TEXT, revision INTEGER NOT NULL,
  PRIMARY KEY(user_id, org_id)
);
CREATE INDEX IF NOT EXISTS registry_memberships_org_active ON registry_memberships(org_id, is_active);
CREATE TABLE IF NOT EXISTS registry_invites (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, email_normalized TEXT, role TEXT NOT NULL, roles_json TEXT NOT NULL DEFAULT '[]',
  token_hash TEXT UNIQUE NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, revoked_at TEXT, created_by TEXT NOT NULL,
  idempotency_key TEXT, revision INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS registry_invites_org_email ON registry_invites(org_id, email_normalized);
CREATE TABLE IF NOT EXISTS registry_api_keys (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, org_id TEXT, key_hash TEXT UNIQUE NOT NULL, key_prefix TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}', expires_at TEXT, revoked_at TEXT, revision INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS registry_api_keys_org ON registry_api_keys(org_id);
CREATE TABLE IF NOT EXISTS registry_entitlements (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, source TEXT NOT NULL, phase TEXT NOT NULL, plan_id TEXT NOT NULL,
  limits_json TEXT NOT NULL DEFAULT '{}', effective_from TEXT NOT NULL, effective_until TEXT, revision INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS registry_entitlements_effective ON registry_entitlements(org_id, effective_from, effective_until);
CREATE TABLE IF NOT EXISTS registry_memory_boxes (
  org_id TEXT PRIMARY KEY, box_id TEXT NOT NULL, endpoint TEXT, credential_hash TEXT, credential_version INTEGER,
  state TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL
);
