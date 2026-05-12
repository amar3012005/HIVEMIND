-- Per-message Slack identity override for Digital Employees.
-- One shared Slack app ("DAVINCI AI") posts on behalf of every employee.
-- chat.postMessage uses these fields (via chat:write.customize scope) so
-- each employee appears with a distinct display name + avatar emoji,
-- even though they share a single Slack app registration.

ALTER TABLE hivemind.digital_employees
  ADD COLUMN IF NOT EXISTS slack_display_name TEXT,
  ADD COLUMN IF NOT EXISTS slack_avatar_emoji TEXT;
