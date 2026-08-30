-- New canonical entities receive a deterministic non-null identity key.  The
-- partial population is intentional: historical rows remain compatible while
-- concurrent ingestion workers cannot mint two rows for the same new entity.
CREATE UNIQUE INDEX IF NOT EXISTS canonical_entities_org_identity_key
  ON canonical_entities (organization_id, identity_key)
  WHERE identity_key IS NOT NULL;
