import { humanizeField, isProviderIdentifier } from './governed-agent-contract.js';

const asText = (value, limit = 1000) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const IDENTITY_FIELD = /(?:email|address|recipient|contact|person|assignee|owner|member|user|customer|company|account|destination)/i;
const SEARCH_FIELD = /^(?:query|search_query|search_term|term|name)$/i;
const CONTENT_FIELD = /(?:body|content|message|text|description)/i;
const COLLECTION_KEY = /^(?:results|items|records|messages|contacts|people|data)$/i;

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

function namedEntityAddress({ intent = {}, receipts = [] } = {}) {
  const names = (intent.entities || []).map(entity => asText(entity?.name, 160).toLowerCase()).filter(Boolean);
  if (names.length !== 1) return null;
  const matches = new Set();
  const addressPattern = /[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/g;
  const visit = (value, depth = 0) => {
    if (!value || depth > 10) return;
    if (Array.isArray(value)) return value.slice(0, 50).forEach(item => visit(item, depth + 1));
    if (typeof value !== 'object') return;
    const entries = Object.entries(value);
    const isCollectionWrapper = entries.some(([key, item]) => COLLECTION_KEY.test(key) && Array.isArray(item));
    const serialized = JSON.stringify(value);
    if (!isCollectionWrapper && names.some(name => serialized.toLowerCase().includes(name))) {
      for (const address of serialized.match(addressPattern) || []) matches.add(address.replace(/[),.;]+$/, ''));
    }
    for (const item of Object.values(value)) visit(item, depth + 1);
  };
  for (const receipt of receipts) if (receipt?.successful) visit(receipt.data);
  return matches.size === 1 ? [...matches][0] : null;
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

export function requirementsResolvedByEvidence({ intent = {}, receipts = [], requirements = [] } = {}) {
  if (!requirements.length) return true;
  const address = namedEntityAddress({ intent, receipts });
  return requirements.every(item => {
    const field = String(item?.field || '');
    if (IDENTITY_FIELD.test(field) && /(?:email|address|recipient|destination)/i.test(field) && address) return true;
    return receiptHasField(receipts, field);
  });
}

export function compileGroundedArguments({ card = {}, intent = {}, receipts = [], args = {} } = {}) {
  let compiled = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};
  const entities = (intent.entities || []).filter(entity => asText(entity?.name, 160));
  const searchableField = (card.fields || Object.keys(card.schema?.properties || {})).find(field => SEARCH_FIELD.test(String(field)));
  if (card.authority === 'read' && searchableField && !asText(compiled[searchableField]) && entities.length === 1) {
    compiled[searchableField] = entities[0].name;
  }
  if (card.authority === 'write') {
    const address = namedEntityAddress({ intent, receipts });
    if (address) {
      for (const [field, definition] of Object.entries(card.schema?.properties || {})) {
        const acceptsAddress = definition?.format === 'email' || /(?:^|_)(?:email|address|recipient)(?:$|_)/i.test(field);
        if (acceptsAddress && !asText(compiled[field])) compiled[field] = address;
      }
    }
  }
  return compiled;
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
