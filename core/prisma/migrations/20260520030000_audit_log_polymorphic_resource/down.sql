ALTER TABLE hivemind.audit_logs
  ADD CONSTRAINT audit_logs_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES hivemind.memories(id) ON UPDATE CASCADE ON DELETE SET NULL;
