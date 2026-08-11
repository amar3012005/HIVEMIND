// .amr Prisma-shaped adapter — exposes memory / relationship / knowledgeSegment models with the
// Prisma method surface (findMany/findFirst/findUnique/count/groupBy/aggregate/create/createMany/
// update/updateMany/delete/deleteMany/upsert), backed by the query engine over an in-memory record
// set that a pluggable `backend` persists to .amr. Backend-agnostic so the model + mutation logic is
// unit-testable without the native binding; the .amr backend (scan/insert/tombstone) is wired at
// integration. The routing proxy sends sai's queries here; all other orgs stay on Postgres.
import { randomUUID } from 'crypto';
import { findMany, findFirst, findUnique, count, groupBy, aggregate, evalWhere } from './query-engine.js';

// UUID ids — the pipeline + Qdrant require valid UUIDs (Qdrant rejects non-UUID point ids).
const genId = () => randomUUID();

// One model = a record array + a backend for durable writes. resolveRelation lets relationship
// queries filter on the related memory (fromMemory:{orgId}).
class MnemeModel {
  constructor({ records = [], backend = null, relations = {} } = {}) {
    this.records = records;
    this.backend = backend; // { insert(rec), update(id, rec), remove(id) } → persists to .amr
    this.relations = relations; // { fromMemory: (rec) => memoryRecord, ... }
    this.byId = new Map(records.map((r) => [r.id, r]));
  }

  _resolve = (record, key, cond) => {
    const rel = this.relations[key];
    if (!rel) return undefined;
    const target = rel(record);
    return target ? evalWhere(target, cond) : false;
  };
  _ctx() {
    return { records: this.records, resolveRelation: this._resolve };
  }

  async findMany(args = {}) {
    return findMany(this._ctx(), args);
  }
  async findFirst(args = {}) {
    return findFirst(this._ctx(), args);
  }
  async findUnique(args = {}) {
    if (args.where?.id != null) return this.byId.get(args.where.id) ?? null;
    return findUnique(this._ctx(), args);
  }
  async findUniqueOrThrow(args) {
    const r = await this.findUnique(args);
    if (!r) throw new Error('mneme: record not found');
    return r;
  }
  async count(args = {}) {
    return count(this._ctx(), args);
  }
  async groupBy(args = {}) {
    return groupBy(this._ctx(), args);
  }
  async aggregate(args = {}) {
    return aggregate(this._ctx(), args);
  }

  async create(args = {}) {
    const rec = { id: args.data.id || genId(), ...args.data };
    this.records.push(rec);
    this.byId.set(rec.id, rec);
    if (this.backend?.insert) await this.backend.insert(rec);
    return args.select ? pick(rec, args.select) : rec;
  }
  async createMany(args = {}) {
    let n = 0;
    for (const data of args.data || []) {
      if (args.skipDuplicates && data.id && this.byId.has(data.id)) continue;
      await this.create({ data });
      n++;
    }
    return { count: n };
  }
  async update(args = {}) {
    const rec = this.byId.get(args.where?.id) || this.records.find((r) => evalWhere(r, args.where, this._resolve));
    if (!rec) throw new Error('mneme: update target not found');
    applyData(rec, args.data);
    if (this.backend?.update) await this.backend.update(rec.id, rec);
    return rec;
  }
  async updateMany(args = {}) {
    const rows = this.records.filter((r) => evalWhere(r, args.where, this._resolve));
    for (const rec of rows) {
      applyData(rec, args.data);
      if (this.backend?.update) await this.backend.update(rec.id, rec);
    }
    return { count: rows.length };
  }
  // resolve a record from a Prisma where that may use id, a @unique field (e.g. memoryId), or a
  // compound @@id (e.g. {memoryId_projectId:{memoryId,projectId}}). Flattens compound keys.
  _matchWhere(where = {}) {
    if (where.id != null) return this.byId.get(where.id) || null;
    let flat = where;
    for (const v of Object.values(where)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !('equals' in v || 'in' in v || 'gt' in v || 'contains' in v)) {
        flat = { ...where, ...v }; // compound key object → flatten its fields
        delete flat[Object.keys(where).find((k) => where[k] === v)];
        break;
      }
    }
    return this.records.find((r) => evalWhere(r, flat, this._resolve)) || null;
  }
  async upsert(args = {}) {
    const existing = this._matchWhere(args.where);
    return existing ? this.update({ where: { id: existing.id }, data: args.update }) : this.create({ data: { ...args.where, ...args.create } });
  }
  async delete(args = {}) {
    const rec = this._matchWhere(args.where);
    if (!rec) throw new Error('mneme: delete target not found');
    this._remove(rec);
    return rec;
  }
  async deleteMany(args = {}) {
    const rows = this.records.filter((r) => evalWhere(r, args.where, this._resolve));
    for (const rec of rows) this._remove(rec);
    return { count: rows.length };
  }
  _remove(rec) {
    const i = this.records.indexOf(rec);
    if (i >= 0) this.records.splice(i, 1);
    this.byId.delete(rec.id);
    if (this.backend?.remove) this.backend.remove(rec.id);
  }
}

function pick(rec, select) {
  const o = {};
  for (const [k, v] of Object.entries(select)) if (v) o[k] = rec[k];
  return o;
}
function applyData(rec, data) {
  for (const [k, v] of Object.entries(data || {})) {
    // prisma write ops: {set}, {increment}, {push} — support the common ones
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      if ('set' in v) rec[k] = v.set;
      else if ('increment' in v) rec[k] = (rec[k] || 0) + v.increment;
      else if ('decrement' in v) rec[k] = (rec[k] || 0) - v.decrement;
      else if ('push' in v) rec[k] = [...(rec[k] || []), ...(Array.isArray(v.push) ? v.push : [v.push])];
      else rec[k] = v;
    } else {
      rec[k] = v;
    }
  }
}

// Build the adapter for one org's .amr store. memories/relationships/segments are the loaded record
// sets; backends persist mutations. The relationship model resolves fromMemory/toMemory against the
// memory set so `where: { fromMemory: { orgId } }` works exactly like Prisma's relation filter.
export function makeMnemeAdapter({ memories = [], relationships = [], segments = [], extra = {}, backends = {} } = {}) {
  const memModel = new MnemeModel({ records: memories, backend: backends.memory });
  const memById = memModel.byId;
  const relModel = new MnemeModel({
    records: relationships,
    backend: backends.relationship,
    relations: { fromMemory: (rel) => memById.get(rel.fromId), toMemory: (rel) => memById.get(rel.toId) },
  });
  const segModel = new MnemeModel({ records: segments, backend: backends.knowledgeSegment });
  const adapter = { memory: memModel, relationship: relModel, knowledgeSegment: segModel };
  // Option B subgraph: memory's FK children (sourceMetadata, memoryVersion, memoryProject,
  // codeMemoryMetadata) + knowledgeDocument — sidecar-backed records so sai touches Postgres zero
  // times. Each gets a `memory` relation resolver for relation filters that reference the parent.
  for (const [name, recs] of Object.entries(extra)) {
    adapter[name] = new MnemeModel({
      records: recs,
      backend: backends[name],
      relations: { memory: (r) => memById.get(r.memoryId) },
    });
  }
  return adapter;
}
