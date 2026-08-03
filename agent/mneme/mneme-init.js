// Path B integration glue — wires the WHOLE memory subgraph for one org so it touches Postgres zero
// times. memory + relationship live in the .amr shard (records+vectors+edges); the FK-child tables
// (sourceMetadata, memoryVersion, memoryProject, codeMemoryMetadata) + knowledgeDocument/Segment live
// in per-model JSON sidecars alongside the shard. No FK enforcement = the relational hub can leave
// Postgres. Returns a drop-in Prisma proxy routing all of these per-org.
//
// backend = { openStore, MnemeMemoryBackend, MnemeRelationshipBackend, SidecarBackend } (native
// binding + amr-store-backend), injected so this module stays testable without the .node.
import { makeMnemeAdapter } from './prisma-adapter.js';
import { makeMnemePrisma } from './prisma-proxy.js';

// memory's FK children + KB doc tables → sidecar records (no vectors needed for their queries).
const SIDECAR_MODELS = [
  'sourceMetadata', 'memoryVersion', 'memoryProject', 'codeMemoryMetadata',
  'derivationJob', 'memoryDerivation', 'memoryEvidenceLink', 'vectorEmbedding',
  'entityMention', 'memoryEntityLink', 'knowledgeDocument', 'knowledgeSegment',
  // TENANT-DATA PLACEMENT, added 2026-08-03. document_tables/_rows hold the literal cell
  // contents of a tenant's spreadsheets. They were absent here AND from ROUTED_MODELS, so
  // for the 7 of 13 orgs on .amr those cells were written to CENTRAL Postgres — exactly
  // what a BYOD tenant chose .amr to avoid. SidecarBackend is generic ({dir}/_<name>.json),
  // so the store needs no change. NOTE: ROUTED_MODELS alone would have been a NO-OP —
  // prisma-proxy's wrapModel falls back to real Prisma when the adapter lacks the model,
  // so both lists must carry it or nothing routes.
  'documentTable', 'documentTableRow',
];

export function initMnemeStore({ realPrisma, orgId, dim = 1024, dataRoot, backend }) {
  const dir = `${dataRoot}/org_${orgId}`;
  const store = backend.openStore(dataRoot, `org_${orgId}`, dim);
  const memBackend = new backend.MnemeMemoryBackend(store, dim);
  const relBackend = new backend.MnemeRelationshipBackend(store, memBackend);

  const memories = memBackend.loadAll();
  const relationships = relBackend.loadAll();

  // sidecar-backed subgraph models
  const backends = { memory: memBackend, relationship: relBackend };
  const extra = {};
  let segments = [];
  for (const name of SIDECAR_MODELS) {
    const sb = new backend.SidecarBackend(`${dir}/_${name}.json`);
    backends[name] = sb;
    if (name === 'knowledgeSegment') segments = sb.loadAll();
    else extra[name] = sb.loadAll();
  }

  const adapter = makeMnemeAdapter({ memories, relationships, segments, extra, backends });
  const prisma = makeMnemePrisma(realPrisma, { amrOrg: orgId, adapter });

  // Single unified write: memory record + embedding + relationships → one .amr write. Called where
  // the pipeline currently does qdrant.storeMemory (it has both the record and the vector).
  async function storeMemoryUnified(record, vector, rels = []) {
    if (record.orgId !== orgId) return null;
    await adapter.memory.upsert({
      where: { id: record.id },
      create: { ...record, _vector: Array.from(vector || []) },
      update: { ...record, _vector: Array.from(vector || []) },
    });
    for (const r of rels) await adapter.relationship.create({ data: r });
    return record.id;
  }

  return {
    prisma, adapter, store, storeMemoryUnified,
    counts: { memories: memories.length, relationships: relationships.length, segments: segments.length },
  };
}
