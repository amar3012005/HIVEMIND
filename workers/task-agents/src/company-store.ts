export interface StoredArtifact {
  id: string;
  kind: string;
  title: string;
  contentType: string;
  body: string;
  storageLocation: string;
  createdAt: string;
}

export function ensureCompanyTables(sql: {
  (strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): unknown[];
}): void {
  sql`CREATE TABLE IF NOT EXISTS company_artifacts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    content_type TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    storage_location TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`;
  sql`CREATE TABLE IF NOT EXISTS company_runs (
    id TEXT PRIMARY KEY,
    employee_slug TEXT NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL,
    playbook_id TEXT NOT NULL DEFAULT '',
    playbook_snapshot TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`;
  sql`CREATE TABLE IF NOT EXISTS company_workrun_index (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    room_name TEXT NOT NULL,
    employee_slug TEXT NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL,
    playbook_id TEXT NOT NULL,
    playbook_version INTEGER NOT NULL,
    snapshot_hash TEXT NOT NULL,
    artifact_refs TEXT NOT NULL DEFAULT '[]',
    source_refs TEXT NOT NULL DEFAULT '[]',
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  sql`CREATE TABLE IF NOT EXISTS connected_write_attempts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    tool_slug TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    status TEXT NOT NULL,
    receipt TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  sql`CREATE TABLE IF NOT EXISTS company_playbook_notes (
    id TEXT PRIMARY KEY,
    playbook_id TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
  sql`CREATE TABLE IF NOT EXISTS company_playbook_proposals (
    id TEXT PRIMARY KEY,
    playbook_id TEXT NOT NULL,
    instruction TEXT NOT NULL,
    source_run_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_review',
    created_at TEXT NOT NULL
  )`;
  sql`CREATE TABLE IF NOT EXISTS company_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    stage TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`;
  sql`CREATE TABLE IF NOT EXISTS source_read_receipts (
    run_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    url TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    read_at TEXT NOT NULL,
    PRIMARY KEY (run_id, url)
  )`;
}
