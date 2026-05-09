/**
 * Microsoft Outlook / Exchange connector — covers Outlook mail, Calendar, and
 * extends to Teams + SharePoint via the same Azure AD OAuth client (Microsoft
 * Graph API).
 *
 * Required env vars (set on control-plane container):
 *   MICROSOFT_TENANT_ID            — Azure AD tenant ID, or "common" for multi-tenant
 *   MICROSOFT_CLIENT_ID            — App registration client ID
 *   MICROSOFT_CLIENT_SECRET        — App registration client secret
 *   MICROSOFT_REDIRECT_URI         — defaults to https://api.hivemind.davinciai.eu:8040/auth/microsoft/callback
 *
 * App registration steps (Azure portal):
 *   1. portal.azure.com → Azure AD → App registrations → New registration
 *   2. Name: "HIVEMIND Connector"
 *   3. Supported account types: Multitenant if you want any Microsoft 365 user;
 *      Single tenant if internal only.
 *   4. Redirect URI: web → https://api.hivemind.davinciai.eu:8040/auth/microsoft/callback
 *   5. After creation: Certificates & secrets → New client secret → save value
 *   6. API permissions → Microsoft Graph → Delegated permissions:
 *        Mail.Read, Calendars.Read, Files.Read.All, Sites.Read.All,
 *        Chat.Read, ChannelMessage.Read.All, User.Read, offline_access
 *   7. Grant admin consent
 *
 * Wiring TODO (backend):
 *   - Add /auth/microsoft (start) + /auth/microsoft/callback (token exchange)
 *     to control-plane-server.js. Pattern matches /auth/google.
 *   - On token exchange, persist tokens via existing oauth-tokens table.
 *   - Add ingestion poller in core/src/ingestion that uses these tokens to call
 *     Microsoft Graph API:
 *       GET /me/messages?$top=50&$orderby=receivedDateTime+desc  (mail)
 *       GET /me/events?$top=50                                   (calendar)
 *       GET /me/joinedTeams                                      (teams list)
 *       GET /teams/{id}/channels/{cid}/messages                  (chat)
 *       GET /sites/root/drives/{drive-id}/root/children          (sharepoint)
 *   - For each item, call this.normalize* methods → POST /api/memories.
 */

export class OutlookConnector {
  /** Mail message → memory. */
  normalizeMessage(msg, { user_id, org_id, project }) {
    return {
      user_id,
      org_id,
      project,
      content: [msg.subject, msg.bodyPreview, msg.body?.content].filter(Boolean).join('\n\n'),
      tags: [
        'outlook',
        'email',
        ...(msg.categories || []),
        ...(msg.flag?.flagStatus === 'flagged' ? ['flagged'] : []),
      ],
      document_date: msg.receivedDateTime || null,
      event_dates: msg.receivedDateTime ? [msg.receivedDateTime] : [],
      source_metadata: {
        source_type: 'outlook-mail',
        source_platform: 'outlook',
        source_id: msg.id,
        thread_id: msg.conversationId || null,
        source_url: msg.webLink || null,
      },
      metadata: {
        from: msg.from?.emailAddress?.address || null,
        from_name: msg.from?.emailAddress?.name || null,
        to: (msg.toRecipients || []).map(r => r.emailAddress?.address).filter(Boolean),
        cc: (msg.ccRecipients || []).map(r => r.emailAddress?.address).filter(Boolean),
        importance: msg.importance || null,
        is_read: msg.isRead || false,
        has_attachments: msg.hasAttachments || false,
      },
    };
  }

  /** Calendar event → memory. */
  normalizeEvent(ev, { user_id, org_id, project }) {
    return {
      user_id,
      org_id,
      project,
      content: [ev.subject, ev.bodyPreview, ev.location?.displayName].filter(Boolean).join('\n\n'),
      tags: ['outlook', 'calendar', ...(ev.categories || [])],
      document_date: ev.start?.dateTime || null,
      event_dates: [ev.start?.dateTime, ev.end?.dateTime].filter(Boolean),
      source_metadata: {
        source_type: 'outlook-calendar',
        source_platform: 'outlook',
        source_id: ev.id,
        source_url: ev.webLink || null,
      },
      metadata: {
        organizer: ev.organizer?.emailAddress?.address || null,
        attendees: (ev.attendees || []).map(a => a.emailAddress?.address).filter(Boolean),
        location: ev.location?.displayName || null,
        is_online: ev.isOnlineMeeting || false,
        meeting_url: ev.onlineMeeting?.joinUrl || null,
        recurrence: ev.recurrence ? 'recurring' : 'single',
      },
    };
  }

  /** Teams channel message → memory. */
  normalizeTeamsMessage(msg, channel, team, { user_id, org_id, project }) {
    return {
      user_id,
      org_id,
      project,
      content: [msg.subject, msg.body?.content].filter(Boolean).join('\n\n'),
      tags: ['teams', `team:${team.displayName}`, `channel:${channel.displayName}`],
      document_date: msg.createdDateTime || null,
      event_dates: msg.createdDateTime ? [msg.createdDateTime] : [],
      source_metadata: {
        source_type: 'teams-message',
        source_platform: 'teams',
        source_id: msg.id,
        thread_id: msg.replyToId || msg.id,
        source_url: msg.webUrl || null,
      },
      metadata: {
        team_id: team.id,
        team_name: team.displayName,
        channel_id: channel.id,
        channel_name: channel.displayName,
        from: msg.from?.user?.displayName || null,
        from_email: msg.from?.user?.email || null,
        message_type: msg.messageType || 'message',
      },
    };
  }

  /** SharePoint document item → memory. */
  normalizeSharepointItem(item, drive, { user_id, org_id, project }) {
    return {
      user_id,
      org_id,
      project,
      content: [item.name, item.description].filter(Boolean).join('\n\n'),
      tags: ['sharepoint', `drive:${drive.name}`, ...(item.tags || [])],
      document_date: item.lastModifiedDateTime || null,
      event_dates: item.lastModifiedDateTime ? [item.lastModifiedDateTime] : [],
      source_metadata: {
        source_type: 'sharepoint-document',
        source_platform: 'sharepoint',
        source_id: item.id,
        source_url: item.webUrl || null,
      },
      metadata: {
        drive_id: drive.id,
        drive_name: drive.name,
        file_size: item.size || 0,
        mime_type: item.file?.mimeType || null,
        modified_by: item.lastModifiedBy?.user?.displayName || null,
        is_folder: !!item.folder,
      },
    };
  }
}
