CREATE TABLE IF NOT EXISTS harness_sessions (
  id varchar(180) PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL, project_id uuid,
  profile varchar(64) NOT NULL, variation varchar(16) NOT NULL, status varchar(24) NOT NULL DEFAULT 'active',
  header jsonb NOT NULL, inherited_event_count bigint NOT NULL DEFAULT 0, event_count bigint NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 0, title varchar(500), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
  UNIQUE (id, org_id, user_id)
);
CREATE TABLE IF NOT EXISTS harness_session_events (
  id bigserial PRIMARY KEY, session_id varchar(180) NOT NULL, org_id uuid NOT NULL, user_id uuid NOT NULL,
  sequence bigint NOT NULL, event_type varchar(80) NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(session_id, sequence),
  FOREIGN KEY(session_id, org_id, user_id) REFERENCES harness_sessions(id, org_id, user_id)
);
CREATE TABLE IF NOT EXISTS harness_session_leases (
  id uuid PRIMARY KEY, session_id varchar(180) UNIQUE NOT NULL, org_id uuid NOT NULL, user_id uuid NOT NULL,
  holder_id text NOT NULL, token_hash char(64) UNIQUE NOT NULL, fencing_token bigint NOT NULL DEFAULT 0,
  acquired_at timestamptz NOT NULL, heartbeat_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  released_at timestamptz,
  FOREIGN KEY(session_id, org_id, user_id) REFERENCES harness_sessions(id, org_id, user_id)
);
