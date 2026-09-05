import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reserved = key => key.startsWith('_') || ['constructor', 'prototype', 'user_id', 'userid', 'org_id', 'orgid', 'connected_account_id', 'connectedaccountid', 'session_id', 'sessionid', 'entity_id', 'entityid', 'metadata'].includes(key.toLowerCase());

export const isProgressiveDraft = row => row?.provider === 'composio' && row?.toolArgs?._harness_version === 'progressive-v1';

/** Canonical approval boundary: editable values never replace the tool or its schema. */
export function progressiveDraftArguments(row, incoming = null) {
  if (!isProgressiveDraft(row)) throw new Error('progressive_draft_required');
  const schema = row.toolArgs._input_schema;
  if (!object(schema) || !object(schema.properties) || JSON.stringify(schema).length > 100000) {
    throw new Error('progressive_draft_schema_unavailable');
  }
  if (incoming !== null && !object(incoming)) throw new Error('draft_arguments_must_be_an_object');
  const args = Object.fromEntries(Object.entries(row.toolArgs).filter(([key]) => !reserved(key)));
  for (const [key, value] of Object.entries(incoming || {})) {
    if (reserved(key) || !Object.hasOwn(schema.properties, key)) throw new Error('draft_field_not_editable');
    args[key] = value;
  }
  if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key))) throw new Error('draft_field_not_in_schema');
  if (!ajv.validate(schema, args)) throw new Error('draft_arguments_do_not_match_schema');
  return args;
}

export function editProgressiveDraft(row, incoming) {
  return { ...progressiveDraftArguments(row, incoming), _composio_slug: row.toolName,
    _harness_version: 'progressive-v1', _input_schema: row.toolArgs._input_schema };
}
