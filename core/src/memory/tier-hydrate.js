/**
 * Tier hydration — promote a Tier 1 (thin index) memory to Tier 2 (hot cache).
 *
 * Trigger: recall hit on Tier 1 row, or explicit pin, or entity-in-WorkingSet.
 *
 * Flow:
 *   1. Look up manifest.tier2_promote.hydrate_tool for memory.source_platform
 *   2. Resolve external id from memory.source_metadata.source_id
 *   3. Call live tool with user's Nango bearer (gmail_read_message, etc.)
 *   4. Replace memory.content with full body, embed, update tier=2
 *   5. Upsert Qdrant vector with augmented embedding
 *
 * Best-effort: never blocks user-facing recall response. Failures logged.
 * Idempotent: re-running on a Tier 2 row is a no-op.
 */

import { getHydrateConfig, getManifest } from '../connectors/framework/connector-manifest.js';

/**
 * @param {{ prisma, qdrantClient, connectorStore, toolkitFactory }} deps
 * @param {{ memoryId: string, userId: string, orgId?: string }} args
 */
export async function hydrateMemory(deps, { memoryId, userId, orgId }) {
  const { prisma, qdrantClient } = deps || {};
  if (!prisma || !memoryId || !userId) return { ok: false, reason: 'missing-deps' };

  let memory;
  try {
    memory = await prisma.memory.findUnique({
      where: { id: memoryId },
      include: { sourceMetadata: true },
    });
  } catch (err) {
    return { ok: false, reason: 'memory-lookup-failed', error: err.message };
  }
  if (!memory) return { ok: false, reason: 'memory-not-found' };

  // Already hot — nothing to do.
  if (memory.tier === 2) {
    await prisma.memory.update({
      where: { id: memoryId },
      data: { lastAccessedAt: new Date() },
    }).catch(() => {});
    return { ok: true, reason: 'already-tier-2' };
  }

  const provider = memory.sourceMetadata?.sourcePlatform || memory.sourcePlatform;
  if (!provider) return { ok: false, reason: 'no-source-platform' };

  const manifest = getManifest(provider);
  if (!manifest) return { ok: false, reason: 'no-manifest' };

  const hydrate = getHydrateConfig(provider);
  if (!hydrate?.tool) return { ok: false, reason: 'no-hydrate-tool-configured' };

  const sourceId = memory.sourceMetadata?.sourceId;
  if (!sourceId) return { ok: false, reason: 'no-source-id' };

  // Resolve the live tool function. Two paths:
  //   a) Local Nango-REST toolkit (gmail-tools.js, gdocs-tools.js, ...)
  //   b) Remote MCP server (slack, notion, jira) — requires MCP client pool
  let fullContent = null;
  try {
    fullContent = await _callHydrateTool(deps, {
      provider, tool: hydrate.tool, sourceId, userId, orgId, manifest,
    });
  } catch (err) {
    console.warn(`[tier-hydrate] ${provider}.${hydrate.tool} failed for ${memoryId.slice(0,8)}: ${err.message}`);
    return { ok: false, reason: 'hydrate-tool-error', error: err.message };
  }

  if (!fullContent || typeof fullContent !== 'string') {
    return { ok: false, reason: 'empty-hydrate-result' };
  }

  // Update Postgres row.
  const now = new Date();
  try {
    await prisma.memory.update({
      where: { id: memoryId },
      data: {
        content: fullContent.slice(0, 200000),
        tier: 2,
        promotedAt: now,
        lastAccessedAt: now,
      },
    });
  } catch (err) {
    return { ok: false, reason: 'memory-update-failed', error: err.message };
  }

  // Re-embed augmented (title + entities + content) and upsert Qdrant.
  if (qdrantClient) {
    try {
      const entityNames = (memory.tags || [])
        .filter((t) => typeof t === 'string' && (t.startsWith('entity:') || t.startsWith('person:')))
        .map((t) => t.replace(/^(entity|person):/, '').replace(/_/g, ' '));
      const augmented = [memory.title || '', entityNames.join(', '), fullContent]
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 8000);
      const vector = await qdrantClient.generateEmbedding(augmented).catch(() => null);
      const memShape = {
        id: memoryId,
        user_id: memory.userId,
        org_id: memory.orgId,
        project: memory.project,
        content: fullContent,
        title: memory.title,
        tags: memory.tags,
        memory_type: memory.memoryType,
        source: provider,
        source_platform: provider,
        source_metadata: {
          source_type: memory.sourceMetadata?.sourceType,
          source_platform: provider,
          source_id: sourceId,
        },
        is_latest: memory.isLatest,
        created_at: memory.createdAt,
        document_date: memory.documentDate,
      };
      const collectionName = process.env.QDRANT_COLLECTION || 'BUNDB AGENT';
      if (vector) {
        await qdrantClient.storeMemory(memShape, { collectionName, vector });
      } else {
        await qdrantClient.storeMemory(memShape, { collectionName });
      }
    } catch (err) {
      console.warn(`[tier-hydrate] qdrant upsert failed for ${memoryId.slice(0,8)}: ${err.message}`);
    }
  }

  return { ok: true, reason: 'hydrated', provider, tool: hydrate.tool };
}

/**
 * Resolve + call the hydrate tool. Returns string content or throws.
 */
async function _callHydrateTool(deps, { provider, tool, sourceId, userId, orgId }) {
  // Attempt local Nango-REST toolkit first (gmail, gdocs, gemini).
  // toolkit-factory exports buildNangoToolFn(provider, toolName, userId, orgId) when wired.
  // Fallback: direct fetch helpers in connector-toolkits/<provider>-tools.js
  switch (provider) {
    case 'gmail': {
      const { nangoProxyFetch } = await import('../agent/connector-toolkits/nango-fetch.js');
      const ctx = { userId, orgId };
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(sourceId)}?format=full`;
      const data = await nangoProxyFetch({ providerKey: 'google-mail', url, ctx });
      const messages = (data?.messages || []).map((m) => {
        const headers = Object.fromEntries((m.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
        return [
          `From: ${headers.from || ''}`,
          `To: ${headers.to || ''}`,
          `Subject: ${headers.subject || ''}`,
          `Date: ${headers.date || ''}`,
          '',
          _extractGmailBody(m.payload).slice(0, 4000),
        ].join('\n');
      });
      return messages.join('\n\n---\n\n');
    }
    case 'slack':
      // Slack uses hosted MCP — needs MCP client pool. Defer in v1.
      throw new Error('slack hydrate not yet wired (needs MCP client pool integration)');
    case 'salesforce':
      // SF live tool not yet built — surfaces gap explicitly
      throw new Error('salesforce hydrate requires salesforce_get_record toolkit (Phase C)');
    default:
      throw new Error(`no hydrate adapter wired for provider=${provider}`);
  }
}

// Minimal Gmail MIME body extractor — mirrors gmail-tools.js extractBody.
function _extractGmailBody(payload) {
  if (!payload) return '';
  if (payload.body?.data) {
    try {
      return Buffer.from(payload.body.data, 'base64url').toString('utf8');
    } catch {
      return '';
    }
  }
  for (const part of payload.parts || []) {
    const body = _extractGmailBody(part);
    if (body) return body;
  }
  return '';
}
