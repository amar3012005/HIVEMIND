// HIVEMIND Connector Catalog (canonical, server-side)
//
// Single source of truth for "what connectors exist + what they do".
// Frontend mirror lives at:
//   frontend/Da-vinci/src/components/hivemind/app/shared/connectors-catalog.js
// Keep the two in sync when adding a connector.
//
// Two architectural modes:
//   ingestion — scheduled/batch sync via sync-engine → indexed into memories+Qdrant
//   live      — on-demand MCP tool calls (no batch sync, no indexing)
//
// Mode is an array; many providers support both (Notion: ingest its docs +
// expose live page/database tools).

export const CONNECTOR_CATALOG = [
  // ── INGESTION — Google Workspace ──────────────────────────────────────
  {
    id: 'gmail',
    name: 'Gmail',
    category: 'email',
    mode: ['ingestion'],
    authType: 'oauth2',
    status: 'stable',
    description: 'Sync emails into company brain. Threads, attachments, labels.',
    docsUrl: '/hivemind/app/connectors/gmail',
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    category: 'files',
    mode: ['ingestion'],
    authType: 'oauth2',
    status: 'stable',
    description: 'Index Drive docs, sheets, slides. Live search.',
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    category: 'productivity',
    mode: ['ingestion', 'live'],
    authType: 'oauth2',
    status: 'stable',
    description: 'Past events as memory, future events live on demand.',
  },
  {
    id: 'google-docs',
    name: 'Google Docs',
    category: 'docs',
    mode: ['ingestion'],
    authType: 'oauth2',
    status: 'stable',
    description: 'Doc bodies chunked + ingested like KB uploads.',
  },
  {
    id: 'google-sheets',
    name: 'Google Sheets',
    category: 'data',
    mode: ['live'],
    authType: 'oauth2',
    status: 'stable',
    description: 'Live cell + range read on demand.',
  },
  {
    id: 'google-slides',
    name: 'Google Slides',
    category: 'docs',
    mode: ['ingestion'],
    authType: 'oauth2',
    status: 'stable',
    description: 'Presentation text + structure indexed.',
  },
  {
    id: 'google-contacts',
    name: 'Google Contacts',
    category: 'productivity',
    mode: ['live'],
    authType: 'oauth2',
    status: 'stable',
    description: 'Structured contact directory — no memory pollution.',
  },
  {
    id: 'google-tasks',
    name: 'Google Tasks',
    category: 'productivity',
    mode: ['live'],
    authType: 'oauth2',
    status: 'beta',
    description: 'Live task lookup — fetched when AI needs them.',
  },
  {
    id: 'google-chat',
    name: 'Google Chat',
    category: 'comms',
    mode: ['live'],
    authType: 'oauth2',
    status: 'beta',
    description: 'Spaces, messages — live query.',
  },

  // ── INGESTION / LIVE — Microsoft 365 ──────────────────────────────────
  {
    id: 'microsoft365',
    name: 'Microsoft 365',
    category: 'productivity',
    mode: ['ingestion', 'live'],
    authType: 'oauth2',
    status: 'needs_oauth_setup',
    description: 'Outlook mail + Calendar + Teams chat + SharePoint via single Azure AD OAuth.',
    setupHint: 'Set MICROSOFT_CLIENT_ID + MICROSOFT_CLIENT_SECRET on the control plane',
  },

  // ── INGESTION / LIVE — Atlassian ──────────────────────────────────────
  {
    id: 'atlassian',
    name: 'Atlassian (Jira + Confluence)',
    category: 'project',
    mode: ['ingestion', 'live'],
    authType: 'oauth2',
    status: 'needs_oauth_setup',
    description: 'Jira issues + Confluence pages via single Atlassian OAuth 2.0 (3LO).',
    setupHint: 'Set ATLASSIAN_CLIENT_ID + ATLASSIAN_CLIENT_SECRET on the control plane',
  },

  // ── INGESTION / LIVE — Salesforce ─────────────────────────────────────
  {
    id: 'salesforce',
    name: 'Salesforce',
    category: 'crm',
    mode: ['ingestion', 'live'],
    authType: 'oauth2',
    status: 'needs_oauth_setup',
    description: 'Accounts, Opportunities, Cases, Contacts via Salesforce Connected App.',
    setupHint: 'Set SALESFORCE_CLIENT_ID + SALESFORCE_CLIENT_SECRET on the control plane',
  },

  // ── LIVE — Comms ──────────────────────────────────────────────────────
  {
    id: 'slack',
    name: 'Slack',
    category: 'comms',
    mode: ['ingestion', 'live'],
    authType: 'oauth2',
    status: 'stable',
    description: 'Channel messages, threads, files. Both batch sync + live query.',
  },

  // ── INGESTION — Docs/Knowledge ───────────────────────────────────────
  {
    id: 'notion',
    name: 'Notion',
    category: 'docs',
    mode: ['ingestion', 'live'],
    authType: 'oauth2',
    status: 'beta',
    description: 'Pages, databases, blocks. Ingest + live page query.',
  },

  // ── INGESTION / LIVE — Code ──────────────────────────────────────────
  {
    id: 'github',
    name: 'GitHub',
    category: 'code',
    mode: ['ingestion', 'live'],
    authType: 'oauth2',
    status: 'beta',
    description: 'Issues, PRs, code search. Ingest + live tool calls.',
  },

  // ── LIVE — Project ───────────────────────────────────────────────────
  {
    id: 'linear',
    name: 'Linear',
    category: 'project',
    mode: ['live'],
    authType: 'api_key',
    status: 'beta',
    description: 'Live issue queries via Linear GraphQL.',
  },

  // ── INGESTION / LIVE — CRM/Marketing ─────────────────────────────────
  {
    id: 'hubspot',
    name: 'HubSpot',
    category: 'crm',
    mode: ['ingestion', 'live'],
    authType: 'oauth2',
    status: 'planned',
    description: 'Contacts, deals, companies, tickets.',
  },

  // ── INGESTION — Database ─────────────────────────────────────────────
  {
    id: 'postgres',
    name: 'PostgreSQL',
    category: 'database',
    mode: ['ingestion'],
    authType: 'connection_string',
    status: 'planned',
    description: 'Read-only table sync with column-level allowlist.',
  },

  // ── INGESTION — Manual ───────────────────────────────────────────────
  {
    id: 'file-upload',
    name: 'File Upload',
    category: 'files',
    mode: ['ingestion'],
    authType: 'none',
    status: 'stable',
    description: 'Drop files into Knowledge Base. PDF, DOCX, TXT, MD, code.',
    docsUrl: '/hivemind/app/knowledge',
  },

  // ── INGESTION — Web ──────────────────────────────────────────────────
  {
    id: 'web-crawl',
    name: 'Web Crawl',
    category: 'web',
    mode: ['ingestion'],
    authType: 'none',
    status: 'stable',
    description: 'Crawl URL into chunks. Tavily-backed.',
  },
];

export const CONNECTOR_BY_ID = Object.fromEntries(CONNECTOR_CATALOG.map(c => [c.id, c]));

export const CONNECTOR_CATEGORIES = [
  { id: 'email', name: 'Email' },
  { id: 'files', name: 'Files' },
  { id: 'docs', name: 'Documents & Knowledge' },
  { id: 'data', name: 'Data & Spreadsheets' },
  { id: 'productivity', name: 'Productivity' },
  { id: 'comms', name: 'Communication' },
  { id: 'crm', name: 'CRM & Sales' },
  { id: 'project', name: 'Project Management' },
  { id: 'code', name: 'Code & DevOps' },
  { id: 'database', name: 'Databases' },
  { id: 'web', name: 'Web' },
];

export const CONNECTOR_MODES = {
  ingestion: {
    label: 'Ingestion',
    description: 'Scheduled batch sync → indexed into memory + Qdrant. Best for "search company knowledge".',
  },
  live: {
    label: 'Live (MCP)',
    description: 'On-demand tool calls. Best for "let the AI act on/query live data without storing it".',
  },
};
