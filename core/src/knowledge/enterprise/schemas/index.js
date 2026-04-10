import { invoiceSchema } from './invoice.js';
import { contractSchema } from './contract.js';
import { sopSchema } from './sop.js';
import { spreadsheetSchema } from './spreadsheet.js';
import { meetingSchema } from './meeting.js';
import { generalSchema } from './general.js';

export const SCHEMAS = {
  invoice: invoiceSchema,
  contract: contractSchema,
  sop: sopSchema,
  spreadsheet: spreadsheetSchema,
  meeting: meetingSchema,
  general: generalSchema,
};

export const DOCUMENT_TYPES = Object.keys(SCHEMAS);

export function getSchema(type) {
  return SCHEMAS[type] || SCHEMAS.general;
}

export function getDetectionPromptContext() {
  return Object.values(SCHEMAS)
    .map(s => `- ${s.type}: ${s.description}`)
    .join('\n');
}

export function generateTags(type, extractedFields) {
  const schema = getSchema(type);
  return schema.tags(extractedFields);
}

export { invoiceSchema, contractSchema, sopSchema, spreadsheetSchema, meetingSchema, generalSchema };
