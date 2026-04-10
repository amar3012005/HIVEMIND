export const sopSchema = {
  type: 'sop',
  label: 'Company Knowledge Base / SOP',
  description: 'Standard operating procedures, internal documentation, policies, and knowledge base articles',
  required: ['title', 'category'],
  optional: ['version', 'effective_date', 'department', 'sections', 'review_date', 'owner', 'audience', 'keywords'],
  fields: {
    title: { type: 'string', description: 'Document title' },
    category: { type: 'string', description: 'Document category' },
    version: { type: 'string', description: 'Document version' },
    effective_date: { type: 'string', description: 'Effective date (ISO 8601)' },
    department: { type: 'string', description: 'Owning department' },
    sections: {
      type: 'array',
      description: 'Document sections',
      items: {
        title: { type: 'string' },
        content: { type: 'string' }
      }
    },
    review_date: { type: 'string', description: 'Next review date (ISO 8601)' },
    owner: { type: 'string', description: 'Document owner' },
    audience: { type: 'string', description: 'Target audience' },
    keywords: { type: 'array', description: 'Keywords for discoverability' }
  },
  chunkBy: 'sections',
  chunkFallback: 'semantic',
  tags: (extracted) => {
    const tags = ['enterprise', 'document_type:sop'];
    if (extracted.department) tags.push(`department:${extracted.department.toLowerCase().replace(/\s+/g, '-')}`);
    if (extracted.category) tags.push(`category:${extracted.category.toLowerCase().replace(/\s+/g, '-')}`);
    return tags;
  }
};
