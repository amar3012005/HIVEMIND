/**
 * Voice profile loader.
 *
 * HIVEMIND chat ("Talk to HIVE") should sound like the user's second brain
 * AND the organisation's voice — not a generic LLM. To do that we let users
 * save dedicated memories tagged `org-voice` (organisation-wide) or
 * `user-voice` (personal) describing tone, terminology, do/don't lists,
 * signature phrases, and example outputs.
 *
 * Saved memory shape (any of these tags makes the loader pick it up):
 *   - `org-voice`     → applied to everyone in the org
 *   - `user-voice`    → applied only to this user
 *   - `voice-profile` → either, indicates structured profile
 *
 * Memory content is treated as plain markdown / freeform text. Loader
 * concatenates and limits the total system-prompt fragment to keep token
 * usage bounded.
 */

const MAX_VOICE_CHARS = 2000;

/**
 * @param {object} store          PrismaGraphStore (persistentMemoryStore)
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.orgId
 * @returns {Promise<string>}     System-prompt fragment (empty string if nothing configured)
 */
export async function loadVoiceProfile(store, { userId, orgId }) {
  if (!store || !userId) return '';

  // listMemories supports tag filter — fetch org-voice + user-voice in parallel.
  // Both lists are scoped by user_id + org_id at the store layer, but
  // org-voice memories may have visibility=organization so they reach all
  // members. user-voice is personal.
  const [orgList, userList] = await Promise.all([
    safeList(store, { tags: ['org-voice'], user_id: userId, org_id: orgId, limit: 5, scope: 'all' }),
    safeList(store, { tags: ['user-voice'], user_id: userId, org_id: orgId, limit: 5, scope: 'personal' }),
  ]);

  const lines = [];

  if (orgList.length > 0) {
    lines.push('=== Organisation Voice ===');
    for (const mem of orgList.slice(0, 3)) {
      lines.push(stripContent(mem.content || '', 600));
    }
  }

  if (userList.length > 0) {
    lines.push('=== Personal Voice ===');
    for (const mem of userList.slice(0, 3)) {
      lines.push(stripContent(mem.content || '', 400));
    }
  }

  if (lines.length === 0) return '';

  const fragment = lines.join('\n\n').slice(0, MAX_VOICE_CHARS);

  return [
    '─── VOICE PROFILE ───',
    'When you reply, use the tone, terminology, do/don\'t rules, and example phrasing below. This is how this user / organisation actually speaks. Match the cadence, word choice, and emphasis. Do NOT default to generic LLM voice.',
    '',
    fragment,
    '─── END VOICE PROFILE ───',
  ].join('\n');
}

async function safeList(store, params) {
  try {
    const result = await store.listMemories(params);
    return result?.memories || [];
  } catch {
    return [];
  }
}

function stripContent(content, max) {
  const t = (content || '').trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + '…';
}

/**
 * Helper: build the canonical save_memory payload for setting an org or user
 * voice. Used by an MCP tool / future settings page.
 */
export function buildVoiceMemoryPayload({ scope, content, title, userId, orgId }) {
  const isOrg = scope === 'organization' || scope === 'org';
  return {
    title: title || (isOrg ? 'Organisation voice profile' : 'Personal voice profile'),
    content,
    memory_type: 'fact',
    source_platform: 'voice-profile',
    tags: [isOrg ? 'org-voice' : 'user-voice', 'voice-profile'],
    visibility: isOrg ? 'organization' : 'private',
    user_id: userId,
    org_id: orgId,
    metadata: {
      source_type: 'voice-profile',
      voice_scope: isOrg ? 'organization' : 'personal',
    },
  };
}
