// HIVEMIND Connector Catalog — server-side canonical copy
//
// This file is the authoritative server-side catalog.  The FE mirror lives at:
//   frontend/Da-vinci/src/components/hivemind/app/shared/connectors-catalog.js
// Keep the two in sync whenever a connector is added or modified.
//
// Two architectural modes:
//   ingestion — scheduled/batch sync via sync-engine → indexed into memories+Qdrant
//   live      — on-demand MCP tool calls (no batch sync, no indexing)
//
// Fields
//   id            — snake-case unique key, matches nango provider id where applicable
//   name          — human-readable display name
//   description   — one-liner shown in UI and API responses
//   category      — one of the ids in CONNECTOR_CATEGORIES
//   mode          — array of 'ingestion' | 'live'
//   authType      — 'oauth2' | 'api_key' | 'connection_string' | 'none'
//   status        — 'stable' | 'beta' | 'planned' | 'needs_oauth_setup'
//   nangoProvider — Nango provider key (omit for non-Nango connectors)
//   setupHint     — optional string shown to org-admins who need to configure OAuth
//   docsUrl       — optional internal docs path

'use strict';

/** @type {Array<{
 *   id: string,
 *   name: string,
 *   description: string,
 *   category: string,
 *   mode: string[],
 *   authType: string,
 *   status: string,
 *   nangoProvider?: string,
 *   setupHint?: string,
 *   docsUrl?: string,
 * }>} */
const CONNECTOR_CATALOG = [
  // ── INGESTION — Google Workspace ──────────────────────────────────────
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Sync emails into company brain. Threads, attachments, labels.',
    category: 'email',
    mode: ['ingestion'],
    authType: 'oauth2',
    status: 'stable',
    docsUrl: '/hivemind/app/connectors/gmail',
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: 'Index Drive docs, sheets, slides. Live search.',
    category: 'files',
    mode: ['ingestion'],
    authType: 'oauth2',
    status: 'stable',
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    description: 'Past events as memory, future events live on demand.',
    category: 'productivity',
    mode: ['ingestion', 'live'],
    authType: 'oauth2',
    status: 'stable',
  },
  {
    id: 'google-docs',
    name: 'Google Docs',
    description: 'Doc bodies chunked + ingested like KB uploads.',
    category: 'docs',
    mode: ['ingestion'],
    authType: 'oauth2',
    status: 'stable',
  },
  {
    id: 'google-sheets',
    name: 'Google Sheets',
    description: 'Live cell + range read on demand.',
    category: 'data',
    mode: ['live'],
    authType: 'oauth2',
    status: 'stable',
  },
  {
    id: 'google-slides',
    name: 'Google Slides',
    description: 'Presentation text + structure indexed.',
    category: 'docs',
    mode: ['ingestion'],
    authType: 'oauth2',
    status: 'stable',
  },
  {
    id: 'google-contacts',
    name: 'Google Contacts',
    description: 'Structured contact directory — no memory pollution.',
    category: 'productivity',
    mode: ['live'],
    authType: 'oauth2',
    status: 'stable',
  },
  {
    id: 'google-tasks',
    name: 'Google Tasks',
    description: 'Live task lookup — fetched when AI needs them.',
    category: 'productivity',
    mode: ['live'],
    authType: 'oauth2',
    status: 'beta',
  },
  {
    id: 'google-chat',
    name: 'Google Chat',
    description: 'Spaces, messages — live query.',
    category: 'comms',
    mode: ['live'],
    authType: 'oauth2',
    status: 'beta',
  },

  // ── INGESTION / LIVE — Microsoft 365 ──────────────────────────────────
  {
    id: 'microsoft365',
    name: 'Microsoft 365',
    description: 'Outlook mail + Calendar + Teams chat + SharePoint via single Azure AD OAuth.',
    category: 'productivity',
    mode: ['ingestion', 'live'],
    authType: 'oauth2',
    status: 'needs_oauth_setup',
    setupHint: 'Set MICROSOFT_CLIENT_ID + MICROSOFT_CLIENT_SECRET on the control plane',
  },

  // ── INGESTION / LIVE — Atlassian ──────────────────────────────────────
  {
    id: 'atlassian',
    name: 'Atlassian (Jira + Confluence)',
    description: 'Jira issues + Confluence pages via single Atlassian OAuth 2.0 (3LO).',
    category: 'project',
    mode: ['ingestion', 'live'],
    authType: 'oauth2',
    status: 'needs_oauth_setup',
    setupHint: 'Set ATLASSIAN_CLIENT_ID + ATLASSIAN_CLIENT_SECRET on the control plane',
  },

  // ── INGESTION / LIVE — Salesforce ─────────────────────────────────────
  {
    id: 'salesforce',
    name: 'Salesforce',
    description: 'Accounts, Opportunities, Cases, Contacts via Salesforce Connected App.',
    category: 'crm',
    mode: ['ingestion', 'live'],
    authType: 'oauth2',
    status: 'needs_oauth_setup',
    setupHint: 'Set SALESFORCE_CLIENT_ID + SALESFORCE_CLIENT_SECRET on the control plane',
  },

  // ── INGESTION / LIVE — Comms ──────────────────────────────────────────
  {
    id: 'slack',
    name: 'Slack',
    description: 'Channel messages, threads, files. Both batch sync + live query.',
    category: 'comms',
    mode: ['ingestion', 'live'],
    authType: 'oauth2',
    status: 'stable',
  },

  // ── INGESTION / LIVE — Docs/Knowledge ────────────────────────────────
  {
    id: 'notion',
    name: 'Notion',
    description: 'Pages, databases, blocks. Ingest + live page query.',
    category: 'docs',
    mode: ['ingestion', 'live'],
    authType: 'oauth2',
    status: 'beta',
  },

  // ── INGESTION / LIVE — Code ──────────────────────────────────────────
  {
    id: 'github',
    name: 'GitHub',
    description: 'Issues, PRs, code search. Ingest + live tool calls.',
    category: 'code',
    mode: ['ingestion', 'live'],
    authType: 'oauth2',
    status: 'beta',
  },

  // ── LIVE — Project ───────────────────────────────────────────────────
  {
    id: 'linear',
    name: 'Linear',
    description: 'Live issue queries via Linear GraphQL.',
    category: 'project',
    mode: ['live'],
    authType: 'api_key',
    status: 'beta',
  },

  // ── INGESTION / LIVE — CRM/Marketing ─────────────────────────────────
  {
    id: 'hubspot',
    name: 'HubSpot',
    description: 'Contacts, deals, companies, tickets.',
    category: 'crm',
    mode: ['ingestion', 'live'],
    authType: 'oauth2',
    status: 'planned',
  },

  // ── INGESTION — Database ─────────────────────────────────────────────
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Read-only table sync with column-level allowlist.',
    category: 'database',
    mode: ['ingestion'],
    authType: 'connection_string',
    status: 'planned',
  },

  // ── INGESTION — Manual ───────────────────────────────────────────────
  {
    id: 'file-upload',
    name: 'File Upload',
    description: 'Drop files into Knowledge Base. PDF, DOCX, TXT, MD, code.',
    category: 'files',
    mode: ['ingestion'],
    authType: 'none',
    status: 'stable',
    docsUrl: '/hivemind/app/knowledge',
  },

  // ── INGESTION — Web ──────────────────────────────────────────────────
  {
    id: 'web-crawl',
    name: 'Web Crawl',
    description: 'Crawl URL into chunks. Tavily-backed.',
    category: 'web',
    mode: ['ingestion'],
    authType: 'none',
    status: 'stable',
  },

  // ── INGESTION — HR ───────────────────────────────────────────────────
  {
    id: 'personio-v2',
    name: 'Personio',
    description: 'HR management — employees, departments, positions, org chart',
    category: 'hr',
    nangoProvider: 'personio-v2',
    mode: ['ingestion'],
    authType: 'oauth2',
    status: 'beta',
  },

  // ── INGESTION — Accounting ────────────────────────────────────────────
  {
    id: 'datev',
    name: 'DATEV',
    description: 'German accounting and payroll — invoices, bookkeeping, payroll data',
    category: 'accounting',
    nangoProvider: 'datev',
    mode: ['ingestion'],
    authType: 'oauth2',
    status: 'planned',
  },

  // ── INGESTION — ERP ───────────────────────────────────────────────────
  {
    id: 'sap-business-one',
    name: 'SAP Business One',
    description: 'ERP — business processes, inventory, financials, sales orders',
    category: 'erp',
    nangoProvider: 'sap-business-one',
    mode: ['ingestion'],
    authType: 'oauth2',
    status: 'planned',
  },
];

/** @type {Record<string, typeof CONNECTOR_CATALOG[number]>} */
const CONNECTOR_BY_ID = Object.fromEntries(CONNECTOR_CATALOG.map((c) => [c.id, c]));

const CONNECTOR_CATEGORIES = [
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
  { id: 'hr', name: 'HR & People' },
  { id: 'accounting', name: 'Accounting & Finance' },
  { id: 'erp', name: 'ERP' },
];

const CONNECTOR_MODES = {
  ingestion: {
    label: 'Ingestion',
    description:
      'Scheduled batch sync → indexed into memory + Qdrant. Best for "search company knowledge".',
  },
  live: {
    label: 'Live (MCP)',
    description:
      'On-demand tool calls. Best for "let the AI act on/query live data without storing it".',
  },
};

export { CONNECTOR_CATALOG, CONNECTOR_BY_ID, CONNECTOR_CATEGORIES, CONNECTOR_MODES };
