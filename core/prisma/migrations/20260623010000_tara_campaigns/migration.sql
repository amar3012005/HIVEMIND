-- TARA Outbound Campaign foundation (Phase 2): campaigns, dialable contacts,
-- per-dial call-attempt state machine, append-only consent ledger, per-org DNC.
-- All tenant-scoped (org_id + user_id), explicit FKs + indexes. Idempotent.
-- Down migration lives alongside in down.sql (tested for reversibility).

-- tara_campaigns -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS hivemind.tara_campaigns (
  id                UUID         NOT NULL DEFAULT gen_random_uuid(),
  org_id            UUID         NOT NULL,
  user_id           UUID         NOT NULL,
  name              VARCHAR(200) NOT NULL,
  status            VARCHAR(20)  NOT NULL DEFAULT 'draft',
  agent_skill       VARCHAR(120),
  goal              TEXT,
  calling_window    JSONB        NOT NULL DEFAULT '{}',
  caps              JSONB        NOT NULL DEFAULT '{}',
  compliance_config JSONB        NOT NULL DEFAULT '{}',
  recording_opt_in  BOOLEAN      NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT tara_campaigns_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS tara_campaigns_org_id_idx        ON hivemind.tara_campaigns (org_id);
CREATE INDEX IF NOT EXISTS tara_campaigns_user_id_idx       ON hivemind.tara_campaigns (user_id);
CREATE INDEX IF NOT EXISTS tara_campaigns_org_id_status_idx ON hivemind.tara_campaigns (org_id, status);

-- tara_campaign_contacts ---------------------------------------------------
CREATE TABLE IF NOT EXISTS hivemind.tara_campaign_contacts (
  id           UUID        NOT NULL DEFAULT gen_random_uuid(),
  campaign_id  UUID        NOT NULL,
  org_id       UUID        NOT NULL,
  user_id      UUID        NOT NULL,
  phone        VARCHAR(20) NOT NULL,
  display_name VARCHAR(255),
  company      VARCHAR(255),
  country      VARCHAR(2),
  timezone     VARCHAR(60),
  lawful_basis VARCHAR(40),
  status       VARCHAR(20) NOT NULL DEFAULT 'pending',
  metadata     JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT tara_campaign_contacts_pkey PRIMARY KEY (id),
  CONSTRAINT tara_campaign_contacts_campaign_id_fkey
    FOREIGN KEY (campaign_id) REFERENCES hivemind.tara_campaigns (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS tara_campaign_contacts_campaign_id_phone_key
  ON hivemind.tara_campaign_contacts (campaign_id, phone);
CREATE INDEX IF NOT EXISTS tara_campaign_contacts_org_id_idx
  ON hivemind.tara_campaign_contacts (org_id);
CREATE INDEX IF NOT EXISTS tara_campaign_contacts_campaign_id_status_idx
  ON hivemind.tara_campaign_contacts (campaign_id, status);

-- tara_call_attempts -------------------------------------------------------
CREATE TABLE IF NOT EXISTS hivemind.tara_call_attempts (
  id           UUID        NOT NULL DEFAULT gen_random_uuid(),
  campaign_id  UUID        NOT NULL,
  contact_id   UUID        NOT NULL,
  org_id       UUID        NOT NULL,
  user_id      UUID        NOT NULL,
  attempt_no   INTEGER     NOT NULL DEFAULT 1,
  status       VARCHAR(20) NOT NULL DEFAULT 'queued',
  disposition  VARCHAR(30),
  gate_result  JSONB,
  session_id   VARCHAR(120),
  call_leg_id  VARCHAR(120),
  scheduled_at TIMESTAMPTZ(6),
  started_at   TIMESTAMPTZ(6),
  ended_at     TIMESTAMPTZ(6),
  created_at   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT tara_call_attempts_pkey PRIMARY KEY (id),
  CONSTRAINT tara_call_attempts_campaign_id_fkey
    FOREIGN KEY (campaign_id) REFERENCES hivemind.tara_campaigns (id) ON DELETE CASCADE,
  CONSTRAINT tara_call_attempts_contact_id_fkey
    FOREIGN KEY (contact_id) REFERENCES hivemind.tara_campaign_contacts (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tara_call_attempts_org_id_idx            ON hivemind.tara_call_attempts (org_id);
CREATE INDEX IF NOT EXISTS tara_call_attempts_campaign_id_status_idx ON hivemind.tara_call_attempts (campaign_id, status);
CREATE INDEX IF NOT EXISTS tara_call_attempts_contact_id_idx        ON hivemind.tara_call_attempts (contact_id);

-- consent_ledger (append-only) ---------------------------------------------
CREATE TABLE IF NOT EXISTS hivemind.consent_ledger (
  id          UUID        NOT NULL DEFAULT gen_random_uuid(),
  org_id      UUID        NOT NULL,
  user_id     UUID,
  contact_id  UUID,
  phone       VARCHAR(20) NOT NULL,
  action      VARCHAR(20) NOT NULL,
  basis       VARCHAR(40),
  channel     VARCHAR(20) NOT NULL DEFAULT 'voice',
  source      VARCHAR(60),
  metadata    JSONB       NOT NULL DEFAULT '{}',
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT consent_ledger_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS consent_ledger_org_id_idx     ON hivemind.consent_ledger (org_id);
CREATE INDEX IF NOT EXISTS consent_ledger_phone_idx      ON hivemind.consent_ledger (phone);
CREATE INDEX IF NOT EXISTS consent_ledger_contact_id_idx ON hivemind.consent_ledger (contact_id);

-- dnc_list (per-org do-not-call) -------------------------------------------
CREATE TABLE IF NOT EXISTS hivemind.dnc_list (
  id       UUID        NOT NULL DEFAULT gen_random_uuid(),
  org_id   UUID        NOT NULL,
  phone    VARCHAR(20) NOT NULL,
  reason   VARCHAR(120),
  source   VARCHAR(60),
  added_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT dnc_list_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS dnc_list_org_id_phone_key ON hivemind.dnc_list (org_id, phone);
CREATE INDEX IF NOT EXISTS dnc_list_org_id_idx              ON hivemind.dnc_list (org_id);
