-- Org-container provisioning: per-org Qdrant collection link.
-- Holds ALL memory+evidence for the org (org_<id>); members + projects share
-- it, separated by user_id/project_id/layer payload filters. Null until
-- provisioned on org creation. Backward-compatible (nullable, no default).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS vector_container VARCHAR(255);
