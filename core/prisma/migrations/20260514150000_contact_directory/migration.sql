-- Contact directory: structured person index for email/connector ingestion.
-- Replaces "Fact: email of X is Y@z.com" garbage fact-memories with a
-- proper contact graph queryable by email, name, or domain.

CREATE TABLE IF NOT EXISTS hivemind.contacts (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID            NOT NULL,
  org_id          UUID,
  email           VARCHAR(320)    NOT NULL,
  display_name    VARCHAR(255),
  source_platform VARCHAR(50)     NOT NULL DEFAULT 'gmail',
  domain          VARCHAR(255),
  first_seen_at   TIMESTAMPTZ     NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ     NOT NULL DEFAULT now(),
  msg_count       INT             NOT NULL DEFAULT 1,
  metadata        JSONB,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
  CONSTRAINT contacts_user_email_unique UNIQUE (user_id, email, source_platform)
);

CREATE INDEX IF NOT EXISTS idx_contacts_user_email ON hivemind.contacts(user_id, email);
CREATE INDEX IF NOT EXISTS idx_contacts_org ON hivemind.contacts(org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_domain ON hivemind.contacts(domain);
CREATE INDEX IF NOT EXISTS idx_contacts_last_seen ON hivemind.contacts(last_seen_at DESC);
