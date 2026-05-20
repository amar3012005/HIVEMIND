-- audit_logs.resource_id is polymorphic (memory id / project id / invite id / api_key id / org_id).
-- The lingering FK to memories(id) blocks all non-memory audit writes. Drop it.
ALTER TABLE hivemind.audit_logs DROP CONSTRAINT IF EXISTS audit_logs_resource_id_fkey;
