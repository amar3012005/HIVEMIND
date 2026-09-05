import { humanizeField, isProviderIdentifier } from './governed-agent-contract.js';

const asText = (value, limit = 1000) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const IDENTITY_FIELD = /(?:email|address|recipient|contact|person|assignee|owner|member|user|customer|company|account|destination)/i;
const SEARCH_FIELD = /^(?:query|search_query|search_term|term|name)$/i;
const CONTENT_FIELD = /(?:body|content|message|text|description)/i;
const BUSINESS_PAYLOAD_FIELD = /(?:body|content|message|text|description|subject|title)/i;
const COLLECTION_KEY = /^(?:results|items|records|messages|contacts|people|data)$/i;
const FACT_EQUIVALENTS = [
  ['body', 'content', 'message', 'text', 'description', 'summary'],
  ['subject', 'title', 'headline'],
];

function equivalentFactKey(left, right) {
  const a = left.toLowerCase().replace(/[^a-z0-9]/g, '');
  const b = right.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (a === b || (Math.min(a.length, b.length) >= 4 && (a.endsWith(b) || b.endsWith(a)))) return true;
  return FACT_EQUIVALENTS.some(group => group.some(item => a.includes(item)) && group.some(item => b.includes(item)));
}

function fieldMatchesEntityRole(field, role) {
  const name = String(field || '').toLowerCase();
  const semanticRole = String(role || '').toLowerCase();
  if (/(?:recipient|destination|assignee|invitee|attendee|member)/.test(semanticRole)) {
    return /(?:recipient|destination|assignee|invitee|attendee|member|^to$|to_email)/.test(name);
  }
  if (/(?:sender|author|from)/.test(semanticRole)) return /(?:sender|author|from)/.test(name);
  if (/(?:owner|customer|user|contact|person|account)/.test(semanticRole)) return new RegExp(semanticRole).test(name) || IDENTITY_FIELD.test(name);
  return IDENTITY_FIELD.test(name);
}

export function schemaFieldForNamedEntity(card = {}, intent = {}) {
  const role = (intent.entities || []).map(entity => asText(entity?.role, 80)).find(Boolean) || '';
  return Object.entries(card.schema?.properties || {}).find(([field, definition]) => (
    fieldMatchesEntityRole(field, role)
    && (definition?.format === 'email' || /(?:email|address|recipient|destination|assignee|invitee|attendee|member|^to$)/i.test(field))
  )) || null;
}

export function hasNamedBusinessEntity(intent = {}, fieldValues = {}) {
  if ((intent.entities || []).some(entity => asText(entity?.name, 160))) return true;
  return Object.entries({ ...(intent.known_facts || {}), ...(fieldValues || {}) }).some(([key, value]) => (
    IDENTITY_FIELD.test(String(key)) && (Array.isArray(value)
      ? value.some(item => asText(item, 160))
      : Boolean(asText(value, 160)))
  ));
}

export function resolvableSchemaRequirements({ intent = {}, fieldValues = {}, requirements = [] } = {}) {
  if (!hasNamedBusinessEntity(intent, fieldValues)) return requirements;
  return requirements.filter(item => IDENTITY_FIELD.test(String(item?.field || '')) || isProviderIdentifier(item?.field));
}

export function dependencyDiscoveryQuery({ requirements = [], intent = {} } = {}) {
  const fields = [...new Set(requirements.map(item => humanizeField(item.field)))].join(', ') || 'missing business information';
  const roles = [...new Set((intent.entities || []).map(entity => asText(entity?.role, 80)).filter(Boolean))].join(', ');
  const apps = (intent.apps || []).map(item => asText(item, 80)).filter(Boolean).join(', ');
  return [
    `Find a read or search capability that resolves ${fields}`,
    roles ? `for a named ${roles}` : 'from authenticated evidence',
    apps ? `inside the connected ${apps} account` : 'inside the connected account',
    'using account data, directories, contacts, records, or prior activity before the requested mutation.',
    'The capability must return the required value; do not return another mutation tool.',
  ].join(' ');
}

function namedEntityAddresses({ intent = {}, receipts = [] } = {}) {
  const names = (intent.entities || []).map(entity => asText(entity?.name, 160).toLowerCase()).filter(Boolean);
  if (names.length !== 1) return [];
  const matches = new Set();
  const addressPattern = /[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/g;
  for (const address of names[0].match(addressPattern) || []) matches.add(address.replace(/[),.;]+$/, ''));
  const visit = (value, depth = 0) => {
    if (!value || depth > 10) return;
    if (Array.isArray(value)) return value.slice(0, 50).forEach(item => visit(item, depth + 1));
    if (typeof value !== 'object') return;
    const entries = Object.entries(value);
    const isCollectionWrapper = entries.some(([key, item]) => COLLECTION_KEY.test(key) && Array.isArray(item));
    if (!isCollectionWrapper) {
      const identityEntries = entries.filter(([key, item]) => (
        /(?:sender|from|author|name|display|email|address|contact|person)/i.test(key)
        && names.some(name => JSON.stringify(item).toLowerCase().includes(name))
      ));
      let foundDirect = false;
      for (const [, item] of identityEntries) {
        for (const address of JSON.stringify(item).match(addressPattern) || []) {
          matches.add(address.replace(/[),.;]+$/, ''));
          foundDirect = true;
        }
      }
      if (!foundDirect && identityEntries.length) {
        for (const [key, item] of entries.filter(([key]) => /(?:email|address)/i.test(key))) {
          void key;
          for (const address of JSON.stringify(item).match(addressPattern) || []) matches.add(address.replace(/[),.;]+$/, ''));
        }
      }
    }
    for (const item of Object.values(value)) visit(item, depth + 1);
  };
  for (const receipt of receipts) if (receipt?.successful) visit(receipt.data);
  return [...matches];
}

function namedEntityAddress(input = {}) {
  const matches = namedEntityAddresses(input);
  return matches.length === 1 ? matches[0] : null;
}

export function evidenceAmbiguities({ intent = {}, receipts = [] } = {}) {
  const values = namedEntityAddresses({ intent, receipts });
  if (values.length < 2) return [];
  return values.map(value => ({ kind: 'address', value, label: value }));
}

export function ambiguousEvidenceBindings({ intent = {}, receipts = [], fieldValues = {}, args = {} } = {}) {
  const options = new Set(evidenceAmbiguities({ intent, receipts }).map(item => item.value.toLowerCase()));
  if (options.size < 2) return [];
  const supplied = new Set(Object.values(fieldValues || {}).flatMap(value => Array.isArray(value) ? value : [value])
    .map(value => asText(value).toLowerCase()).filter(Boolean));
  const role = (intent.entities || []).map(entity => asText(entity?.role, 80)).find(Boolean) || '';
  return Object.entries(args || {}).filter(([field, value]) => {
    if (!fieldMatchesEntityRole(field, role)) return false;
    const selected = asText(value).toLowerCase();
    return options.has(selected) && !supplied.has(selected);
  }).map(([field]) => ({ field, code: 'ambiguous_evidence_requires_selection' }));
}

export function roleIncompatibleEvidenceBindings({ intent = {}, receipts = [], args = {} } = {}) {
  const options = new Set(namedEntityAddresses({ intent, receipts }).map(value => value.toLowerCase()));
  if (!options.size) return [];
  const role = (intent.entities || []).map(entity => asText(entity?.role, 80)).find(Boolean) || '';
  return Object.entries(args || {}).filter(([field, value]) => (
    options.has(asText(value).toLowerCase()) && !fieldMatchesEntityRole(field, role)
  )).map(([field]) => ({ field, code: 'entity_role_schema_mismatch' }));
}

function receiptHasField(receipts = [], field) {
  const wanted = String(field || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!wanted) return false;
  let found = false;
  const visit = (value, depth = 0) => {
    if (found || value == null || depth > 10) return;
    if (Array.isArray(value)) return value.slice(0, 50).forEach(item => visit(item, depth + 1));
    if (typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if ((normalized === wanted || normalized.endsWith(wanted) || wanted.endsWith(normalized))
        && (typeof item === 'string' || typeof item === 'number') && asText(item)) {
        found = true;
        return;
      }
      visit(item, depth + 1);
    }
  };
  for (const receipt of receipts) if (receipt?.successful) visit(receipt.data);
  return found;
}

export function requirementsResolvedByEvidence({ intent = {}, receipts = [], fieldValues = {}, requirements = [] } = {}) {
  if (!requirements.length) return true;
  const address = namedEntityAddress({ intent, receipts });
  return requirements.every(item => {
    const field = String(item?.field || '');
    if (asText(fieldValues?.[field])) return true;
    if (IDENTITY_FIELD.test(field) && /(?:email|address|recipient|destination)/i.test(field) && address) return true;
    return receiptHasField(receipts, field);
  });
}

export function compileGroundedArguments({ card = {}, intent = {}, receipts = [], fieldValues = {}, args = {} } = {}) {
  let compiled = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  const groundedFields = { ...(intent.known_facts || {}), ...(fieldValues || {}) };
  for (const field of Object.keys(card.schema?.properties || {})) {
    const normalizedField = field.toLowerCase().replace(/[^a-z0-9]/g, '');
    const grounded = Object.entries(groundedFields).find(([key, value]) => {
      if (!asText(value)) return false;
      return equivalentFactKey(key, normalizedField);
    });
    if (grounded) compiled[field] = grounded[1];
  }
  const entities = (intent.entities || []).filter(entity => asText(entity?.name, 160));
  const role = entities.map(entity => asText(entity?.role, 80)).find(Boolean) || '';
  const entityAddresses = new Set(namedEntityAddresses({ intent, receipts }).map(value => value.toLowerCase()));
  for (const [field, value] of Object.entries(compiled)) {
    if (entityAddresses.has(asText(value).toLowerCase()) && !fieldMatchesEntityRole(field, role)) delete compiled[field];
  }
  const searchableField = (card.fields || Object.keys(card.schema?.properties || {})).find(field => SEARCH_FIELD.test(String(field)));
  if (card.authority === 'read' && searchableField && !asText(compiled[searchableField]) && entities.length === 1) {
    compiled[searchableField] = entities[0].name;
  }
  if (card.authority === 'write') {
    const address = namedEntityAddress({ intent, receipts });
    const destination = schemaFieldForNamedEntity(card, intent);
    if (destination) {
      for (const field of Object.keys(compiled)) {
        if (field !== destination[0] && fieldMatchesEntityRole(field, role) && !asText(fieldValues?.[field])) delete compiled[field];
      }
      if (address && !asText(compiled[destination[0]])) compiled[destination[0]] = address;
    }
  }
  return compiled;
}

export function missingBusinessPayloadFields(card = {}, args = {}) {
  if (card.authority !== 'write') return [];
  const properties = card.schema?.properties || {};
  const fields = Object.keys(properties).filter(field => BUSINESS_PAYLOAD_FIELD.test(field));
  if (!fields.length || fields.some(field => asText(args[field]))) return [];
  const preferred = fields.find(field => CONTENT_FIELD.test(field)) || fields[0];
  return [{ field: preferred, schema: properties[preferred] || {}, code: 'business_payload_required' }];
}

export function missingNamedEntityBinding(card = {}, intent = {}, args = {}) {
  if (card.authority !== 'write' || !(intent.entities || []).some(entity => asText(entity?.name, 160))) return [];
  const target = schemaFieldForNamedEntity(card, intent);
  if (!target || asText(args[target[0]])) return [];
  return [{ field: target[0], schema: target[1] || {}, code: 'named_entity_destination_required' }];
}

export function missingConditionalSchemaFields(schema = {}, args = {}) {
  const properties = schema?.properties || {};
  const descriptions = Object.values(properties).map(item => asText(item?.description)).join(' ');
  const missing = [];
  for (const match of descriptions.matchAll(/either\s+[`'" ]*([a-z][a-z0-9_]*)[`'" ]*\s+or\s+[`'" ]*([a-z][a-z0-9_]*)[`'" ]*\s+must be provided/gi)) {
    const fields = [match[1], match[2]].filter(field => Object.hasOwn(properties, field));
    if (fields.length && !fields.some(field => asText(args[field]))) {
      const preferred = fields.find(field => CONTENT_FIELD.test(field)) || fields[0];
      missing.push({ field: preferred, schema: properties[preferred] || {} });
    }
  }
  return missing;
}
