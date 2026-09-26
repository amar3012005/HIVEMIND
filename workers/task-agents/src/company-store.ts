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
  sql`CREATE TABLE IF NOT EXISTS company_playbook_notes (
    id TEXT PRIMARY KEY,
    playbook_id TEXT NOT NULL,
    note TEXT NOT NULL,
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
}
