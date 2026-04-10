export const contractSchema = {
  type: 'contract',
  label: 'Contract / Legal',
  description: 'Contracts, legal agreements, NDAs, and terms of service documents',
  required: ['parties', 'effective_date', 'document_title'],
  optional: ['expiry_date', 'clauses', 'governing_law', 'renewal_terms', 'termination_conditions', 'signatures', 'contract_value'],
  fields: {
    parties: { type: 'array', description: 'Parties involved in the contract' },
    effective_date: { type: 'string', description: 'Contract effective date (ISO 8601)' },
    document_title: { type: 'string', description: 'Title of the contract' },
    expiry_date: { type: 'string', description: 'Contract expiration date (ISO 8601)' },
    clauses: {
      type: 'array',
      description: 'Contract clauses',
      items: {
        title: { type: 'string' },
        content: { type: 'string' },
        type: { type: 'string' }
      }
    },
    governing_law: { type: 'string', description: 'Governing law jurisdiction' },
    renewal_terms: { type: 'string', description: 'Renewal terms and conditions' },
    termination_conditions: { type: 'string', description: 'Termination conditions' },
    signatures: { type: 'array', description: 'Signatories' },
    contract_value: { type: 'number', description: 'Total contract value' }
  },
  chunkBy: 'clauses',
  chunkFallback: 'sections',
  tags: (extracted) => {
    const tags = ['enterprise', 'document_type:contract'];
    if (Array.isArray(extracted.parties)) {
      extracted.parties.forEach(p => {
        if (p) tags.push(`party:${String(p).toLowerCase().replace(/\s+/g, '-')}`);
      });
    }
    return tags;
  }
};
