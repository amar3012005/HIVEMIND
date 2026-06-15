/**
 * WS5 step-6 — Cognitive-agent persona router.
 *
 * Decides whether a query is about the USER themselves ("what are my preferences",
 * "who am I", "my role") and, if so, routes it to the persona lane: the separate
 * profile_<org> Qdrant collection (step-5) with a Postgres profile fallback. Returns
 * a compact persona-context string the agent can inject. Always per-user scoped.
 *
 * Flag-gated PERSONA_ROUTER_ENABLED (default OFF) → inert no-op unless enabled (or
 * a caller passes force:true for a dry-run). Never a correctness dependency.
 */

import getEmbedService from '../embeddings/factory.js';
import { searchPersona } from './persona-vector.js';

const PERSONA_ROUTER_ENABLED = process.env.PERSONA_ROUTER_ENABLED === 'true';

export function isPersonaRouterEnabled() { return PERSONA_ROUTER_ENABLED; }

// Cheap intent gate — is the query about the user themselves?
const PERSONA_INTENT = /\b(my|mine|myself|i'?m|i am|about me|who am i|remember me|my (?:preference|preferences|profile|role|company|goal|goals|style|name|location))\b/i;

export function isPersonaQuery(query) {
  return PERSONA_INTENT.test(String(query || ''));
}

/**
 * @param {{ query, userId, orgId, profileStore?, logger?, force?: boolean }} args
 * @returns {Promise<{ routed: boolean, reason?: string, source?: string, context: string, facts: any[] }>}
 */
export async function routePersona({ query, userId, orgId, projectId = null, profileStore = null, logger = console, force = false }) {
  if (!PERSONA_ROUTER_ENABLED && !force) return { routed: false, reason: 'disabled', context: '', facts: [] };
  if (!query || !userId) return { routed: false, reason: 'missing_args', context: '', facts: [] };
  if (!force && !isPersonaQuery(query)) return { routed: false, reason: 'not_persona_intent', context: '', facts: [] };

  let facts = [];
  try {
    const [vec] = await getEmbedService().embed([query]);
    facts = await searchPersona({ orgId, userId, queryVec: vec, limit: 6, logger });
  } catch (err) {
    logger.warn?.(`[persona-router] vector search failed: ${err.message}`);
  }

  // Fallback: Postgres profile context when the vector lane is empty/unavailable.
  if ((!facts || facts.length === 0) && profileStore) {
    try {
      // M7: pass projectId so a project-scoped turn sees org-level identity facts
      // + that project's facts only — never other projects' identity insights.
      const ctx = await profileStore.buildProfileContext(userId, orgId, projectId);
      return { routed: true, source: 'postgres', context: ctx || '', facts: [] };
    } catch (err) {
      logger.warn?.(`[persona-router] postgres fallback failed: ${err.message}`);
    }
  }

  const context = facts.length
    ? ['User persona:', ...facts.map((f) => `  - ${f.key}: ${f.value}`)].join('\n')
    : '';
  return { routed: true, source: 'vector', context, facts };
}
