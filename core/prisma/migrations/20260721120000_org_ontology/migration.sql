-- Canonical V5 Phase 10 — organization ontologies (additive, opt-in).
-- Absence of a row = default pipeline (unchanged behavior). Never forks ingestion.
CREATE TABLE IF NOT EXISTS "hivemind"."org_ontologies" (
  "org_id"                UUID PRIMARY KEY,
  "approved_entity_types" TEXT[] NOT NULL DEFAULT '{}',
  "vocabulary"            JSONB  NOT NULL DEFAULT '{}',
  "required_metadata"     TEXT[] NOT NULL DEFAULT '{}',
  "relationship_rules"    JSONB  NOT NULL DEFAULT '{}',
  "enabled"               BOOLEAN NOT NULL DEFAULT true,
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
