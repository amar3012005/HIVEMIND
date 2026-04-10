export const generalSchema = {
  type: 'general',
  label: 'General / Other',
  description: 'General documents, reports, and unclassified content',
  required: ['title'],
  optional: ['summary', 'key_topics', 'entities', 'dates', 'references'],
  fields: {
    title: { type: 'string', description: 'Document title' },
    summary: { type: 'string', description: 'Document summary' },
    key_topics: { type: 'array', description: 'Key topics covered' },
    entities: {
      type: 'array',
      description: 'Named entities found in the document',
      items: {
        name: { type: 'string' },
        type: { type: 'string' }
      }
    },
    dates: { type: 'array', description: 'Significant dates mentioned' },
    references: { type: 'array', description: 'References or citations' }
  },
  chunkBy: 'semantic',
  chunkFallback: 'fixed',
  tags: (extracted) => {
    const tags = ['enterprise', 'document_type:general'];
    if (Array.isArray(extracted.key_topics)) {
      extracted.key_topics.forEach(topic => {
        if (topic) tags.push(`topic:${String(topic).toLowerCase().replace(/\s+/g, '-')}`);
      });
    }
    return tags;
  }
};
