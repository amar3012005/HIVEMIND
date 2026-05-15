/**
 * Google Contacts adapter — pre-ingests into structured `contacts` table.
 * NO memory pollution. Contacts are queryable by email/name/domain.
 */

import { BaseProviderAdapter } from '../../framework/provider-adapter.js';
import { WorkspaceMcpBridge } from './workspace-mcp-bridge.js';

const PAGE_SIZE = 100;

export class GoogleContactsAdapter extends BaseProviderAdapter {
  constructor({ prisma, decryptToken, refreshOAuthToken, mcpUrl }) {
    super({
      providerId: 'google_contacts',
      requiredScopes: ['https://www.googleapis.com/auth/contacts.readonly'],
      defaultTags: ['google-contacts'],
    });
    this.bridge = new WorkspaceMcpBridge({ prisma, decryptToken, refreshOAuthToken, mcpUrl });
    this.prisma = prisma;
  }

  async fetchInitial({ accessToken, cursor, context }) {
    const userId = context.user_id;
    const args = { page_size: PAGE_SIZE };
    if (cursor) args.page_token = cursor;
    const result = await this.bridge.callTool(userId, 'list_contacts', args);
    const items = this._parseListResult(result);
    const nextCursor = this._extractNextPageToken(result);
    return { records: items, nextCursor, hasMore: !!nextCursor };
  }

  async fetchIncremental({ accessToken, cursor, context }) {
    // People API supports syncToken; same cursor field
    return this.fetchInitial({ accessToken, cursor, context });
  }

  /**
   * Contacts go to the contacts table, NOT memories. Return empty payloads
   * so the sync engine doesn't try to ingest them as memories.
   * The extractStructured hook does the actual contact upsert.
   */
  normalize(_contact, _context) {
    return [];
  }

  /**
   * Called by sync engine after normalize() — writes structured contacts.
   */
  async extractStructured(contact, ctx) {
    if (!ctx?.prisma || !contact) return;
    const { ContactsStore } = await import('../gmail/contacts-store.js');
    const store = new ContactsStore(ctx.prisma);

    const primaryEmail = contact.emailAddresses?.[0]?.value;
    if (!primaryEmail) return;

    const displayName = contact.names?.[0]?.displayName
      || [contact.names?.[0]?.givenName, contact.names?.[0]?.familyName].filter(Boolean).join(' ')
      || null;

    await store.upsert({
      userId: ctx.user_id,
      orgId: ctx.org_id,
      email: primaryEmail,
      displayName,
      sourcePlatform: 'google_contacts',
    });
  }

  dedupeKey(contact) {
    return `gcontact:${contact.resourceName || contact.id || ''}`;
  }

  _parseListResult(toolResult) {
    if (!toolResult?.content?.length) return [];
    try {
      const parsed = JSON.parse(toolResult.content[0].text);
      return parsed.connections || parsed.contacts || parsed.results || (Array.isArray(parsed) ? parsed : []);
    } catch { return []; }
  }

  _extractNextPageToken(toolResult) {
    try {
      const parsed = JSON.parse(toolResult?.content?.[0]?.text || '{}');
      return parsed.nextPageToken || parsed.next_sync_token || null;
    } catch { return null; }
  }
}
