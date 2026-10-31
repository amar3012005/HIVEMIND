-- Change feed for local-first clients ("what changed after this cursor").
-- Additive and idempotent. Apply through the manual SQL release procedure; needs PostgreSQL 13 or newer (xid8).
--
-- Each row of workspace_notifications and digital_employees gets change_xid: the id of the transaction that last wrote it,
-- stamped by trigger so no write path can forget it. Readers return only rows below the snapshot horizon
-- (pg_snapshot_xmin), so a transaction still open when a page is read is never skipped by a later page. Existing rows keep 0.
-- The column default is a constant, so no table is rewritten.
-- Removed employees leave a tombstone (ids and times only). A removed organization leaves none, so erasing a company
-- leaves no residue. Notifications are never deleted one by one, so they need no tombstones.

ALTER TABLE hivemind.workspace_notifications ADD COLUMN IF NOT EXISTS change_xid xid8 NOT NULL DEFAULT '0'::xid8;
ALTER TABLE hivemind.digital_employees ADD COLUMN IF NOT EXISTS change_xid xid8 NOT NULL DEFAULT '0'::xid8;

CREATE TABLE IF NOT EXISTS hivemind.digital_employee_tombstones (
  org_id uuid NOT NULL,
  id uuid NOT NULL,
  change_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  deleted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);

CREATE INDEX IF NOT EXISTS workspace_notifications_change_idx
  ON hivemind.workspace_notifications (org_id, user_id, change_xid, id);
CREATE INDEX IF NOT EXISTS digital_employees_change_idx
  ON hivemind.digital_employees (org_id, change_xid, id);
CREATE INDEX IF NOT EXISTS digital_employee_tombstones_change_idx
  ON hivemind.digital_employee_tombstones (org_id, change_xid, id);

CREATE OR REPLACE FUNCTION hivemind.stamp_change_xid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.change_xid := pg_current_xact_id();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION hivemind.record_employee_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM hivemind.organizations WHERE id = OLD.org_id) THEN
    INSERT INTO hivemind.digital_employee_tombstones (org_id, id)
      VALUES (OLD.org_id, OLD.id)
      ON CONFLICT (org_id, id) DO UPDATE SET change_xid = pg_current_xact_id(), deleted_at = now();
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS workspace_notifications_stamp_change ON hivemind.workspace_notifications;
CREATE TRIGGER workspace_notifications_stamp_change BEFORE INSERT OR UPDATE ON hivemind.workspace_notifications
  FOR EACH ROW EXECUTE FUNCTION hivemind.stamp_change_xid();

DROP TRIGGER IF EXISTS digital_employees_stamp_change ON hivemind.digital_employees;
CREATE TRIGGER digital_employees_stamp_change BEFORE INSERT OR UPDATE ON hivemind.digital_employees
  FOR EACH ROW EXECUTE FUNCTION hivemind.stamp_change_xid();

DROP TRIGGER IF EXISTS digital_employees_tombstone ON hivemind.digital_employees;
CREATE TRIGGER digital_employees_tombstone AFTER DELETE ON hivemind.digital_employees
  FOR EACH ROW EXECUTE FUNCTION hivemind.record_employee_tombstone();
