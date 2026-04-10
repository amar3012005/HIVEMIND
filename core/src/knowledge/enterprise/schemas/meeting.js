export const meetingSchema = {
  type: 'meeting',
  label: 'Meeting Notes / Reports',
  description: 'Meeting notes, minutes, status reports, and action item trackers',
  required: ['title', 'date'],
  optional: ['attendees', 'agenda_items', 'decisions', 'action_items', 'summary', 'follow_up_date'],
  fields: {
    title: { type: 'string', description: 'Meeting title' },
    date: { type: 'string', description: 'Meeting date (ISO 8601)' },
    attendees: { type: 'array', description: 'List of attendees' },
    agenda_items: { type: 'array', description: 'Agenda items discussed' },
    decisions: { type: 'array', description: 'Decisions made during the meeting' },
    action_items: {
      type: 'array',
      description: 'Action items assigned',
      items: {
        owner: { type: 'string' },
        deadline: { type: 'string' },
        description: { type: 'string' }
      }
    },
    summary: { type: 'string', description: 'Meeting summary' },
    follow_up_date: { type: 'string', description: 'Follow-up meeting date (ISO 8601)' }
  },
  chunkBy: 'agenda_items',
  chunkFallback: 'sections',
  tags: (extracted) => {
    const tags = ['enterprise', 'document_type:meeting'];
    if (Array.isArray(extracted.attendees)) {
      extracted.attendees.forEach(a => {
        if (a) tags.push(`attendee:${String(a).toLowerCase().replace(/\s+/g, '-')}`);
      });
    }
    if (Array.isArray(extracted.action_items)) {
      extracted.action_items.forEach(item => {
        if (item && item.owner) tags.push(`action_owner:${String(item.owner).toLowerCase().replace(/\s+/g, '-')}`);
      });
    }
    return tags;
  }
};
