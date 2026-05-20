-- Split overloaded default_project_policy column into two clean axes:
--   default_project_policy: who-gets-access when a new project is created
--                            (private | team_inherited | org_visible)
--   memory_save_policy:     where MCP save_memory routes when caller omits project
--                            (private | org-wide | ask)
ALTER TABLE hivemind.organizations
  ADD COLUMN IF NOT EXISTS memory_save_policy VARCHAR(50) NOT NULL DEFAULT 'private';
