CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

ALTER TABLE hivemind.canonical_entities
  ADD COLUMN IF NOT EXISTS external_identity_key varchar(500),
  ADD COLUMN IF NOT EXISTS search_terms text[] NOT NULL DEFAULT ARRAY[]::text[];

UPDATE hivemind.canonical_entities ce
SET search_terms = ARRAY(
  SELECT DISTINCT left(term, prefix_length)
  FROM unnest(
    ARRAY[lower(ce.normalized_name), lower(ce.canonical_name)] ||
    COALESCE(ARRAY(SELECT lower(alias) FROM unnest(ce.aliases) alias), ARRAY[]::text[]) ||
    regexp_split_to_array(lower(ce.canonical_name), '[^[:alnum:]]+') ||
    COALESCE(ARRAY(
      SELECT token
      FROM unnest(ce.aliases) alias,
      LATERAL regexp_split_to_table(lower(alias), '[^[:alnum:]]+') token
      WHERE length(token) >= 2
    ), ARRAY[]::text[])
  ) term
  CROSS JOIN LATERAL generate_series(
    LEAST(2, length(term)),
    LEAST(length(term), 160)
  ) prefix_length
  WHERE term IS NOT NULL AND btrim(term) <> ''
)
WHERE cardinality(ce.search_terms) = 0;

CREATE UNIQUE INDEX IF NOT EXISTS canonical_entities_org_kind_external_identity_key
  ON hivemind.canonical_entities (organization_id, entity_kind, external_identity_key)
  WHERE external_identity_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS canonical_entities_search_terms_gin
  ON hivemind.canonical_entities USING gin (search_terms);
CREATE INDEX IF NOT EXISTS canonical_entities_name_trgm
  ON hivemind.canonical_entities USING gin (lower(canonical_name) public.gin_trgm_ops);

CREATE TABLE IF NOT EXISTS hivemind.resource_entity_links (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  organization_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  resource_type varchar(20) NOT NULL,
  resource_id uuid NOT NULL,
  user_id uuid,
  scope_type varchar(20) NOT NULL DEFAULT 'organization',
  scope_id uuid,
  mention_text varchar(500),
  start_offset integer,
  end_offset integer,
  role varchar(40) NOT NULL DEFAULT 'mentioned',
  confidence numeric(4,3) NOT NULL DEFAULT 1.000,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  known_at timestamptz NOT NULL DEFAULT now(),
  link_key varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resource_entity_links_entity_fkey
    FOREIGN KEY (entity_id) REFERENCES hivemind.canonical_entities(id) ON DELETE CASCADE,
  CONSTRAINT resource_entity_links_resource_type_check
    CHECK (resource_type IN ('memory', 'document', 'segment')),
  CONSTRAINT resource_entity_links_offsets_check
    CHECK (start_offset IS NULL OR (start_offset >= 0 AND end_offset >= start_offset)),
  CONSTRAINT resource_entity_links_confidence_check
    CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT resource_entity_links_org_link_key UNIQUE (organization_id, link_key)
);

CREATE INDEX IF NOT EXISTS resource_entity_links_org_resource_idx
  ON hivemind.resource_entity_links (organization_id, resource_type, resource_id);
CREATE INDEX IF NOT EXISTS resource_entity_links_org_entity_seen_idx
  ON hivemind.resource_entity_links (organization_id, entity_id, known_at DESC);
CREATE INDEX IF NOT EXISTS resource_entity_links_org_scope_idx
  ON hivemind.resource_entity_links (organization_id, scope_type, scope_id);
CREATE INDEX IF NOT EXISTS resource_entity_links_user_idx
  ON hivemind.resource_entity_links (user_id);

CREATE TABLE IF NOT EXISTS hivemind.entity_extraction_receipts (
  id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  organization_id uuid NOT NULL,
  resource_type varchar(20) NOT NULL,
  resource_id uuid NOT NULL,
  processing_version integer NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'pending',
  extractor_route varchar(120),
  model_route varchar(160),
  attempt integer NOT NULL DEFAULT 0,
  input_digest varchar(64) NOT NULL,
  output_digest varchar(64),
  entity_count integer NOT NULL DEFAULT 0,
  last_error_code varchar(80),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entity_extraction_receipts_status_check
    CHECK (status IN ('pending', 'processing', 'completed', 'completed_zero', 'failed')),
  CONSTRAINT entity_extraction_receipts_resource_type_check
    CHECK (resource_type IN ('memory', 'document', 'segment')),
  CONSTRAINT entity_extraction_receipts_resource_version
    UNIQUE (organization_id, resource_type, resource_id, processing_version)
);

CREATE INDEX IF NOT EXISTS entity_extraction_receipts_org_status_idx
  ON hivemind.entity_extraction_receipts (organization_id, status, updated_at);

-- Compatibility backfill: existing canonical memory links become universal
-- resource links. The deterministic link key makes the migration repeatable.
INSERT INTO hivemind.resource_entity_links (
  organization_id, entity_id, resource_type, resource_id, user_id,
  scope_type, scope_id, role, confidence, known_at, link_key, provenance
)
SELECT
  ce.organization_id,
  mel.entity_id,
  'memory',
  mel.memory_id,
  m.user_id,
  COALESCE(m.scope::text, 'personal'),
  CASE
    WHEN m.scope::text = 'team' THEN m.primary_team_id
    WHEN m.scope::text = 'project' THEN m.project_id
    ELSE NULL
  END,
  mel.role,
  mel.confidence,
  mel.created_at,
  encode(public.digest(
    ce.organization_id::text || '|memory|' || mel.memory_id::text || '|' ||
    mel.entity_id::text || '|' || mel.role,
    'sha256'
  ), 'hex'),
  jsonb_build_object('migration', 'memory_entity_links')
FROM hivemind.memory_entity_links mel
JOIN hivemind.canonical_entities ce ON ce.id = mel.entity_id
JOIN hivemind.memories m
  ON m.id = mel.memory_id
 AND m.org_id = ce.organization_id
ON CONFLICT (organization_id, link_key) DO NOTHING;
