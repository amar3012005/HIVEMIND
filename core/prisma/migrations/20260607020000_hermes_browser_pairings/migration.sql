-- Web-bridge automation (P1) — pairing between a tenant and their browser connector.
-- The connector (on the user's machine) authenticates to the relay with a pairing
-- token; we store only its SHA-256 hash. One active pairing per tenant. Additive.
CREATE TABLE IF NOT EXISTS hivemind.hermes_browser_pairings (
  tenant_id     text PRIMARY KEY,
  org_id        text NOT NULL,
  token_hash    text NOT NULL,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS hermes_browser_pairings_token_idx
  ON hivemind.hermes_browser_pairings (token_hash) WHERE revoked_at IS NULL;
