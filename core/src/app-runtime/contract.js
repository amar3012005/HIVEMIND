/** AppSpec v1: data-only definitions, never SQL, JavaScript, or model execution. */
export const APP_RUNTIME_LIMITS = Object.freeze({
  specBytes: 262144, recordBytes: 65536, depth: 12, nodes: 10000,
  entities: 32, fieldsPerEntity: 64, views: 64, relations: 128, enumOptions: 100,
});

export class AppRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AppRuntimeError';
    this.code = code;
    this.details = details;
    this.status = 400;
  }
}

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const identifier = /^[a-z][a-z0-9_-]{0,63}$/;
const fieldTypes = new Set(['text', 'number', 'date', 'enum', 'boolean', 'reference']);
const idSchema = { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' };
const nameSchema = { type: 'string', minLength: 1, maxLength: 160 };
/** Wire schema for model-facing tools. Semantic references are checked by validateAppSpec. */
export const APP_SPEC_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'name', 'entities', 'views'],
  properties: {
    schemaVersion: { type: 'integer', const: 1 }, name: nameSchema,
    description: { type: 'string', minLength: 1, maxLength: 4000 },
    entities: { type: 'array', minItems: 1, maxItems: 32, items: {
      type: 'object', additionalProperties: false, required: ['id', 'name', 'fields'],
      properties: { id: idSchema, name: nameSchema, fields: {
        type: 'array', minItems: 1, maxItems: 64, items: {
          type: 'object', additionalProperties: false, required: ['id', 'name', 'type'],
          properties: {
            id: idSchema, name: nameSchema,
            type: { type: 'string', enum: ['text', 'number', 'date', 'enum', 'boolean', 'reference'] },
            required: { type: 'boolean' },
            options: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } },
            targetEntityId: idSchema,
            source: { type: 'object', additionalProperties: false, required: ['type'], properties: {
              type: { type: 'string', enum: ['local', 'external', 'derived'] },
              provider: { type: 'string', minLength: 1, maxLength: 128 },
              object: { type: 'string', minLength: 1, maxLength: 128 },
              property: { type: 'string', minLength: 1, maxLength: 128 },
            } },
          },
        },
      } },
    } },
    relations: { type: 'array', maxItems: 128, items: {
      type: 'object', additionalProperties: false,
      required: ['id', 'name', 'fromEntityId', 'toEntityId', 'cardinality'],
      properties: {
        id: idSchema, name: nameSchema, fromEntityId: idSchema, toEntityId: idSchema,
        cardinality: { type: 'string', enum: ['one_to_one', 'one_to_many', 'many_to_many'] },
      },
    } },
    views: { type: 'array', minItems: 1, maxItems: 64, items: {
      type: 'object', additionalProperties: false, required: ['id', 'name', 'type', 'entityId'],
      properties: {
        id: idSchema, name: nameSchema, type: { type: 'string', enum: ['table', 'kanban', 'record'] },
        entityId: idSchema, fieldIds: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: idSchema },
        groupByFieldId: idSchema,
      },
    } },
  },
};
/** DSH's narrower schema dialect; Core retains authoritative semantic/bounds validation. */
function nativeSchema(node) {
  if (Array.isArray(node)) return node.map(nativeSchema);
  if (!node || typeof node !== 'object') return node;
  const result = {};
  for (const [key, value] of Object.entries(node)) {
    if (['minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'pattern'].includes(key)) continue;
    result[key] = nativeSchema(value);
  }
  return result;
}
export const APP_SPEC_TOOL_SCHEMA = nativeSchema(APP_SPEC_JSON_SCHEMA);
const fieldWire = APP_SPEC_TOOL_SCHEMA.properties.entities.items.properties.fields.items;
fieldWire.oneOf = [...fieldTypes].map(type => {
  const properties = { id: fieldWire.properties.id, name: fieldWire.properties.name,
    type: { type: 'string', const: type }, required: fieldWire.properties.required, source: fieldWire.properties.source };
  const required = ['id', 'name', 'type'];
  if (type === 'enum') { properties.options = fieldWire.properties.options; required.push('options'); }
  if (type === 'reference') { properties.targetEntityId = fieldWire.properties.targetEntityId; required.push('targetEntityId'); }
  return { type: 'object', additionalProperties: false, properties, required };
});
const sourceWire = fieldWire.properties.source;
sourceWire.oneOf = ['local', 'derived', 'external'].map(type => ({
  type: 'object', additionalProperties: false,
  required: type === 'external' ? ['type', 'provider', 'object', 'property'] : ['type'],
  properties: type === 'external' ? { ...sourceWire.properties, type: { type: 'string', const: type } } : { type: { type: 'string', const: type } },
}));
// Native DSH union nodes must consist of oneOf, not an object schema plus oneOf.
for (const node of [fieldWire, sourceWire]) {
  delete node.type;
  delete node.properties;
  delete node.required;
  delete node.additionalProperties;
}
function fail(path, message, code = 'INVALID_APP_SPEC') {
  throw new AppRuntimeError(code, `${path}: ${message}`, { path });
}

/** Reject non-JSON values, prototype keys, accessors, cycles and oversized payloads. */
function snapshot(input, maxBytes, code) {
  let count = 0;
  const ancestors = new Set();
  function copy(value, path, depth) {
    if (++count > APP_RUNTIME_LIMITS.nodes || depth > APP_RUNTIME_LIMITS.depth) fail(path, 'payload complexity limit exceeded', code);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (value.length > maxBytes) fail(path, 'string size limit exceeded', code);
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || value === null) fail(path, 'expected a lossless JSON value', code);
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) fail(path, 'expected a plain object', code);
    if (ancestors.has(value)) fail(path, 'cyclic payload', code);
    ancestors.add(value);
    const result = Array.isArray(value) ? [] : {};
    if (Array.isArray(value) && value.length > APP_RUNTIME_LIMITS.nodes) fail(path, 'array size limit exceeded', code);
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      if (typeof key !== 'string' || forbidden.has(key)) fail(path, 'forbidden property', code);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(path, 'accessors and hidden properties are unsupported', code);
      if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) fail(path, 'invalid array property', code);
      result[key] = copy(descriptor.value, `${path}.${key}`, depth + 1);
    }
    if (Array.isArray(value) && Object.keys(result).length !== value.length) fail(path, 'sparse arrays are unsupported', code);
    ancestors.delete(value);
    return result;
  }
  const result = copy(input, '$', 0);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes) fail('$', 'payload size limit exceeded', code);
  return result;
}

function object(value, keys, required, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${path}.${key}`, 'unknown property');
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'required property');
}
function text(value, path, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(path, `expected a non-empty string up to ${max} characters`);
  return value.trim();
}
function id(value, path) {
  if (typeof value !== 'string' || !identifier.test(value) || forbidden.has(value)) fail(path, 'expected a stable lowercase identifier');
  return value;
}
function list(value, path, max, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > max) fail(path, `expected ${minimum}..${max} items`);
  return value;
}
function unique(items, path, key = 'id') {
  const seen = new Set();
  for (const item of items) {
    const value = key ? item[key] : item;
    if (seen.has(value)) fail(path, `duplicate ${key || 'value'}: ${value}`);
    seen.add(value);
  }
}

export function validateAppSpec(input) {
  const spec = snapshot(input, APP_RUNTIME_LIMITS.specBytes, 'INVALID_APP_SPEC');
  object(spec, ['schemaVersion', 'name', 'description', 'entities', 'relations', 'views'], ['schemaVersion', 'name', 'entities', 'views'], '$');
  if (spec.schemaVersion !== 1) fail('$.schemaVersion', 'only version 1 is supported');
  spec.name = text(spec.name, '$.name');
  if (Object.hasOwn(spec, 'description')) spec.description = text(spec.description, '$.description', 4000);
  list(spec.entities, '$.entities', APP_RUNTIME_LIMITS.entities, 1);
  for (const [ei, entity] of spec.entities.entries()) {
    const path = `$.entities[${ei}]`;
    object(entity, ['id', 'name', 'fields'], ['id', 'name', 'fields'], path);
    id(entity.id, `${path}.id`);
    entity.name = text(entity.name, `${path}.name`);
    list(entity.fields, `${path}.fields`, APP_RUNTIME_LIMITS.fieldsPerEntity, 1);
    for (const [fi, field] of entity.fields.entries()) {
      const fp = `${path}.fields[${fi}]`;
      object(field, ['id', 'name', 'type', 'required', 'options', 'targetEntityId', 'source'], ['id', 'name', 'type'], fp);
      id(field.id, `${fp}.id`);
      field.name = text(field.name, `${fp}.name`);
      if (!fieldTypes.has(field.type)) fail(`${fp}.type`, 'unsupported field type');
      if (Object.hasOwn(field, 'required') && typeof field.required !== 'boolean') fail(`${fp}.required`, 'expected boolean');
      field.required ??= false;
      if (field.type === 'enum') {
        list(field.options, `${fp}.options`, APP_RUNTIME_LIMITS.enumOptions, 1);
        field.options = field.options.map((option, i) => text(option, `${fp}.options[${i}]`, 128));
        unique(field.options, `${fp}.options`, null);
      } else if (Object.hasOwn(field, 'options')) fail(`${fp}.options`, 'only supported for enum fields');
      if (field.type === 'reference') id(field.targetEntityId, `${fp}.targetEntityId`);
      else if (Object.hasOwn(field, 'targetEntityId')) fail(`${fp}.targetEntityId`, 'only supported for reference fields');
      field.source ??= { type: 'local' };
      object(field.source, ['type', 'provider', 'object', 'property'], ['type'], `${fp}.source`);
      if (!['local', 'external', 'derived'].includes(field.source.type)) fail(`${fp}.source.type`, 'unsupported source');
      if (field.source.type === 'external') {
        for (const key of ['provider', 'object', 'property']) field.source[key] = text(field.source[key], `${fp}.source.${key}`, 128);
      } else if (Object.keys(field.source).length !== 1) fail(`${fp}.source`, 'mapping keys require an external source');
    }
    unique(entity.fields, `${path}.fields`);
  }
  unique(spec.entities, '$.entities');
  const entities = new Map(spec.entities.map(entity => [entity.id, entity]));
  for (const entity of spec.entities) for (const field of entity.fields) {
    if (field.type === 'reference' && !entities.has(field.targetEntityId)) fail(`$.entities.${entity.id}.${field.id}`, 'unknown target entity');
  }
  spec.relations ??= [];
  list(spec.relations, '$.relations', APP_RUNTIME_LIMITS.relations);
  for (const [i, relation] of spec.relations.entries()) {
    const path = `$.relations[${i}]`;
    object(relation, ['id', 'name', 'fromEntityId', 'toEntityId', 'cardinality'], ['id', 'name', 'fromEntityId', 'toEntityId', 'cardinality'], path);
    id(relation.id, `${path}.id`);
    relation.name = text(relation.name, `${path}.name`);
    for (const key of ['fromEntityId', 'toEntityId']) if (!entities.has(relation[key])) fail(`${path}.${key}`, 'unknown entity');
    if (!['one_to_one', 'one_to_many', 'many_to_many'].includes(relation.cardinality)) fail(`${path}.cardinality`, 'unsupported cardinality');
  }
  unique(spec.relations, '$.relations');
  list(spec.views, '$.views', APP_RUNTIME_LIMITS.views, 1);
  for (const [i, view] of spec.views.entries()) {
    const path = `$.views[${i}]`;
    object(view, ['id', 'name', 'type', 'entityId', 'fieldIds', 'groupByFieldId'], ['id', 'name', 'type', 'entityId'], path);
    id(view.id, `${path}.id`);
    view.name = text(view.name, `${path}.name`);
    if (!['table', 'kanban', 'record'].includes(view.type)) fail(`${path}.type`, 'unsupported view');
    const entity = entities.get(view.entityId);
    if (!entity) fail(`${path}.entityId`, 'unknown entity');
    const fields = new Map(entity.fields.map(field => [field.id, field]));
    view.fieldIds ??= entity.fields.map(field => field.id);
    list(view.fieldIds, `${path}.fieldIds`, APP_RUNTIME_LIMITS.fieldsPerEntity, 1);
    unique(view.fieldIds, `${path}.fieldIds`, null);
    for (const fieldId of view.fieldIds) if (!fields.has(fieldId)) fail(`${path}.fieldIds`, 'unknown field');
    if (view.type === 'kanban') {
      if (fields.get(view.groupByFieldId)?.type !== 'enum') fail(`${path}.groupByFieldId`, 'kanban requires an enum field');
    } else if (Object.hasOwn(view, 'groupByFieldId')) fail(`${path}.groupByFieldId`, 'only supported for kanban');
  }
  unique(spec.views, '$.views');
  return spec;
}

export function validateRecordData(inputSpec, entityId, input, { partial = false } = {}) {
  const spec = validateAppSpec(inputSpec);
  const entity = spec.entities.find(item => item.id === entityId);
  if (!entity) fail('$.entityId', 'unknown entity', 'INVALID_RECORD_DATA');
  const data = snapshot(input, APP_RUNTIME_LIMITS.recordBytes, 'INVALID_RECORD_DATA');
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('$.data', 'expected an object', 'INVALID_RECORD_DATA');
  const fields = new Map(entity.fields.map(field => [field.id, field]));
  for (const key of Object.keys(data)) if (!fields.has(key)) fail(`$.data.${key}`, 'unknown field', 'INVALID_RECORD_DATA');
  for (const field of entity.fields) {
    const path = `$.data.${field.id}`;
    if (!Object.hasOwn(data, field.id)) {
      if (!partial && field.required) fail(path, 'required field', 'INVALID_RECORD_DATA');
      continue;
    }
    const value = data[field.id];
    if (value === null && !field.required) continue;
    let valid = false;
    switch (field.type) {
      case 'text': valid = typeof value === 'string' && value.length <= 16384 && (!field.required || Boolean(value.trim())); break;
      case 'number': valid = typeof value === 'number' && Number.isFinite(value); break;
      case 'boolean': valid = typeof value === 'boolean'; break;
      case 'enum': valid = field.options.includes(value); break;
      case 'reference': valid = typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); break;
      case 'date': {
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
          const date = new Date(`${value}T00:00:00.000Z`);
          valid = !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
        }
        break;
      }
    }
    if (!valid) fail(path, `expected ${field.type}${field.required ? ' (non-null)' : ' or null'}`, 'INVALID_RECORD_DATA');
  }
  return data;
}

/** Arrays are replaced atomically; callers persist a new immutable version with CAS. */
export function applyAppSpecPatch(inputSpec, inputPatch) {
  const current = validateAppSpec(inputSpec);
  const patch = snapshot(inputPatch, APP_RUNTIME_LIMITS.specBytes, 'INVALID_APP_SPEC');
  object(patch, ['name', 'description', 'entities', 'relations', 'views'], [], '$.patch');
  if (!Object.keys(patch).length) fail('$.patch', 'empty patch');
  return validateAppSpec({ ...current, ...patch });
}

export const EXAMPLE_CRM_SPEC = {
  schemaVersion: 1, name: 'Enterprise CRM',
  entities: [
    { id: 'company', name: 'Companies', fields: [
      { id: 'name', name: 'Name', type: 'text', required: true },
      { id: 'industry', name: 'Industry', type: 'text' },
    ] },
    { id: 'contact', name: 'Contacts', fields: [
      { id: 'name', name: 'Name', type: 'text', required: true },
      { id: 'company', name: 'Company', type: 'reference', targetEntityId: 'company' },
    ] },
    { id: 'deal', name: 'Deals', fields: [
      { id: 'name', name: 'Name', type: 'text', required: true },
      { id: 'company', name: 'Company', type: 'reference', targetEntityId: 'company' },
      { id: 'amount', name: 'Amount', type: 'number' },
      { id: 'stage', name: 'Stage', type: 'enum', options: ['Qualified', 'Review', 'Won', 'Lost'], required: true },
    ] },
  ],
  relations: [{ id: 'company_deals', name: 'Company deals', fromEntityId: 'company', toEntityId: 'deal', cardinality: 'one_to_many' }],
  views: [
    { id: 'companies', name: 'Companies', type: 'table', entityId: 'company' },
    { id: 'pipeline', name: 'Pipeline', type: 'kanban', entityId: 'deal', groupByFieldId: 'stage' },
    { id: 'deal_detail', name: 'Deal details', type: 'record', entityId: 'deal' },
  ],
};
