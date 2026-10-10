-- Metadata-only cold navigation must not scan complete conversation logs.
-- Prisma PostgreSQL migrations do not wrap these statements in a transaction.
-- Concurrent builds keep writes available; both indexes are additive/reversible.
CREATE INDEX CONCURRENTLY IF NOT EXISTS harness_session_events_preset_navigation_idx
  ON harness_session_events (org_id, user_id, session_id, sequence DESC)
  WHERE event_type = 'agent-preset/selected';
