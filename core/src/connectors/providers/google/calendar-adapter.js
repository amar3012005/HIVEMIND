/**
 * Google Calendar adapter — pre-ingests PAST events as event-typed memories.
 * Future events stay live-only (router fetches when needed).
 *
 * Strategy:
 *   - Initial backfill: last 365 days of events
 *   - Incremental: nextSyncToken from previous run
 *   - memory_type = 'event' so decay/strength logic from Phase 6 applies
 *   - skipProcessing = true → no fact extraction garbage
 */

import { BaseProviderAdapter } from '../../framework/provider-adapter.js';
import { WorkspaceMcpBridge } from './workspace-mcp-bridge.js';

const BACKFILL_DAYS = 365;
const PAGE_SIZE = 100;

export class GoogleCalendarAdapter extends BaseProviderAdapter {
  constructor({ prisma, decryptToken, refreshOAuthToken, mcpUrl }) {
    super({
      providerId: 'google_calendar',
      requiredScopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      defaultTags: ['google-calendar'],
    });
    this.bridge = new WorkspaceMcpBridge({ prisma, decryptToken, refreshOAuthToken, mcpUrl });
  }

  async fetchInitial({ accessToken, cursor, context }) {
    const userId = context.user_id;
    const timeMin = new Date(Date.now() - BACKFILL_DAYS * 86400000).toISOString();
    const timeMax = new Date().toISOString(); // only past events

    const args = {
      calendar_id: 'primary',
      time_min: timeMin,
      time_max: timeMax,
      max_results: PAGE_SIZE,
      single_events: true,
      order_by: 'startTime',
    };
    if (cursor) args.page_token = cursor;

    const result = await this.bridge.callTool(userId, 'list_calendar_events', args);
    const items = this._parseListResult(result);
    const nextCursor = this._extractNextPageToken(result);
    return { records: items, nextCursor, hasMore: !!nextCursor };
  }

  async fetchIncremental({ accessToken, cursor, context }) {
    // Calendar sync tokens are returned by Google after a full listing.
    // workspace-mcp's list_calendar_events tool may or may not expose syncToken.
    // For now: fall back to recent-window incremental.
    if (!cursor) return this.fetchInitial({ accessToken, cursor: null, context });
    const userId = context.user_id;
    try {
      const result = await this.bridge.callTool(userId, 'list_calendar_events', {
        calendar_id: 'primary',
        sync_token: cursor,
        max_results: PAGE_SIZE,
      });
      const items = this._parseListResult(result);
      const nextCursor = this._extractSyncToken(result) || cursor;
      return { records: items, nextCursor, hasMore: false };
    } catch (err) {
      if (/(invalid|expired).*sync.*token/i.test(err.message)) {
        return this.fetchInitial({ accessToken, cursor: null, context });
      }
      throw err;
    }
  }

  normalize(event, context) {
    if (!event || event.status === 'cancelled') return [];

    const startTime = event.start?.dateTime || event.start?.date;
    const endTime = event.end?.dateTime || event.end?.date;
    if (!startTime) return [];

    const attendees = event.attendees || [];
    const attendeeEmails = attendees.map(a => a.email).filter(Boolean);

    const content = [
      `**Event:** ${event.summary || '(no title)'}`,
      event.description ? `\n${event.description}` : null,
      `\n**Date:** ${startTime}${endTime && endTime !== startTime ? ` → ${endTime}` : ''}`,
      event.location ? `**Location:** ${event.location}` : null,
      attendeeEmails.length > 0 ? `**Attendees:** ${attendeeEmails.join(', ')}` : null,
      event.organizer?.email ? `**Organizer:** ${event.organizer.email}` : null,
    ].filter(Boolean).join('\n');

    // Rich, queryable tags: organizer, attendee emails, year-month bucket,
    // recurrence flag, location slug. Matches Gmail / Drive enrichment.
    const tags = new Set([...(this.defaultTags || []), 'google_calendar', 'calendar_event']);
    attendeeEmails.forEach((e) => {
      const lo = String(e).toLowerCase();
      tags.add(`with:${lo}`);
      tags.add(`attendee:${lo}`);
    });
    if (event.organizer?.email) {
      tags.add(`organizer:${String(event.organizer.email).toLowerCase()}`);
    }
    // Time bucket: yyyy-mm + year
    try {
      const d = new Date(startTime);
      if (!isNaN(d)) {
        tags.add(`yyyy-mm:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
        tags.add(`year:${d.getUTCFullYear()}`);
      }
    } catch { /* ignore */ }
    // Title slug for fuzzy recall on event name
    if (event.summary) {
      const slug = String(event.summary).toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
      if (slug) tags.add(`event:${slug}`);
    }
    if (event.location) tags.add('has-location');
    if (event.recurringEventId || (Array.isArray(event.recurrence) && event.recurrence.length > 0)) {
      tags.add('recurring');
    }
    if (event.attachments?.length > 0) tags.add('has-attachments');
    if (event.conferenceData?.entryPoints?.length > 0) tags.add('has-video-call');

    return [{
      user_id: context.user_id,
      org_id: context.org_id,
      project: null,
      content,
      title: event.summary || 'Untitled Event',
      tags: [...tags],
      // Provider-specific type — distinguish from generic 'event' rows
      // so filters/facets can partition calendar entries cleanly.
      memory_type: 'event',
      skipProcessing: true,
      document_date: startTime,
      event_dates: [startTime, endTime].filter(Boolean),
      source_metadata: {
        source_type: 'google_calendar',
        source_platform: 'google_calendar',
        source_id: `calendar:${event.id}`,
        source_url: event.htmlLink,
      },
      metadata: {
        type: 'calendar_event',
        calendar_event_id: event.id,
        summary: event.summary,
        start: startTime,
        end: endTime,
        location: event.location,
        attendees: attendeeEmails,
        organizer: event.organizer?.email,
        status: event.status,
        recurring: !!event.recurringEventId || (Array.isArray(event.recurrence) && event.recurrence.length > 0),
        recurring_event_id: event.recurringEventId || null,
        conference: event.conferenceData?.entryPoints?.[0]?.uri || null,
        attachment_count: event.attachments?.length || 0,
      },
    }];
  }

  dedupeKey(event) {
    return `calendar:${event.id}:${event.updated || event.created || ''}`;
  }

  _parseListResult(toolResult) {
    if (!toolResult?.content?.length) return [];
    try {
      const parsed = JSON.parse(toolResult.content[0].text);
      return parsed.events || parsed.items || (Array.isArray(parsed) ? parsed : []);
    } catch { return []; }
  }

  _extractNextPageToken(toolResult) {
    try {
      const parsed = JSON.parse(toolResult?.content?.[0]?.text || '{}');
      return parsed.nextPageToken || parsed.next_page_token || null;
    } catch { return null; }
  }

  _extractSyncToken(toolResult) {
    try {
      const parsed = JSON.parse(toolResult?.content?.[0]?.text || '{}');
      return parsed.nextSyncToken || parsed.sync_token || null;
    } catch { return null; }
  }
}
