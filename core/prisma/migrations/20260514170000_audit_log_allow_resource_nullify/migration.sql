-- Allow FK ON DELETE SET NULL to work on audit_logs.resource_id.
-- Previous rule blocked ALL updates including FK cascades, breaking memory
-- deletion entirely (XX000 "referential integrity query gave unexpected result").
--
-- New rule preserves audit immutability for every field EXCEPT permits
-- nullification of resource_id when a referenced memory is deleted.
-- All other UPDATEs (changing event_type, user_id, payload, etc.) remain
-- silently rejected via DO INSTEAD NOTHING.

DROP RULE IF EXISTS audit_logs_no_update ON hivemind.audit_logs;

CREATE RULE audit_logs_no_update AS
  ON UPDATE TO hivemind.audit_logs
  WHERE NOT (NEW.resource_id IS NULL AND OLD.resource_id IS NOT NULL)
  DO INSTEAD NOTHING;
