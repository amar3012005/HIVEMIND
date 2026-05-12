-- Role archetype + peer review targets for multi-employee team tasks.
--
-- Until now the multi-agent runner (TeamRoom on AgentScope) inferred a
-- role_archetype + peer_review_targets[] from the policy_rules JSONB
-- blob — but the frontend wizard never exposed those keys, so every
-- new employee defaulted to 'generalist' with no challenge targets.
-- That defeats the adversarial-review design.
--
-- Promote both to first-class columns so:
--  (a) the frontend wizard can ship UI for them
--  (b) the bootstrap snapshot can include them
--  (c) the Python sidecar reads them via plain SELECT without JSONB digs
--
-- We do NOT drop the policy_rules JSONB — other settings still live
-- there (rate_limit_per_min, etc.).

ALTER TABLE hivemind.digital_employees
  ADD COLUMN IF NOT EXISTS role_archetype       VARCHAR(40),
  ADD COLUMN IF NOT EXISTS peer_review_targets  TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill existing rows from policy_rules JSONB where available.
UPDATE hivemind.digital_employees
   SET role_archetype = COALESCE(role_archetype, policy_rules->>'role_archetype')
 WHERE role_archetype IS NULL
   AND policy_rules ? 'role_archetype';

UPDATE hivemind.digital_employees
   SET peer_review_targets = COALESCE(
       peer_review_targets,
       ARRAY(SELECT jsonb_array_elements_text(policy_rules->'peer_review_targets'))
   )
 WHERE (peer_review_targets IS NULL OR array_length(peer_review_targets, 1) IS NULL)
   AND policy_rules ? 'peer_review_targets';

-- Index used by reviewer-pool queries in the sidecar.
CREATE INDEX IF NOT EXISTS digital_employees_role_archetype_idx
  ON hivemind.digital_employees (role_archetype)
  WHERE role_archetype IS NOT NULL;
