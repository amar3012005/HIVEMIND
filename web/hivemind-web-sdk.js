export class HivemindWebClient {
  constructor({ baseUrl, apiKey }) {
    this.baseUrl = (baseUrl || 'http://localhost:3000').replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  async request(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      throw new Error(data?.message || data?.error || `HTTP ${response.status}`);
    }

    return data;
  }

  async prepareContext({
    platform,
    query,
    prompt,
    userPrompt,
    project,
    tags = [],
    preferredSourcePlatforms = [],
    preferredTags = [],
    maxMemories = 5,
    messages = [],
    model = null,
    conversationId = null
  }) {
    return this.request('/api/integrations/webapp/prepare', {
      method: 'POST',
      body: {
        platform,
        query: query || userPrompt || prompt || '',
        user_prompt: userPrompt || prompt || query || '',
        prompt: prompt || userPrompt || query || '',
        project,
        tags,
        preferred_source_platforms: preferredSourcePlatforms,
        preferred_tags: preferredTags,
        max_memories: maxMemories,
        messages,
        model,
        conversation_id: conversationId
      }
    });
  }

  async storeMemory({
    platform,
    content,
    memoryType = 'fact',
    title = null,
    tags = [],
    importanceScore = 0.5,
    project = null,
    model = null,
    conversationId = null,
    sessionId = null,
    messageId = null,
    metadata = {}
  }) {
    return this.request('/api/integrations/webapp/store', {
      method: 'POST',
      body: {
        platform,
        content,
        memory_type: memoryType,
        title,
        tags,
        importance_score: importanceScore,
        project,
        model,
        conversation_id: conversationId,
        session_id: sessionId,
        message_id: messageId,
        metadata
      }
    });
  }
}

export async function createChatCompletionEnvelope(client, options) {
  const prepared = await client.prepareContext(options);
  return prepared.prompt_envelope;
}
