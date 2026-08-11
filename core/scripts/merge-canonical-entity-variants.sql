-- merge-canonical-entity-variants.sql — one-time backfill (2026-08-03)
--
-- entityMatchVariants() in entity-resolver.js stops NEW diacritic/plural
-- fragmentation at create time, but pre-existing variant rows remain:
-- 'Wärmepumpe' / 'Wärmepumpen' / 'Warmepumpe' were three canonicals in org
-- 1380251c. This merges each per-org variant group into its OLDEST row
-- (the canonical original), moves memory_entity_links, and preserves every
-- loser's surface form as an alias so nothing is lost.
--
-- Fold key: lowercase, German diacritics folded (ä→a ö→o ü→u ß dropped by
-- translate), then ONE trailing plural suffix stripped with the alternation
-- ordered LONGEST FIRST — (es|en|e|n|s) — so 'warmepumpen'→'warmepump' and
-- 'warmepumpe'→'warmepump' land on the SAME key. A shorter alternation
-- ((en|n|s)) left those two in DIFFERENT groups (measured in the dry run).
-- length >= 6 guards short names ('SAP' etc.) from plural stripping.
--
-- Safety: the ONLY FK into canonical_entities is memory_entity_links
-- (verified via pg_constraint). PK there is (memory_id, entity_id, role), so
-- links that would collide after repointing are deleted first (they are
-- exact duplicates post-merge). Whole thing is one transaction.

BEGIN;

CREATE TEMP TABLE _variant_map ON COMMIT DROP AS
WITH folded AS (
  SELECT id, organization_id, canonical_name, created_at,
    regexp_replace(translate(lower(normalized_name), 'äöüß', 'aou'), '(es|en|e|n|s)$', '') AS fkey
  FROM hivemind.canonical_entities
  WHERE length(normalized_name) >= 6
),
groups AS (
  SELECT organization_id, fkey,
    (array_agg(id ORDER BY created_at ASC))[1] AS keep_id
  FROM folded GROUP BY 1, 2 HAVING count(*) > 1
)
SELECT f.id AS loser_id, g.keep_id, f.canonical_name AS loser_name
FROM folded f JOIN groups g
  ON g.organization_id = f.organization_id AND g.fkey = f.fkey
WHERE f.id <> g.keep_id;

-- 1. links that would collide with an existing keeper link are exact
--    duplicates after the merge — drop them.
DELETE FROM hivemind.memory_entity_links l
USING _variant_map v
WHERE l.entity_id = v.loser_id
  AND EXISTS (
    SELECT 1 FROM hivemind.memory_entity_links k
    WHERE k.memory_id = l.memory_id AND k.entity_id = v.keep_id AND k.role = l.role
  );

-- 2. repoint the rest.
UPDATE hivemind.memory_entity_links l
SET entity_id = v.keep_id
FROM _variant_map v
WHERE l.entity_id = v.loser_id;

-- 3. every loser surface form becomes an alias on the keeper (deduped).
UPDATE hivemind.canonical_entities k
SET aliases = (
  SELECT array_agg(DISTINCT a) FROM unnest(
    k.aliases || (SELECT array_agg(loser_name) FROM _variant_map v WHERE v.keep_id = k.id)
  ) a WHERE a IS NOT NULL AND a <> k.canonical_name
)
WHERE k.id IN (SELECT DISTINCT keep_id FROM _variant_map);

-- 4. remove the losers.
DELETE FROM hivemind.canonical_entities e
USING _variant_map v WHERE e.id = v.loser_id;

-- report
SELECT 'merged_losers' AS what, count(*) FROM _variant_map;

COMMIT;
