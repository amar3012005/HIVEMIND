/** Keep collections structured and allocate the budget across sibling records.
 * Never replace a JSON document with a cut string: doing so loses later rows.
 * Omission markers describe context limits, not provider permission failures.
 */
export function projectGovernedEvidence(value, budget = 32000) {
  const visit = (input, allowance, depth = 0) => {
    if (input == null || typeof input === 'boolean' || typeof input === 'number') return input;
    if (typeof input === 'string') {
      const limit = Math.max(320, Math.min(2000, Math.floor(allowance / 6)));
      return input.length <= limit ? input : `${input.slice(0, limit)}…[content shortened]`;
    }
    if (depth > 12) return '[nested content omitted]';
    if (Array.isArray(input)) {
      const rows = input.slice(0, 24);
      const projected = rows.map(row => visit(row, allowance / Math.max(1, rows.length), depth + 1));
      if (rows.length < input.length) projected.push({ omitted_records: input.length - rows.length });
      return projected;
    }
    if (typeof input !== 'object') return null;
    const entries = Object.entries(input).slice(0, 48);
    // Scalars (names, timestamps, IDs) cost little; reserve most space for collections.
    const weight = item => typeof item === 'object' && item !== null ? 4 : 1;
    const total = entries.reduce((sum, [, item]) => sum + weight(item), 0) || 1;
    return Object.fromEntries(entries.map(([key, item]) => [key, visit(item, allowance * weight(item) / total, depth + 1)]));
  };
  return visit(value, budget);
}
