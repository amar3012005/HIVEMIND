-- Salesforce memory layer: external refs, canonical entities, decisions, playbooks
-- Plus bi-temporal valid_from/valid_to on memories.

-- A. external_refs — first-class cross-system entity ID mapping
CREATE TABLE IF NOT EXISTS external_refs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id       uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  system          varchar(50) NOT NULL,
  object_type     varchar(80) NOT NULL,
  external_id     varchar(255) NOT NULL,
  external_url    text,
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_refs_unique UNIQUE (organization_id, system, object_type, external_id, memory_id)
);
CREATE INDEX IF NOT EXISTS external_refs_org_sys_obj_idx ON external_refs (organization_id, system, object_type);
CREATE INDEX IF NOT EXISTS external_refs_memory_idx ON external_refs (memory_id);
CREATE INDEX IF NOT EXISTS external_refs_external_id_idx ON external_refs (external_id);

-- B. canonical_entities — master IDs for real-world things
CREATE TABLE IF NOT EXISTS canonical_entities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  canonical_name  text NOT NULL,
  entity_kind     varchar(40) NOT NULL,
  aliases         text[] NOT NULL DEFAULT '{}',
  primary_email   varchar(255),
  email_domains   text[] NOT NULL DEFAULT '{}',
  vertical_tags   text[] NOT NULL DEFAULT '{}',
  external_refs   jsonb NOT NULL DEFAULT '{}',
  metadata        jsonb NOT NULL DEFAULT '{}',
  merged_from     uuid[] NOT NULL DEFAULT '{}',
  confidence      decimal(3,2) NOT NULL DEFAULT 1.00,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS canonical_entities_org_kind_idx ON canonical_entities (organization_id, entity_kind);
CREATE INDEX IF NOT EXISTS canonical_entities_aliases_gin ON canonical_entities USING gin (aliases);
CREATE INDEX IF NOT EXISTS canonical_entities_email_domains_gin ON canonical_entities USING gin (email_domains);
CREATE INDEX IF NOT EXISTS canonical_entities_primary_email_idx ON canonical_entities (primary_email);

-- C. memory_entity_links — many-to-many memory↔entity
CREATE TABLE IF NOT EXISTS memory_entity_links (
  memory_id   uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id   uuid NOT NULL REFERENCES canonical_entities(id) ON DELETE CASCADE,
  role        varchar(40) NOT NULL DEFAULT 'mentioned',
  confidence  decimal(3,2) NOT NULL DEFAULT 1.00,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, entity_id, role)
);
CREATE INDEX IF NOT EXISTS memory_entity_links_entity_idx ON memory_entity_links (entity_id);

-- D. entity_review_candidates — fuzzy-match queue 0.70-0.95 confidence
CREATE TABLE IF NOT EXISTS entity_review_candidates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  proposed_entity_id uuid,
  memory_id          uuid,
  candidate_name     text NOT NULL,
  candidate_kind     varchar(40) NOT NULL,
  confidence         decimal(3,2) NOT NULL,
  reason             text,
  status             varchar(20) NOT NULL DEFAULT 'pending',
  created_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz
);
CREATE INDEX IF NOT EXISTS entity_review_org_status_idx ON entity_review_candidates (organization_id, status);

-- E. decisions — Layer 4
CREATE TABLE IF NOT EXISTS decisions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL,
  decision_maker_user_id   uuid,
  decision_maker_name      text,
  decision_type            varchar(80) NOT NULL,
  decided_at               timestamptz NOT NULL,
  what_decided             text NOT NULL,
  reasoning                text,
  alternatives             jsonb NOT NULL DEFAULT '[]',
  context_snapshot         jsonb NOT NULL DEFAULT '{}',
  similar_past_ids         uuid[] NOT NULL DEFAULT '{}',
  entity_refs              uuid[] NOT NULL DEFAULT '{}',
  outcome_tracked          boolean NOT NULL DEFAULT false,
  outcome_resolves_at      timestamptz,
  outcome_status           varchar(40),
  outcome_details          jsonb,
  source_memory_id         uuid REFERENCES memories(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS decisions_org_decided_at_idx ON decisions (organization_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS decisions_outcome_pending_idx ON decisions (outcome_tracked, outcome_resolves_at)
  WHERE outcome_tracked = true AND outcome_status IS NULL;
CREATE INDEX IF NOT EXISTS decisions_entity_refs_gin ON decisions USING gin (entity_refs);

-- F. playbooks — Layer 5
CREATE TABLE IF NOT EXISTS playbooks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  name                text NOT NULL,
  pattern_type        varchar(40) NOT NULL,
  segment_filter      jsonb NOT NULL DEFAULT '{}',
  trigger_signal      text NOT NULL,
  intervention        text NOT NULL,
  supporting_evidence uuid[] NOT NULL DEFAULT '{}',
  status              varchar(20) NOT NULL DEFAULT 'candidate',
  confidence          decimal(3,2),
  sample_n            integer,
  curated_by_user_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS playbooks_org_status_idx ON playbooks (organization_id, status);

-- G. Memory valid-time columns (bi-temporal)
ALTER TABLE memories ADD COLUMN IF NOT EXISTS valid_from timestamptz;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS valid_to   timestamptz;
CREATE INDEX IF NOT EXISTS memories_valid_window_idx ON memories (valid_from, valid_to);
