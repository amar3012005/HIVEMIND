// Path B integration glue — wires the whole .amr-as-sole-store chain for ONE org and returns a
// drop-in Prisma client. The pipeline calls initMnemeStore() once at boot for the .amr org, swaps
// its prisma for the returned proxy, and writes memories through storeMemoryUnified() so the record
// + vector + edges land together in .amr (solving the dual-write consistency: in hybrid mode a
// memory's row goes to Postgres and its vector to Qdrant via two calls — here it's one .amr write).
//
// backend = { MnemeStore, MnemeMemoryBackend, MnemeRelationshipBackend } (the native binding +
// amr-store-backend), injected so this module stays unit-testable without the .node on the test host.
import { makeMnemeAdapter } from './prisma-adapter.js';
import { makeMnemePrisma } from './prisma-proxy.js';

export function initMnemeStore({ realPrisma, orgId, dim = 1024, dataRoot, backend }) {
  const store = backend.openStore(dataRoot, `org_${orgId}`, dim);
  const memBackend = new backend.MnemeMemoryBackend(store, dim);
  const relBackend = new backend.MnemeRelationshipBackend(store, memBackend);

  // hydrate every record + edge from .amr (the relational state)
  const memories = memBackend.loadAll();
  const relationships = relBackend.loadAll();

  const adapter = makeMnemeAdapter({
    memories,
    relationships,
    segments: memories.filter((m) => m.layer === 'evidence'),
    backends: { memory: memBackend, relationship: relBackend },
  });

  const prisma = makeMnemePrisma(realPrisma, { amrOrg: orgId, adapter });

  // Single unified write: the memory record + its embedding + its relationships → one .amr write.
  // Called where the pipeline currently does prisma.memory.create + qdrant.storeMemory together.
  async function storeMemoryUnified(record, vector, rels = []) {
    if (record.orgId !== orgId) return null; // only the .amr org goes here
    await adapter.memory.upsert({
      where: { id: record.id },
      create: { ...record, _vector: Array.from(vector || []) },
      update: { ...record, _vector: Array.from(vector || []) },
    });
    for (const r of rels) await adapter.relationship.create({ data: r });
    return record.id;
  }

  return { prisma, adapter, store, storeMemoryUnified, counts: { memories: memories.length, relationships: relationships.length } };
}
