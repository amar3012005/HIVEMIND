export class GmailConnector {
  normalizeThread(thread, { user_id, org_id, project }) {
    return (thread.messages || []).map(message => ({
      user_id,
      org_id,
      project,
      content: [message.subject, message.snippet, message.body].filter(Boolean).join('\n\n'),
      tags: ['gmail', ...(thread.labels || [])],
      document_date: message.internalDate || null,
      event_dates: message.internalDate ? [message.internalDate] : [],
      source_metadata: {
        source_type: 'gmail',
        source_platform: 'gmail',
        source_id: message.id,
        thread_id: thread.id,
        parent_message_id: message.inReplyTo || null,
        source_url: message.permalink || null
      },
      metadata: {
        from: message.from || null,
        to: message.to || [],
        cc: message.cc || [],
        labels: thread.labels || []
      }
    }));
  }
}
