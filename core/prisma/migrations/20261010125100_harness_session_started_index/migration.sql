-- One concurrent index per migration: avoid an implicit multi-statement transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS harness_session_events_started_navigation_idx
  ON harness_session_events (org_id, user_id, session_id)
  WHERE event_type = 'turn/start'
     OR (event_type = 'user/message' AND payload->'data'->'source'->>'kind' = 'user');
