function asArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function uniqueStrings(values = []) {
  return [...new Set(asArray(values).map(value => `${value}`.trim()).filter(Boolean))];
}

export function normalizeWebappPlatform(platform) {
  const raw = `${platform || 'webapp'}`.trim().toLowerCase();

  if (['chatgpt', 'openai', 'gpt'].includes(raw)) return 'chatgpt';
  if (['gemini', 'google-gemini'].includes(raw)) return 'gemini';
  if (['claude', 'anthropic'].includes(raw)) return 'claude';
  if (['codex'].includes(raw)) return 'codex';
  return raw || 'webapp';
}

export function buildWebappContextResponse(recall, options = {}) {
  const {
    query,
    platform,
    project = null,
    preferredSources = [],
    preferredTags = [],
    maxMemories = 5
  } = options;

  const normalizedPlatform = normalizeWebappPlatform(platform);
  const memories = recall.memories || [];
  const injectionText = recall.injectionText || '<relevant-memories>\n</relevant-memories>';

  const systemPrompt = [
    'You have access to tenant-scoped HIVE-MIND memory.',
    'Use the memory context below when it is directly relevant.',
    'Do not invent facts that are not supported by memory context.',
    'If memory is insufficient, say so explicitly.',
    '',
    injectionText
  ].join('\n');

  return {
    ok: true,
    platform: normalizedPlatform,
    query,
    project,
    search_method: recall.search_method || 'persisted-keyword',
    policy: {
      preferred_project: project,
      preferred_source_platforms: uniqueStrings(preferredSources),
      preferred_tags: uniqueStrings(preferredTags),
      max_memories: maxMemories
    },
    context: {
      system_prompt: systemPrompt,
      injection_text: injectionText,
      memories
    }
  };
}

export function buildWebappSavePayload(body = {}, principal = {}) {
  const platform = normalizeWebappPlatform(body.platform || body.source_platform || 'webapp');
  const tags = uniqueStrings([
    ...(body.tags || []),
    ...(body.memory_tags || []),
    platform,
    'webapp'
  ]);

  return {
    user_id: principal.userId,
    org_id: principal.orgId,
    project: body.project || null,
    content: body.content,
    memory_type: body.memory_type || body.memoryType || 'fact',
    title: body.title || null,
    tags,
    importance_score: body.importance_score ?? body.importanceScore ?? 0.5,
    document_date: body.document_date || null,
    event_dates: body.event_dates || [],
    source_platform: platform,
    source_session_id: body.session_id || body.source_session_id || null,
    source_message_id: body.message_id || body.source_message_id || null,
    source_url: body.source_url || null,
    metadata: {
      ...(body.metadata || {}),
      webapp_platform: platform,
      model: body.model || null,
      prompt_id: body.prompt_id || null,
      conversation_id: body.conversation_id || null
    }
  };
}

export function buildPromptEnvelope(body = {}, context = {}) {
  const userPrompt = body.user_prompt || body.prompt || body.query || '';
  const messages = [];

  if (context.system_prompt) {
    messages.push({ role: 'system', content: context.system_prompt });
  }

  if (body.messages && Array.isArray(body.messages)) {
    messages.push(...body.messages);
  } else if (userPrompt) {
    messages.push({ role: 'user', content: userPrompt });
  }

  return {
    platform: normalizeWebappPlatform(body.platform),
    model: body.model || null,
    conversation_id: body.conversation_id || null,
    messages
  };
}
