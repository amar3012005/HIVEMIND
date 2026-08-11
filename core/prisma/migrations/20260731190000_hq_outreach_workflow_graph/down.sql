-- Rollback only the empty workflow graph tables. Do not run automatically on
-- production: completed workflow evidence is an audit record.
DROP TABLE IF EXISTS hivemind.hq_workflow_artifacts;
DROP TABLE IF EXISTS hivemind.hq_workflow_steps;
DROP TABLE IF EXISTS hivemind.hq_workflows;
