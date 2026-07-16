-- GLOBAL per-agent learned playbook (self-evolving Loop 1, cross-room).
--   evo_playbook — ordered list of operating lessons this employee distilled
--                  across ALL rooms ["lesson", ...]. Lives on the employee row
--                  (one per org+slug, @@unique) so learning is GLOBAL per agent:
--                  injected into every room turn AND 1-on-1 private chat.
-- Distinct from hyper_rooms.evo_playbooks (per-room) and hyper_rooms.evo_journal
-- (per-room episodic). Stored here (NOT the vector KB) so reflected lessons never
-- pollute recall. Private chat READS it; only a sealed room turn's post-verify
-- reflection appends. Additive + idempotent; existing employees start with [].
ALTER TABLE hivemind.digital_employees ADD COLUMN IF NOT EXISTS evo_playbook JSONB DEFAULT '[]'::jsonb;

-- Per-agent connector grants (Gmail/Docs/Sheets/MCP) used by 1-on-1 private chat —
-- the chat toolkit registers these the same way a room registers hyper_rooms.enabled_connectors.
-- Distinct from the per-room column; empty = no personal grants. Additive + idempotent.
ALTER TABLE hivemind.digital_employees ADD COLUMN IF NOT EXISTS enabled_connectors TEXT[] NOT NULL DEFAULT '{}'::text[];
