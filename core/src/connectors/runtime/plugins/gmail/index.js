// Connector Runtime V1 — Gmail plugin (connector-wise script, NOT a monolith).
//
// Phase 2: wraps the ONE existing Gmail execution implementation
// (`runGoogleTool` in core/src/connectors/google-native.js — direct Google
// REST) for READ operations. The legacy implementation stays underneath; every
// new call enters through the runtime. Writes (create_draft/send_draft/send)
// are added in Phase 3 with the PendingWrite approval gate.
//
// Canonical names (plan §3): gmail__search, gmail__get_message, gmail__get_thread,
// gmail__list_labels, gmail__list_drafts. Legacy names are declared as inbound
// aliases so Chat/HyperAgents callers keep working during migration.
//
// The provider executor is injected (defaults to the real runGoogleTool) so the
// plugin is testable with a fake — no network, no DB, no OAuth.

import { ConnectorPlugin } from '../../connector-plugin.js';
import { makeResult, jsonContent } from '../../contracts.js';
import { NotConnectedError, ReauthRequiredError, classifyError } from '../../errors.js';
import { runGoogleTool as realRunGoogleTool } from '../../../google-native.js';

// canonical → legacy tool name (the migration map; inbound only)
const READ_MAP = Object.freeze({
  gmail__search: 'gmail_search',
  gmail__get_message: 'gmail_get',
  gmail__get_thread: 'gmail_get_thread',
  gmail__list_labels: 'gmail_list_labels',
  gmail__list_drafts: 'gmail_list_drafts',
});

const READ_SURFACES = ['chat', 'hyperagents', 'tara', 'mcp', 'admin'];

function tool(name, description, inputSchema, extra = {}) {
  return {
    name,
    title: name,
    description,
    inputSchema,
    access: 'read',
    approval: 'never',
    concurrencySafe: true,
    idempotent: true,
    destructive: false,
    openWorld: false,
    timeoutMs: 8000,
    maxResultBytes: 32 * 1024,
    allowedSurfaces: READ_SURFACES,
    legacyName: READ_MAP[name],
    ...extra,
  };
}

export const GMAIL_MANIFEST = {
  id: 'gmail',
  version: '1.0.0',
  displayName: 'Gmail',
  description: 'Search and read authorized Gmail data',
  authProvider: 'gmail',
  connectionAliases: ['gmail', 'google', 'googlemail'],
  supportedSurfaces: READ_SURFACES,
  syncMode: 'none',
  tools: [
    tool('gmail__search',
      'Search the connected Gmail account. Returns id/subject/from/to/date/snippet per message.',
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Gmail search syntax (e.g. from:alice newer_than:7d).' },
          max: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
        },
        required: ['query'],
      }),
    tool('gmail__get_message',
      'Fetch one Gmail message in full (subject/from/to/date/body, body capped 12k).',
      {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', description: 'Gmail message id.' } },
        required: ['id'],
      }),
    tool('gmail__get_thread',
      'Fetch a full Gmail thread (all messages).',
      {
        type: 'object',
        additionalProperties: false,
        properties: { threadId: { type: 'string', description: 'Gmail thread id.' } },
        required: ['threadId'],
      }),
    tool('gmail__list_labels',
      'List Gmail labels (id + name).',
      { type: 'object', additionalProperties: false, properties: {} }),
    tool('gmail__list_drafts',
      'List saved Gmail drafts (draftId/subject/to/snippet).',
      {
        type: 'object',
        additionalProperties: false,
        properties: { max: { type: 'integer', minimum: 1, maximum: 30, default: 10 } },
      }),
  ],
};

// Pull the useful source IDs out of a legacy payload so recall/citation and the
// canonical result metadata can reference provider items. Language-neutral —
// operates on ids only.
function extractSourceIds(canonicalName, payload) {
  try {
    if (canonicalName === 'gmail__search') return (payload.messages || []).map((m) => m.id).filter(Boolean);
    if (canonicalName === 'gmail__get_message') return payload.id ? [payload.id] : [];
    if (canonicalName === 'gmail__get_thread') return (payload.messages || []).map((m) => m.id).filter(Boolean);
    if (canonicalName === 'gmail__list_drafts') return (payload.drafts || []).map((d) => d.draftId).filter(Boolean);
  } catch { /* ignore */ }
  return [];
}

export class GmailPlugin extends ConnectorPlugin {
  /** @param {object} [deps] @param {Function} [deps.execGoogleTool] injectable for tests */
  constructor(deps = {}) {
    super(GMAIL_MANIFEST);
    this._exec = deps.execGoogleTool || realRunGoogleTool;
  }

  async executeTool(toolName, input, context) {
    const legacy = READ_MAP[toolName];
    if (!legacy) {
      // Phase 2 is reads-only; writes land in Phase 3.
      throw new NotConnectedError(`gmail tool "${toolName}" not available in this runtime phase`);
    }
    const scope = { user_id: context.userId, org_id: context.orgId };
    let payload;
    try {
      payload = await this._exec(legacy, input || {}, scope, context.db);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Our own resolveToken throws this stable (non-localized) message when the
      // provider is not connected for the user.
      if (/not connected/i.test(msg)) throw new NotConnectedError('Gmail is not connected for this user', { provider: 'gmail' });
      if (/\b401\b/.test(msg) || /invalid_grant|expired/i.test(msg)) throw new ReauthRequiredError('Gmail requires re-authorization', { provider: 'gmail' });
      throw classifyError(err);
    }
    return makeResult({
      status: 'completed',
      content: jsonContent(payload),
      metadata: { sourceIds: extractSourceIds(toolName, payload || {}) },
    });
  }
}

export function createGmailPlugin(deps) {
  return new GmailPlugin(deps);
}
