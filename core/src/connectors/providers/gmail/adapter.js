/**
 * Gmail Provider Adapter — thin orchestrator.
 *
 * Owns ONLY: Gmail API transport + fetch/pagination + the engine contract
 * (fetchInitial / fetchIncremental / normalize / dedupeKey / extractStructured).
 *
 * Delegates:
 *   - query construction → ./query-builder.js  (buildGmailQuery)
 *   - record → payloads   → ./normalizer.js    (normalizeThread)
 *   - body / noise        → ./noise-filter.js  (via normalizer)
 *   - config shape        → ./schema.js
 */

import { BaseProviderAdapter } from '../../framework/provider-adapter.js';
import { buildGmailQuery } from './query-builder.js';
import { normalizeThread } from './normalizer.js';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_RESULTS_PER_PAGE = 50;
const DEFAULT_RUN_CAP = 200; // max threads fetched per runSync tick (503 guard)

export class GmailAdapter extends BaseProviderAdapter {
  constructor() {
    super({
      providerId: 'gmail',
      requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      defaultTags: ['gmail'],
    });
    // Per-sync-run cumulative thread counter. The scheduler creates ONE adapter
    // instance per runSync and loops fetchInitial across pages, so this persists
    // for the whole run. A full backfill paginating unbounded (50/page) with
    // per-thread LLM entity extraction pegged the 2-core box and starved the
    // HTTP loop (→ 503). Cap each run; incremental ticks pick up the rest.
    this._fetchedThisRun = 0;
  }

  /**
   * Full backfill: list threads (filtered at q= time), then fetch each thread.
   * @param {{ accessToken: string, cursor: string|null, context: object }} params
   */
  async fetchInitial({ accessToken, cursor, context }) {
    const params = new URLSearchParams({ maxResults: String(MAX_RESULTS_PER_PAGE) });
    if (cursor) params.set('pageToken', cursor);

    // Enforce the user's sync config at FETCH time (Gmail q=). The adapter path
    // passes folders as labelIds (below), so buildGmailQuery omits them here.
    const q = buildGmailQuery(context?.config || {});
    if (q) params.set('q', q);

    const folders = context?.config?.folders || [];
    if (Array.isArray(folders) && folders.length > 0) {
      folders.forEach((f) => params.append('labelIds', String(f).toUpperCase()));
    }

    const response = await this._gmailFetch(`/threads?${params}`, accessToken);
    const threads = response.threads || [];

    const { records, auth401s } = await this._fetchThreads(threads.map((t) => t.id), accessToken);
    this._escalateIfTokenDead(auth401s, threads.length, records.length, 'backfill');

    // Per-run thread cap: stop paginating once this run yields max_emails
    // threads. The cursor is still returned so a manual re-sync resumes; once
    // an incremental historyId cursor exists each tick is tiny.
    this._fetchedThisRun += records.length;
    const runCap = Number(context?.config?.max_emails) > 0
      ? Number(context.config.max_emails)
      : DEFAULT_RUN_CAP;
    const capReached = this._fetchedThisRun >= runCap;
    if (capReached) {
      console.log(`[gmail-adapter] per-run cap reached (${this._fetchedThisRun}/${runCap}) — stopping pagination this tick`);
    }

    return {
      records,
      nextCursor: response.nextPageToken || null,
      hasMore: !!response.nextPageToken && !capReached,
    };
  }

  /**
   * Incremental sync using the Gmail history API. Cursor is a Gmail historyId.
   * Falls back to full sync when the historyId is too old (404).
   */
  async fetchIncremental({ accessToken, cursor, context }) {
    if (!cursor) return this.fetchInitial({ accessToken, cursor: null, context });

    const params = new URLSearchParams({
      startHistoryId: cursor,
      historyTypes: 'messageAdded',
      maxResults: String(MAX_RESULTS_PER_PAGE),
    });

    let response;
    try {
      response = await this._gmailFetch(`/history?${params}`, accessToken);
    } catch (err) {
      if (err.status === 404) return this.fetchInitial({ accessToken, cursor: null, context });
      throw err;
    }

    const newHistoryId = response.historyId;
    const threadIds = new Set();
    for (const h of response.history || []) {
      for (const added of h.messagesAdded || []) {
        if (added.message?.threadId) threadIds.add(added.message.threadId);
      }
    }

    const { records, auth401s } = await this._fetchThreads([...threadIds], accessToken);
    this._escalateIfTokenDead(auth401s, threadIds.size, records.length, 'incremental');

    return {
      records,
      nextCursor: newHistoryId || cursor,
      hasMore: !!response.nextPageToken,
    };
  }

  /** Transform a raw Gmail thread into memory payloads (delegates to normalizer). */
  normalize(thread, context) {
    return normalizeThread(thread, context, { defaultTags: this.defaultTags });
  }

  /** Idempotency key for a thread record. */
  dedupeKey(thread) {
    return `gmail:thread:${thread.id}`;
  }

  /**
   * Post-normalize structured extraction: upsert sender/recipient contacts into
   * hivemind.contacts from every message header. Prevents "Fact: X email is
   * Y@z.com" memory pollution. Called by SyncEngine after normalize().
   */
  async extractStructured(thread, ctx) {
    if (!ctx?.prisma) return;
    try {
      const { ContactsStore } = await import('./contacts-store.js');
      const store = new ContactsStore(ctx.prisma);
      for (const msg of thread.messages || []) {
        const headers = {};
        for (const h of (msg.payload?.headers || [])) headers[h.name.toLowerCase()] = h.value;
        const eventDate = headers['date'] ? new Date(headers['date']) : null;
        await store.upsertFromMessageHeaders({
          userId: ctx.user_id,
          orgId: ctx.org_id,
          headers,
          sourcePlatform: 'gmail',
          eventDate,
        });
      }
    } catch (err) {
      console.warn(`[gmail-adapter] extractStructured failed: ${err.message}`);
    }
  }

  // ─── Internal transport ──────────────────────────────────────

  /**
   * Fetch a set of full threads. Counts 401s so a dead token escalates to
   * reauth instead of an empty-success that strands the FE on "Error".
   * @returns {Promise<{ records: object[], auth401s: number }>}
   */
  async _fetchThreads(threadIds, accessToken) {
    const records = [];
    let auth401s = 0;
    for (const id of threadIds) {
      try {
        records.push(await this._gmailFetch(`/threads/${id}?format=full`, accessToken));
      } catch (err) {
        if (err.status === 401 || /\b401\b/.test(err.message || '')) auth401s++;
        else console.warn(`[gmail-adapter] Failed to fetch thread ${id}: ${err.message}`);
      }
    }
    return { records, auth401s };
  }

  /** Throw a 401-shaped error when the majority of thread fetches died on auth. */
  _escalateIfTokenDead(auth401s, total, fetched, phase) {
    if (auth401s > 0 && (fetched === 0 || auth401s >= Math.ceil(total / 2))) {
      const e = new Error(`Gmail token rejected (${auth401s}/${total} ${phase} threads returned 401)`);
      e.status = 401;
      throw e;
    }
  }

  async _gmailFetch(path, accessToken) {
    const response = await fetch(`${GMAIL_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      const error = new Error(`Gmail API ${response.status}: ${await response.text()}`);
      error.status = response.status;
      error.response = { status: response.status };
      throw error;
    }
    return response.json();
  }
}
