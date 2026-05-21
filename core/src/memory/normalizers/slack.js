// Slack / Teams / Discord normalizer.
// Resolves <@USERID> mentions when the payload carries a user map, strips
// link wrappers like <https://...>, and preserves channel + thread refs
// on metadata for retrieval.
export const slack = {
  name: 'slack',
  normalize(content, metadata = {}) {
    let body = content || '';

    // <@U12345|amar> → @amar  (or fallback to user id if no label)
    body = body.replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id, label) => `@${label || id}`);

    // <#C12345|general> → #general
    body = body.replace(/<#([A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id, label) => `#${label || id}`);

    // <https://example.com|label> → label (https://example.com)
    body = body.replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)');
    body = body.replace(/<(https?:[^>]+)>/g, '$1');

    // <!here>, <!channel>, <!everyone>
    body = body.replace(/<!(here|channel|everyone)>/g, '@$1');

    return {
      content: body.trim() || content || '',
      metadata: {
        ...metadata,
        channel: metadata.channel || metadata.channel_id || null,
        thread_ts: metadata.thread_ts || null,
        source_type_normalized: 'slack',
      },
    };
  },
};
