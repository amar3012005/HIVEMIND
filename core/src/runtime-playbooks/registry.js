import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validateRuntimePlaybookShape } from './playbook-schema.js';
import { defaultPredicateNames } from './predicate-engine.js';

function clone(value) {
  return structuredClone(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function runtimePlaybookContentHash(definition) {
  return createHash('sha256').update(stableJson(definition)).digest('hex');
}

function validatePredicates(playbook, predicateNames) {
  const allowed = new Set(predicateNames);
  for (const stage of playbook.stages) {
    for (const check of stage.completion_checks) {
      if (!allowed.has(check.predicate)) {
        throw new Error(`runtime_playbook_predicate_unknown:${stage.id}:${check.predicate}`);
      }
    }
    for (const transition of stage.transitions) {
      if (transition.when?.predicate && !allowed.has(transition.when.predicate)) {
        throw new Error(`runtime_playbook_predicate_unknown:${stage.id}:${transition.when.predicate}`);
      }
    }
  }
}

function normalizeRecord(record) {
  const definition = record.definition || record;
  const normalized = validateRuntimePlaybookShape(clone(definition));
  if (record.playbook_id && record.playbook_id !== normalized.playbook_id) {
    throw new Error(`runtime_playbook_identity_mismatch:${record.playbook_id}:${normalized.playbook_id}`);
  }
  if (record.playbookId && record.playbookId !== normalized.playbook_id) {
    throw new Error(`runtime_playbook_identity_mismatch:${record.playbookId}:${normalized.playbook_id}`);
  }
  if (record.version != null && record.definition && record.version !== normalized.version) {
    throw new Error(`runtime_playbook_version_mismatch:${record.version}:${normalized.version}`);
  }
  const contentHash = runtimePlaybookContentHash(normalized);
  const suppliedHash = record.content_hash || record.contentHash;
  if (suppliedHash && suppliedHash !== contentHash) {
    throw new Error(`runtime_playbook_content_hash_mismatch:${normalized.playbook_id}:${normalized.version}`);
  }
  return {
    scope_key: record.scope_key || record.scopeKey || 'global',
    definition: normalized,
    content_hash: contentHash,
  };
}

function recordKey(scopeKey, playbookId, version) {
  return `${scopeKey}\u0000${playbookId}\u0000${version}`;
}

export class RuntimePlaybookRegistry {
  constructor({ predicateNames = defaultPredicateNames } = {}) {
    this.predicateNames = [...predicateNames];
    this.records = new Map();
  }

  register(record) {
    const normalized = normalizeRecord(record);
    validatePredicates(normalized.definition, this.predicateNames);
    const { playbook_id: playbookId, version } = normalized.definition;
    const key = recordKey(normalized.scope_key, playbookId, version);
    const existing = this.records.get(key);
    if (existing && existing.content_hash !== normalized.content_hash) {
      throw new Error(`runtime_playbook_version_immutable:${normalized.scope_key}:${playbookId}:${version}`);
    }
    this.records.set(key, normalized);
    return clone(normalized.definition);
  }

  async load(sources) {
    for (const source of sources) {
      const records = await source.list();
      for (const record of records) this.register(record);
    }
    return this;
  }

  get(playbookId, version, { scopeKey = 'global' } = {}) {
    const candidates = [...this.records.values()].filter((record) => {
      if (record.definition.playbook_id !== playbookId) return false;
      if (record.definition.status !== 'ACTIVE') return false;
      if (version != null && record.definition.version !== version) return false;
      return record.scope_key === scopeKey || record.scope_key === 'global';
    });
    candidates.sort((left, right) => {
      const leftScope = left.scope_key === scopeKey ? 1 : 0;
      const rightScope = right.scope_key === scopeKey ? 1 : 0;
      return rightScope - leftScope || right.definition.version - left.definition.version;
    });
    if (!candidates[0]) throw new Error(`runtime_playbook_not_found:${scopeKey}:${playbookId}:${version ?? 'latest'}`);
    return clone(candidates[0].definition);
  }

  descriptors({ scopeKey = 'global', latestOnly = false } = {}) {
    const candidates = [...this.records.values()]
      .filter((record) => record.scope_key === 'global' || record.scope_key === scopeKey)
      .sort((left, right) => {
        const leftScope = left.scope_key === scopeKey ? 1 : 0;
        const rightScope = right.scope_key === scopeKey ? 1 : 0;
        return rightScope - leftScope || right.definition.version - left.definition.version;
      });
    const effective = new Map();
    for (const record of candidates) {
      const key = `${record.definition.playbook_id}\u0000${record.definition.version}`;
      if (!effective.has(key)) effective.set(key, record);
    }
    const selected = [...effective.values()];
    const seenPlaybooks = new Set();
    const visible = latestOnly
      ? selected.filter((record) => {
          if (record.definition.status !== 'ACTIVE') return false;
          if (seenPlaybooks.has(record.definition.playbook_id)) return false;
          seenPlaybooks.add(record.definition.playbook_id);
          return true;
        })
      : selected;
    return visible.map((record) => ({
        scope_key: record.scope_key,
        playbook_id: record.definition.playbook_id,
        version: record.definition.version,
        status: record.definition.status,
        name: record.definition.name,
        description: record.definition.description || '',
        metadata: record.definition.metadata || {},
        terminal_states: record.definition.terminal_states || [],
        input_contract: record.definition.input_contract || { fields: [] },
        content_hash: record.content_hash,
      }))
      .sort((left, right) => left.playbook_id.localeCompare(right.playbook_id) || right.version - left.version);
  }

  definitions({ scopeKey = 'global' } = {}) {
    return [...this.records.values()]
      .filter((record) => record.scope_key === 'global' || record.scope_key === scopeKey)
      .map((record) => clone(record.definition));
  }
}

export function createJsonPlaybookSource(paths) {
  return {
    async list() {
      return Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
    },
  };
}

export function createPrismaPlaybookSource({ prisma, scopeKey = 'global' }) {
  return {
    async list() {
      const rows = await prisma.runtimePlaybookDefinition.findMany({
        where: { scopeKey: { in: scopeKey === 'global' ? ['global'] : ['global', scopeKey] } },
        orderBy: [{ playbookId: 'asc' }, { version: 'desc' }],
      });
      return rows.map((row) => ({
        scope_key: row.scopeKey,
        playbook_id: row.playbookId,
        version: row.version,
        definition: row.definition,
        content_hash: row.contentHash,
      }));
    },
  };
}
