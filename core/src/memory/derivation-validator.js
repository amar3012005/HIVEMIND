import { memoryChatFetch, memoryLLMRoute } from '../llm/groq-fallback.js';

export const DERIVATION_CONFIDENCE_THRESHOLD = 0.75;

export function hasVerifiedDerivationSource(memory) {
  if (!memory || !memory.id) return false;
  if (Array.isArray(memory.evidenceLinks) && memory.evidenceLinks.length > 0) return true;
  const source = memory.sourceMetadata || memory.source_metadata || {};
  if (source.sourceId || source.source_id || source.sourceUrl || source.source_url) return true;
  if (memory.sourceMessageId || memory.sourceSessionId || memory.sourceUrl) return true;
  const evidenceIds = memory.synthesisEvidenceIds || memory.synthesis_evidence_ids;
  return Array.isArray(evidenceIds) && evidenceIds.length > 0;
}

export async function validateDerivation({ source, target, timeoutMs = 5_000 }) {
  if (!hasVerifiedDerivationSource(source)) {
    return { approved: false, confidence: 0, reason: 'source_provenance_unverified' };
  }
  const route = memoryLLMRoute();
  const apiKey = route?.key || process.env.GROQ_API_KEY;
  if (!apiKey) return { approved: false, confidence: 0, reason: 'llm_unavailable' };
  const model = process.env.DERIVATION_MODEL || route?.model
    || process.env.MEMORY_FAST_MODEL || 'llama-3.1-8b-instant';
  try {
    const response = await memoryChatFetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 180,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'Decide whether TARGET is a justified inference derived from SOURCE, not merely related, repeated, updated, or contradictory. Return only JSON: {"derives":boolean,"confidence":number,"reason":string}.',
          },
          { role: 'user', content: `SOURCE:\n${String(source?.content || '').slice(0, 1800)}\n\nTARGET:\n${String(target?.content || '').slice(0, 1800)}` },
        ],
      }),
    }, { timeoutMs });
    if (!response.ok) return { approved: false, confidence: 0, reason: `llm_${response.status}` };
    const body = await response.json();
    const parsed = JSON.parse(body?.choices?.[0]?.message?.content || '{}');
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    return {
      approved: parsed.derives === true && confidence >= DERIVATION_CONFIDENCE_THRESHOLD,
      confidence,
      reason: String(parsed.reason || '').slice(0, 300),
    };
  } catch (error) {
    return { approved: false, confidence: 0, reason: `validation_failed:${String(error.message || error).slice(0, 200)}` };
  }
}
