const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

function contentHashSignature(content, orgId, userId) {
  const h = crypto.createHash('sha256');
  h.update(String(orgId || userId || 'global'));
  h.update('\0');
  h.update(String(content || ''));
  return h.digest('hex');
}

let cachedCore = null;
let cachedWriter = null;

function resolveFirstExisting(paths) {
  for (const candidate of paths) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return paths[0];
}

function loadLocalEnv() {
  const envPath = resolveFirstExisting([
    path.resolve(__dirname, '../../core/.env'),
    path.resolve(__dirname, '../.env')
  ]);

  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function toModuleUrl(relativePath) {
  return pathToFileURL(path.resolve(__dirname, relativePath)).href;
}

async function loadCore() {
  loadLocalEnv();

  if (cachedCore) {
    return cachedCore;
  }

  // Two layouts exist:
  //   - dev: <repo>/core/src/ingestion/ → core/src/db/prisma.js lives at ../..
  //   - container: /app/src/ingestion/ → /app/src/db/prisma.js lives at ..
  // The old second candidate ('../src') resolved to /app/src/src — bogus.
  const coreBase = resolveFirstExisting([
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '../../core/src'),
    path.resolve(__dirname, '../../src')
  ]);

  const [{ getPrismaClient, ensureTenantContext }, { PrismaGraphStore }, { MemoryGraphEngine }, { DocumentFirstIngestionService }] = await Promise.all([
    import(pathToFileURL(path.join(coreBase, 'db/prisma.js')).href),
    import(pathToFileURL(path.join(coreBase, 'memory/prisma-graph-store.js')).href),
    import(pathToFileURL(path.join(coreBase, 'memory/graph-engine.js')).href),
    import(pathToFileURL(path.join(coreBase, 'knowledge/document-first-ingestion.js')).href),
  ]);

  cachedCore = { getPrismaClient, ensureTenantContext, PrismaGraphStore, MemoryGraphEngine, DocumentFirstIngestionService };
  return cachedCore;
}

function toScopeChain(scopeChain) {
  if (Array.isArray(scopeChain)) return scopeChain.filter(Boolean);
  if (typeof scopeChain === 'string' && scopeChain.trim()) {
    return scopeChain.split('>').map((part) => part.trim()).filter(Boolean);
  }
  return [];
}

function buildSourceMetadata(context) {
  return {
    source_type: context.source_type,
    source_platform: context.source_platform || context.source_type,
    source_id: context.source_id || context.filepath || context.request_id,
    source_url: context.source_url || null,
  };
}

function buildCodeMetadata(chunk, context) {
  if (context.source_type !== 'code') {
    return null;
  }

  const scopeChain = toScopeChain(chunk.scope_chain);
  return {
    filepath: context.filepath || context.source_id || 'unknown',
    language: context.language || 'plaintext',
    entity_type: scopeChain.length > 1 ? 'member' : null,
    entity_name: scopeChain[scopeChain.length - 1] || null,
    start_line: chunk.metadata?.start_line || null,
    end_line: chunk.metadata?.end_line || null,
    scope_chain: scopeChain,
    signatures: chunk.metadata?.signature ? [chunk.metadata.signature] : [],
    imports: chunk.metadata?.imports || [],
    dependencies: chunk.metadata?.imports || [],
    nws_count: String(chunk.content || '').replace(/\s+/g, '').length,
    metadata: {
      page_number: chunk.metadata?.page_number || 1,
      chunk_strategy: chunk.metadata?.chunk_strategy || null,
    },
  };
}

async function createPersistedMemoryWriter() {
  if (cachedWriter) {
    return cachedWriter;
  }

  const { getPrismaClient, ensureTenantContext, PrismaGraphStore, MemoryGraphEngine, DocumentFirstIngestionService } = await loadCore();
  const prisma = getPrismaClient();
  if (!prisma) {
    return null;
  }

  const store = new PrismaGraphStore(prisma);
  const engine = new MemoryGraphEngine({ store });
  const canonicalIngestion = new DocumentFirstIngestionService({ db: prisma, memoryGraphEngine: engine });

  cachedWriter = {
    async persistChunk(chunk, context) {
      await ensureTenantContext(prisma, {
        user_id: context.user_id,
        org_id: context.org_id,
      });

      // Content-hash dedup: same chunk content for same tenant reuses the
      // existing Memory row instead of creating a duplicate. The hash is
      // stored on metadata.content_hash and indexed via Prisma's JSON-path
      // ops. We tolerate the index being absent — fall back to a JSONB
      // scan, which is still much faster than re-embedding + re-ingesting.
      const contentHash = contentHashSignature(chunk.content, context.org_id, context.user_id);

      try {
        // Memory metadata lives on the joined `source_metadata` table
        // (Prisma model MemorySourceMetadata @@map "source_metadata").
        // We look up by content_hash + tenant in a single raw query.
        const orgFilter = context.org_id ? 'AND m.org_id = $2::uuid' : '';
        const userFilter = context.user_id ? `AND m.user_id = $${context.org_id ? 3 : 2}::uuid` : '';
        const sql = `
          SELECT m.id
          FROM memories m
          JOIN source_metadata sm ON sm.memory_id = m.id
          WHERE sm.metadata->>'content_hash' = $1
                ${orgFilter}
                ${userFilter}
          LIMIT 1
        `;
        const params = [contentHash];
        if (context.org_id) params.push(context.org_id);
        if (context.user_id) params.push(context.user_id);
        const rows = await prisma.$queryRawUnsafe(sql, ...params);
        if (Array.isArray(rows) && rows.length > 0) {
          const memory = await store.getMemory(rows[0].id);
          if (memory) {
            return { memory, edges_created: 0, deduped: true };
          }
        }
      } catch (err) {
        console.warn('[ingest-persist] dedup lookup failed:', err.message);
      }

      const input = {
        user_id: context.user_id,
        org_id: context.org_id,
        project: context.project || null,
        content: chunk.content,
        title: context.title || null,
        memory_type: context.memory_type || 'fact',
        tags: [...new Set([...(context.tags || []), context.source_type])],
        relationship: context.relationship || null,
        document_date: context.document_date || null,
        event_dates: context.event_dates || [],
        source_metadata: buildSourceMetadata(context),
        metadata: {
          ...(context.metadata || {}),
          ...(chunk.metadata || {}),
          memory_type: context.memory_type || 'fact',
          content_hash: contentHash,
          filepath: context.filepath || null,
          language: context.language || null,
          source_session_id: context.source_session_id || null,
          source_message_id: context.source_message_id || null,
          ast_metadata: context.source_type === 'code' ? {
            scopeChain: toScopeChain(chunk.scope_chain),
            signature: chunk.metadata?.signature || null,
            imports: chunk.metadata?.imports || [],
          } : undefined,
        },
        skip_relationship_classification: context.source_type === 'code',
      };

      const codeMetadata = buildCodeMetadata(chunk, context);
      if (codeMetadata) {
        input.code_metadata = codeMetadata;
        input.metadata.code_metadata = codeMetadata;
      }

      const canonicalResult = await canonicalIngestion.ingestSource({
        userId: context.user_id,
        orgId: context.org_id,
        content: chunk.content,
        title: context.title || null,
        occurredAt: context.document_date || null,
        scope: context.scope || undefined,
        projectId: context.project_id || undefined,
        mode: 'atomic',
        tags: input.tags,
        relationship: context.relationship || undefined,
        relatedTo: context.related_to || undefined,
        metadata: input.metadata,
        source: {
          type: 'api', platform: context.source_platform || context.source_type || 'indexer',
          sourceId: context.source_id || context.filepath || context.request_id,
          url: context.source_url || null,
          title: context.title || null,
        },
      });
      if (!canonicalResult?.ok) throw new Error(canonicalResult?.error || 'canonical indexer ingest failed');
      const result = { ...canonicalResult, memoryId: canonicalResult.memoryId || canonicalResult.memoryIds?.[0] };
      const memory = await store.getMemory(result.memoryId);

      return {
        memory,
        edges_created: result.edgesCreated?.length || 0,
      };
    },
  };

  return cachedWriter;
}

module.exports = {
  createPersistedMemoryWriter,
};
