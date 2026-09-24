CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS hivemind.recall_bm25_sync (
  memory_id uuid PRIMARY KEY REFERENCES hivemind.memories(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hivemind.canonical_entity_search_aliases (
  entity_id uuid NOT NULL REFERENCES hivemind.canonical_entities(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  alias text NOT NULL,
  normalized_alias text NOT NULL,
  is_canonical boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, normalized_alias)
);

CREATE INDEX IF NOT EXISTS canonical_entity_alias_org_normalized_idx
  ON hivemind.canonical_entity_search_aliases (organization_id, normalized_alias text_pattern_ops);
CREATE INDEX IF NOT EXISTS canonical_entity_alias_org_entity_idx
  ON hivemind.canonical_entity_search_aliases (organization_id, entity_id);
CREATE INDEX IF NOT EXISTS canonical_entity_alias_normalized_trgm_idx
  ON hivemind.canonical_entity_search_aliases USING gin (normalized_alias public.gin_trgm_ops);

CREATE OR REPLACE FUNCTION hivemind.normalize_entity_search_alias(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT trim(both '-' FROM regexp_replace(lower(trim(coalesce(value, ''))), '[^[:alnum:]]+', '-', 'g'));
$$;

CREATE OR REPLACE FUNCTION hivemind.sync_canonical_entity_search_aliases()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM hivemind.canonical_entity_search_aliases WHERE entity_id = NEW.id;

  INSERT INTO hivemind.canonical_entity_search_aliases
    (entity_id, organization_id, alias, normalized_alias, is_canonical, updated_at)
  VALUES (NEW.id, NEW.organization_id, NEW.canonical_name, NEW.normalized_name, true, now())
  ON CONFLICT (entity_id, normalized_alias) DO UPDATE
    SET alias = EXCLUDED.alias,
        organization_id = EXCLUDED.organization_id,
        is_canonical = true,
        updated_at = now();

  INSERT INTO hivemind.canonical_entity_search_aliases
    (entity_id, organization_id, alias, normalized_alias, is_canonical, updated_at)
  SELECT NEW.id,
         NEW.organization_id,
         candidate.alias,
         hivemind.normalize_entity_search_alias(candidate.alias),
         false,
         now()
  FROM unnest(coalesce(NEW.aliases, ARRAY[]::text[])) AS candidate(alias)
  WHERE hivemind.normalize_entity_search_alias(candidate.alias) <> ''
  ON CONFLICT (entity_id, normalized_alias) DO UPDATE
    SET alias = EXCLUDED.alias,
        organization_id = EXCLUDED.organization_id,
        is_canonical = hivemind.canonical_entity_search_aliases.is_canonical OR EXCLUDED.is_canonical,
        updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS canonical_entity_search_aliases_sync ON hivemind.canonical_entities;
CREATE TRIGGER canonical_entity_search_aliases_sync
AFTER INSERT OR UPDATE OF canonical_name, normalized_name, aliases, organization_id
ON hivemind.canonical_entities
FOR EACH ROW EXECUTE FUNCTION hivemind.sync_canonical_entity_search_aliases();

INSERT INTO hivemind.canonical_entity_search_aliases
  (entity_id, organization_id, alias, normalized_alias, is_canonical)
SELECT entity.id, entity.organization_id, entity.canonical_name, entity.normalized_name, true
FROM hivemind.canonical_entities entity
WHERE entity.normalized_name <> ''
ON CONFLICT (entity_id, normalized_alias) DO UPDATE
  SET alias = EXCLUDED.alias,
      organization_id = EXCLUDED.organization_id,
      is_canonical = true,
      updated_at = now();

INSERT INTO hivemind.canonical_entity_search_aliases
  (entity_id, organization_id, alias, normalized_alias, is_canonical)
SELECT entity.id,
       entity.organization_id,
       candidate.alias,
       hivemind.normalize_entity_search_alias(candidate.alias),
       false
FROM hivemind.canonical_entities entity
CROSS JOIN LATERAL unnest(coalesce(entity.aliases, ARRAY[]::text[])) AS candidate(alias)
WHERE hivemind.normalize_entity_search_alias(candidate.alias) <> ''
ON CONFLICT (entity_id, normalized_alias) DO UPDATE
  SET alias = EXCLUDED.alias,
      organization_id = EXCLUDED.organization_id,
      is_canonical = hivemind.canonical_entity_search_aliases.is_canonical OR EXCLUDED.is_canonical,
      updated_at = now();
