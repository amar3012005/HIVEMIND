/**
 * Chat-session distiller — bulk-mode.
 *
 * Input: parsed memories from an external AI chat (ChatGPT/Claude/Gemini/
 * Perplexity) where the host LLM produced a structured markdown summary
 * the extension parsed into { title, summary, memories[], open_questions[] }.
 *
 * Job: dedupe / update / save each candidate against the user's existing
 * HIVEMIND graph in ONE bulk Groq call (not one per memory) for speed and
 * cost. The LLM returns a decision array; we then execute the canonical
 * ingest path for each.
 *
 *   actions[i] ∈ { save, update, skip }
 *
 * Returns: { saved, updated, deduped, memory_ids, errors }
 */

import { recallPersistedMemories } from '../memory/persisted-retrieval.js';
import { resolveDistillActions } from './chat-ingest-actions.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DISTILL_MODEL = process.env.HIVEMIND_DISTILL_MODEL || 'openai/gpt-oss-120b';

const DISTILL_SYSTEM_PROMPT = `You are HIVEMIND's chat-session distiller.

Input: a list of candidate memories the user revealed in a chat with an
external AI (ChatGPT/Claude/Gemini/Perplexity), plus the user's nearest
existing memories for each candidate.

For each candidate, decide ONE of:
  • save    — new info, no existing match → save fresh
  • update  — refines / replaces an existing memory (cite its id)
  • skip    — duplicate of existing, or chitchat, or non-durable

Output: STRICT JSON only — no preamble — matching this schema:

{
  "actions": [
    {
      "index": <int — position in candidates array>,
      "action": "save" | "update" | "skip",
      "target_memory_id": "<uuid if action=update, else null>",
      "reason": "<one-sentence why>"
    },
    ...
  ]
}

Rules:
  • One action per candidate. Always include every candidate's index.
  • Choose "skip" liberally for chitchat / common knowledge / duplicates.
  • Choose "update" only when the new content materially refines a prior
    memory (e.g. job title changed, deadline moved, preference flipped).
  • If genuinely new → "save".
  • Never invent target_memory_id — only use ids that appear in the
    "existing_neighbors" of that candidate.`;

async function callLLMJSON({ messages, apiKey, model, signal }) {
  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
    signal,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Groq ${resp.status}: ${text.slice(0, 400)}`);
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  try { return JSON.parse(content); } catch { return {}; }
}

/**
 * @param {Object} opts
 * @param {Array}  opts.candidates — [{ title, content, tags, memory_type }]
 * @param {string} opts.platform   — 'chatgpt' | 'claude' | …
 * @param {string} opts.url        — source URL of the chat
 * @param {string} opts.userId
 * @param {string} opts.orgId
 * @param {Object} opts.ctx        — { persistentMemoryStore, documentFirstIngestion,
 *                                     accessContext }
 * @param {string} opts.apiKey     — GROQ_API_KEY
 * @returns {Promise<{saved,updated,deduped,memory_ids,errors,actions}>}
 */
export async function distillChatSession({ candidates, platform, url, userId, orgId, ctx, apiKey }) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { saved: 0, updated: 0, deduped: 0, memory_ids: [], errors: [], actions: [] };
  }
  if (!apiKey) throw new Error('GROQ_API_KEY required');
  if (!ctx?.persistentMemoryStore || !ctx?.documentFirstIngestion?.ingestSource) {
    throw new Error('memory pipeline ctx unavailable');
  }

  // 1. Recall nearest neighbors for each candidate (parallel, capped).
  const neighborsPerCand = await Promise.all(
    candidates.map(async (c) => {
      try {
        const result = await recallPersistedMemories(ctx.persistentMemoryStore, {
          query_context: c.content || c.title,
          user_id: userId,
          org_id: orgId,
          max_memories: 5,
          access_context: ctx.accessContext,
        });
        return (result.memories || []).map((m) => ({
          id: m.id,
          title: m.title,
          content: (m.content || '').slice(0, 240),
          tags: m.tags,
          score: m.score,
        }));
      } catch {
        return [];
      }
    })
  );

  // 2. Build single bulk LLM prompt.
  const userPayload = {
    platform,
    source_url: url,
    candidates: candidates.map((c, i) => ({
      index: i,
      title: c.title,
      content: c.content,
      tags: c.tags,
      memory_type: c.memory_type,
      existing_neighbors: neighborsPerCand[i] || [],
    })),
  };

  const llmResult = await callLLMJSON({
    apiKey,
    model: DISTILL_MODEL,
    messages: [
      { role: 'system', content: DISTILL_SYSTEM_PROMPT },
      { role: 'user', content: `Decide actions for these candidates:\n\n${JSON.stringify(userPayload, null, 2)}` },
    ],
  });

  // Fail closed. Missing/malformed decisions and invented update targets must
  // never turn unreviewed chat text into durable or destructive writes.
  const decided = resolveDistillActions(llmResult.actions, candidates, neighborsPerCand);

  // 3. Execute actions.
  const out = { saved: 0, updated: 0, deduped: 0, memory_ids: [], errors: [], actions: [], rows: [] };
  const platformTag = (platform || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '');

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const decision = decided.get(i);
    out.actions.push({ index: i, ...decision });
    try {
      if (decision.action === 'skip') {
        out.deduped++;
        out.rows.push({
          action: 'deduped',
          title: cand.title,
          memory_type: cand.memory_type,
          tags: cand.tags,
          id: decision.target_memory_id || null,
          reason: decision.reason || 'duplicate of existing memory',
        });
        continue;
      }

      const baseTags = Array.from(new Set([
        ...(cand.tags || []),
        `from-${platformTag}`,
        'ai-chat-ingest',
        ...(url ? [`url:${new URL(url).hostname}`] : []),
      ]));

      const scopedProjectId = ctx?.projectId || null;
      const source = {
        type: 'chat',
        platform: 'ai-chat',
        sourceId: url || `${platformTag}:session`,
        url: url || null,
        title: cand.title,
      };
      const commonEnvelope = {
        userId,
        orgId,
        content: cand.content,
        title: cand.title,
        source,
        mode: 'atomic',
        tags: baseTags,
        ...(scopedProjectId ? { scope: 'project', projectId: scopedProjectId } : {}),
        metadata: {
          memory_type: cand.memory_type || 'fact',
          host_platform: platform,
          via: 'chat-ingest-distill',
        },
      };

      if (decision.action === 'update' && decision.target_memory_id) {
        const updated = await ctx.documentFirstIngestion.ingestSource({
          ...commonEnvelope,
          relationship: {
            type: 'Updates',
            target_id: decision.target_memory_id,
            confidence: 1,
            reason: decision.reason || `refined via ${platform} chat ingest`,
          },
          relatedTo: decision.target_memory_id,
        });
        if (!updated?.ok || !updated.memoryIds?.length) {
          throw new Error(updated?.error || 'canonical chat update was not persisted');
        }
        const updatedId = updated.memoryIds[0];
        out.updated++;
        out.memory_ids.push(updatedId);
        out.rows.push({
          action: 'updated',
          title: cand.title,
          memory_type: cand.memory_type,
          tags: baseTags,
          id: updatedId,
          reason: decision.reason || '',
        });
        continue;
      }

      // save
      const saved = await ctx.documentFirstIngestion.ingestSource(commonEnvelope);
      if (!saved?.ok || !saved.memoryIds?.length) {
        throw new Error(saved?.error || 'canonical chat memory was not persisted');
      }
      out.saved++;
      const savedId = saved.memoryIds[0];
      if (savedId) out.memory_ids.push(savedId);
      out.rows.push({
        action: 'saved',
        title: cand.title,
        memory_type: cand.memory_type || 'fact',
        tags: baseTags,
        id: savedId,
        reason: decision.reason || '',
      });
    } catch (err) {
      out.errors.push({ index: i, error: err.message });
      out.rows.push({
        action: 'error',
        title: cand.title,
        memory_type: cand.memory_type,
        tags: cand.tags,
        id: null,
        reason: err.message,
      });
    }
  }

  return out;
}
