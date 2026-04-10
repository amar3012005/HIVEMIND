export const spreadsheetSchema = {
  type: 'spreadsheet',
  label: 'Spreadsheet / Data Export',
  description: 'Spreadsheets, CSV exports, tabular data with headers and rows',
  required: ['sheet_name', 'headers', 'row_count'],
  optional: ['data_type', 'date_range', 'summary_statistics', 'key_columns', 'notable_patterns'],
  fields: {
    sheet_name: { type: 'string', description: 'Sheet or file name' },
    headers: { type: 'array', description: 'Column headers' },
    row_count: { type: 'number', description: 'Total number of data rows' },
    data_type: { type: 'string', description: 'Data category (financial, inventory, HR, analytics)' },
    date_range: { type: 'string', description: 'Date range covered by the data' },
    summary_statistics: { type: 'object', description: 'Summary statistics for numeric columns' },
    key_columns: { type: 'array', description: 'Most important columns for analysis' },
    notable_patterns: { type: 'string', description: 'Notable patterns or anomalies in the data' }
  },
  chunkBy: 'row_groups',
  chunkFallback: 'sections',
  tags: (extracted) => {
    const tags = ['enterprise', 'document_type:spreadsheet'];
    if (extracted.sheet_name) tags.push(`sheet:${extracted.sheet_name.toLowerCase().replace(/\s+/g, '-')}`);
    if (extracted.data_type) tags.push(`data_type:${extracted.data_type.toLowerCase().replace(/\s+/g, '-')}`);
    return tags;
  }
};
