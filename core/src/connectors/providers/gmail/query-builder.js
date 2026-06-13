/**
 * Gmail query builder — the SINGLE source of truth for translating a
 * HIVEMIND `sync_config` into a Gmail API `q=` search expression.
 *
 * Previously this logic lived in TWO places that drifted apart:
 *   - GmailAdapter._buildGmailQuery (scheduler / incremental path)
 *   - an inline copy in server.js /api/connectors/gmail/sync (manual path)
 * The manual copy lacked keyword / sent-only / chat filters, so the noise
 * floor differed between "Sync now" and auto-sync. This module unifies them.
 *
 * Pure — no `this`, no I/O. Imported by adapter.js, server.js (manual sync),
 * and the preview endpoint.
 */

/**
 * Built-in newsletter / notification sender blocklist applied to every Gmail
 * sync unless `disable_default_blocklist: true`. Each becomes `-from:<addr>`.
 * Wildcards `*@domain` collapse to a domain rule (`-from:domain`). Threads
 * matching these never leave Google — never enter Postgres, embed, or index.
 * @type {string[]}
 */
export const DEFAULT_BLOCK_SENDERS = [
  'noreply@*', 'no-reply@*', 'do-not-reply@*', 'donotreply@*',
  '*@*.substack.com', '*@substack.com',
  '*@info.*', '*@notifications.*', '*@mailer.*', '*@email.*',
  '*@*.newsletter.*', '*@newsletter.*',
  '*@calendar.google.com', '*@accounts.google.com',
  '*@notify.*', '*@updates.*', '*@bounces.*',
];

/**
 * Translate a sync config into a Gmail `q=` expression.
 *
 * Honored config keys:
 *   exclude_categories: ('promotions'|'social'|'updates'|'forums')[] → -category:c
 *   date_range:         '7d'|'30d'|'90d'|'365d'|'all'                → after:YYYY/MM/DD
 *   include_only_sent:  boolean                                      → in:sent
 *   exclude_chats:      boolean (default true)                       → -in:chats
 *   include_keywords:   string[]                                     → kw / "phrase" (AND)
 *   exclude_keywords:   string[]                                     → -kw / -"phrase" (NOT)
 *   block_senders:      string[]  (+ DEFAULT_BLOCK_SENDERS)          → -from:addr
 *   disable_default_blocklist: boolean                               → skip defaults
 *   include_only_with_attachments: boolean                           → has:attachment
 *   folders:            string[]  (only when opts.includeFolders)    → (in:a OR in:b)
 *
 * @param {Record<string, unknown>} config
 * @param {{ includeFolders?: boolean }} [opts]  Manual sync (own threads.list)
 *   needs folders inside `q`; the adapter passes them as `labelIds` instead, so
 *   it leaves this false to avoid double-filtering.
 * @returns {string} Gmail query string ('' when no filters → Gmail returns all).
 */
export function buildGmailQuery(config, opts = {}) {
  if (!config || typeof config !== 'object') return '';
  const { includeFolders = false } = opts;
  const parts = [];

  // Folder inclusion (manual path only). UTC-agnostic OR of label scopes.
  if (includeFolders) {
    const folders = Array.isArray(config.folders) ? config.folders : [];
    if (folders.length > 0 && !folders.includes('ALL')) {
      parts.push(`(${folders.map((f) => `in:${String(f).toLowerCase()}`).join(' OR ')})`);
    }
  }

  // Exclude common noisy Gmail categories
  const excludeCategories = Array.isArray(config.exclude_categories)
    ? config.exclude_categories
    : [];
  excludeCategories.forEach((cat) => {
    const c = String(cat).toLowerCase();
    if (['promotions', 'social', 'updates', 'forums'].includes(c)) {
      parts.push(`-category:${c}`);
    }
  });

  // Date range → after:YYYY/MM/DD (UTC, zero-padded for Gmail correctness)
  if (config.date_range && config.date_range !== 'all') {
    const m = /^(\d+)d$/.exec(String(config.date_range));
    if (m) {
      const days = parseInt(m[1], 10);
      if (Number.isFinite(days) && days > 0) {
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const y = since.getUTCFullYear();
        const mo = String(since.getUTCMonth() + 1).padStart(2, '0');
        const d = String(since.getUTCDate()).padStart(2, '0');
        parts.push(`after:${y}/${mo}/${d}`);
      }
    }
  }

  // Sent-only mode
  if (config.include_only_sent) parts.push('in:sent');

  // Chats are noise for most knowledge workflows
  if (config.exclude_chats !== false) parts.push('-in:chats');

  // Include keywords (AND)
  if (Array.isArray(config.include_keywords)) {
    config.include_keywords.forEach((k) => {
      const kw = String(k).trim();
      if (kw) parts.push(/\s/.test(kw) ? `"${kw}"` : kw);
    });
  }

  // Exclude keywords (NOT)
  if (Array.isArray(config.exclude_keywords)) {
    config.exclude_keywords.forEach((k) => {
      const kw = String(k).trim();
      if (kw) parts.push(/\s/.test(kw) ? `-"${kw}"` : `-${kw}`);
    });
  }

  // Sender blocklist — built-in defaults (unless disabled) + user-supplied.
  const userBlock = Array.isArray(config.block_senders) ? config.block_senders : [];
  const skipDefaults = config.disable_default_blocklist === true;
  const allBlocks = Array.from(new Set([
    ...(skipDefaults ? [] : DEFAULT_BLOCK_SENDERS),
    ...userBlock.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean),
  ]));
  for (const raw of allBlocks) {
    // *@domain.com → -from:domain.com  |  exact addr → -from:addr
    let q = raw;
    if (q.startsWith('*@')) q = q.slice(2);
    if (q.includes(' ')) q = `"${q}"`;
    parts.push(`-from:${q}`);
  }

  // Attachments-only filter
  if (config.include_only_with_attachments) parts.push('has:attachment');

  return parts.join(' ');
}
