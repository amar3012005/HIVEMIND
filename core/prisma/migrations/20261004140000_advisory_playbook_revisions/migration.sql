-- Advisory methods are independent of executable Runtime playbook stages.
CREATE TABLE hivemind.advisory_playbook_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  proposed_by_user_id uuid NOT NULL,
  method_id varchar(160) NOT NULL,
  prior_version integer NOT NULL CHECK (prior_version >= 0),
  version integer NOT NULL CHECK (version = prior_version + 1),
  body jsonb NOT NULL,
  rationale text NOT NULL,
  evidence_refs jsonb NOT NULL,
  content_hash char(64) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  approved_by_user_id uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, proposed_by_user_id, content_hash),
  CHECK ((status = 'pending' AND approved_by_user_id IS NULL AND decided_at IS NULL)
    OR (status <> 'pending' AND approved_by_user_id IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX advisory_playbook_approved_version ON hivemind.advisory_playbook_revisions
  (organization_id, method_id, version) WHERE status = 'approved';
CREATE INDEX advisory_playbook_tenant ON hivemind.advisory_playbook_revisions (organization_id, status);
-- Approved and pending proposal bodies/provenance are immutable, including direct DB updates.
CREATE FUNCTION hivemind.protect_advisory_playbook_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.organization_id,NEW.proposed_by_user_id,NEW.method_id,NEW.prior_version,
      NEW.version,NEW.body,NEW.rationale,NEW.evidence_refs,NEW.content_hash,NEW.created_at)
    IS DISTINCT FROM
     (OLD.id,OLD.organization_id,OLD.proposed_by_user_id,OLD.method_id,OLD.prior_version,
      OLD.version,OLD.body,OLD.rationale,OLD.evidence_refs,OLD.content_hash,OLD.created_at)
  THEN RAISE EXCEPTION 'advisory_revision_immutable'; END IF;
  IF OLD.status <> 'pending' AND (NEW.status,NEW.approved_by_user_id,NEW.decided_at)
    IS DISTINCT FROM (OLD.status,OLD.approved_by_user_id,OLD.decided_at)
  THEN RAISE EXCEPTION 'advisory_decision_immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER advisory_playbook_revision_immutable BEFORE UPDATE ON hivemind.advisory_playbook_revisions
  FOR EACH ROW EXECUTE FUNCTION hivemind.protect_advisory_playbook_revision();
