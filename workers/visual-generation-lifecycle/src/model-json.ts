export function parseModelJson(value: unknown): any {
  if (value && typeof value === 'object') {
    const row = value as any;
    if (row.response !== undefined) return parseModelJson(row.response);
    if (row.result !== undefined) return parseModelJson(row.result);
    if (row.choices?.[0]?.message?.content !== undefined) return parseModelJson(row.choices[0].message.content);
    return row;
  }
  const text = String(value || '');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try { return JSON.parse(match[0]); } catch { return {}; }
}
