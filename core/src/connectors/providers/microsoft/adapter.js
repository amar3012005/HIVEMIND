import { BaseProviderAdapter } from '../../framework/provider-adapter.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const PAGE_SIZE = 25;

/**
 * Microsoft Graph adapter — pulls Outlook mail + Calendar events.
 *
 * Teams chat ingestion is technically reachable through the same token
 * (ChannelMessage.Read.All) but adds significant per-team enumeration
 * complexity; left as a follow-up.
 *
 * Cursor shape:
 *   "mail:<delta-or-skiptoken>|cal:<delta-or-skiptoken>"
 * For the initial pass we use $orderby + $top pagination via
 * @odata.nextLink. Switching to Graph's delta API is a drop-in later.
 */
export class MicrosoftAdapter extends BaseProviderAdapter {
  constructor() {
    super({
      providerId: 'microsoft',
      requiredScopes: ['Mail.Read', 'Calendars.Read', 'offline_access', 'User.Read'],
      defaultTags: ['microsoft'],
    });
  }

  async fetchInitial({ accessToken, cursor, context }) {
    return this._fetch({ accessToken, cursor, lookbackDays: 90 });
  }

  async fetchIncremental({ accessToken, cursor, context }) {
    return this._fetch({ accessToken, cursor, lookbackDays: 7 });
  }

  async _fetch({ accessToken, cursor, lookbackDays }) {
    const parsed = _parseCursor(cursor);
    const sinceIso = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
    const [mail, cal] = await Promise.all([
      parsed.mailDone ? _empty() : this._fetchMail({ accessToken, nextLink: parsed.mailNext, sinceIso }),
      parsed.calDone ? _empty() : this._fetchCalendar({ accessToken, nextLink: parsed.calNext, sinceIso }),
    ]);

    const records = [];
    for (const m of mail.items) records.push({ _kind: 'mail', data: m });
    for (const e of cal.items) records.push({ _kind: 'event', data: e });

    const nextCursor = _serializeCursor({
      mailNext: mail.nextLink,
      mailDone: !mail.hasMore,
      calNext: cal.nextLink,
      calDone: !cal.hasMore,
    });
    return { records, nextCursor, hasMore: mail.hasMore || cal.hasMore };
  }

  async _fetchMail({ accessToken, nextLink, sinceIso }) {
    const url = nextLink || `${GRAPH}/me/messages?$top=${PAGE_SIZE}&$orderby=receivedDateTime desc&$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}`;
    const data = await _graphGet(url, accessToken);
    return {
      items: data.value || [],
      nextLink: data['@odata.nextLink'] || null,
      hasMore: Boolean(data['@odata.nextLink']),
    };
  }

  async _fetchCalendar({ accessToken, nextLink, sinceIso }) {
    const url = nextLink || `${GRAPH}/me/events?$top=${PAGE_SIZE}&$orderby=start/dateTime desc&$filter=${encodeURIComponent(`start/dateTime ge '${sinceIso}'`)}`;
    const data = await _graphGet(url, accessToken);
    return {
      items: data.value || [],
      nextLink: data['@odata.nextLink'] || null,
      hasMore: Boolean(data['@odata.nextLink']),
    };
  }

  normalize(record, context) {
    if (record._kind === 'mail') return [this._normalizeMail(record.data, context)];
    if (record._kind === 'event') return [this._normalizeEvent(record.data, context)];
    return [];
  }

  _normalizeMail(msg, context) {
    const bodyText = msg.body?.contentType === 'text'
      ? msg.body.content
      : _stripHtml(msg.body?.content || msg.bodyPreview || '');
    const from = msg.from?.emailAddress?.address || msg.sender?.emailAddress?.address || null;
    return {
      user_id: context.user_id,
      org_id: context.org_id,
      project: null,
      content: [msg.subject || '', bodyText.slice(0, 8000)].filter(Boolean).join('\n\n'),
      title: (msg.subject || '(no subject)').slice(0, 200),
      tags: [
        'microsoft', 'outlook', 'email',
        from ? `from:${from.toLowerCase()}` : null,
        msg.isRead === false ? 'unread' : null,
        msg.flag?.flagStatus === 'flagged' ? 'flagged' : null,
        ...(msg.categories || []).map(c => `cat:${c.toLowerCase().replace(/\s+/g, '-')}`),
      ].filter(Boolean),
      memory_type: 'fact',
      document_date: msg.receivedDateTime || null,
      source_metadata: {
        source_type: 'outlook_message',
        source_platform: 'microsoft',
        source_id: msg.id,
        source_url: msg.webLink || null,
      },
      metadata: {
        from,
        to: (msg.toRecipients || []).map(r => r.emailAddress?.address).filter(Boolean),
        conversation_id: msg.conversationId || null,
      },
    };
  }

  _normalizeEvent(ev, context) {
    const attendees = (ev.attendees || []).map(a => a.emailAddress?.address).filter(Boolean);
    const bodyText = ev.body?.contentType === 'text'
      ? ev.body.content
      : _stripHtml(ev.body?.content || '');
    return {
      user_id: context.user_id,
      org_id: context.org_id,
      project: null,
      content: [
        `${ev.subject || '(untitled)'} @ ${ev.location?.displayName || ''}`,
        bodyText.slice(0, 4000),
        attendees.length ? `Attendees: ${attendees.join(', ')}` : '',
      ].filter(Boolean).join('\n\n'),
      title: (ev.subject || '(untitled)').slice(0, 200),
      tags: [
        'microsoft', 'calendar', 'event',
        ev.isCancelled ? 'cancelled' : null,
        ev.isOnlineMeeting ? 'online-meeting' : null,
        ev.showAs ? `availability:${ev.showAs}` : null,
      ].filter(Boolean),
      memory_type: 'event',
      document_date: ev.start?.dateTime || null,
      source_metadata: {
        source_type: 'outlook_event',
        source_platform: 'microsoft',
        source_id: ev.id,
        source_url: ev.webLink || null,
      },
      metadata: {
        organizer: ev.organizer?.emailAddress?.address || null,
        attendees,
        location: ev.location?.displayName || null,
      },
    };
  }

  dedupeKey(record) {
    if (record._kind === 'mail') return `microsoft:mail:${record.data.id}`;
    if (record._kind === 'event') return `microsoft:event:${record.data.id}`;
    return `microsoft:unknown:${Date.now()}`;
  }
}

// ── helpers ──────────────────────────────────────────────────────
async function _graphGet(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    if (res.status === 401) { const e = new Error('Microsoft Graph 401'); e.status = 401; throw e; }
    const text = await res.text().catch(() => '');
    throw new Error(`Microsoft Graph ${res.status} ${text}`);
  }
  return res.json();
}

function _empty() {
  return { items: [], nextLink: null, hasMore: false };
}

function _parseCursor(cursor) {
  if (!cursor) return { mailNext: null, mailDone: false, calNext: null, calDone: false };
  const parts = String(cursor).split('|');
  const out = { mailNext: null, mailDone: false, calNext: null, calDone: false };
  for (const p of parts) {
    if (p.startsWith('mail:')) {
      const v = p.slice('mail:'.length);
      if (v === 'done') out.mailDone = true; else out.mailNext = v || null;
    } else if (p.startsWith('cal:')) {
      const v = p.slice('cal:'.length);
      if (v === 'done') out.calDone = true; else out.calNext = v || null;
    }
  }
  return out;
}

function _serializeCursor({ mailNext, mailDone, calNext, calDone }) {
  const m = mailDone ? 'mail:done' : `mail:${mailNext || ''}`;
  const c = calDone ? 'cal:done' : `cal:${calNext || ''}`;
  return `${m}|${c}`;
}

function _stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
