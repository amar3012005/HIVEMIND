/**
 * Config Store — CRUD for system prompts per tenant/agent
 *
 * Stores config as a HIVEMIND memory:
 *   memory_type: 'tara_config'
 *   tags: ['tara-config', `tenant:${tenantId}`, `agent:${agentName}`]
 */

const DEFAULT_CONFIG = {
  system_prompt: 'You are a helpful AI assistant. Answer concisely and accurately. This is a voice conversation — keep responses under 3 sentences unless the user asks for detail.',
  clinical_prompt: '',  // empty means clinical reasoning disabled
  clinical_model: '',   // empty means use main model; set for dedicated reasoning model
  model: 'llama-3.3-70b-versatile',
  temperature: 0.7,
  max_tokens: 300,
  voice_optimized: true,
};

export class TaraConfigStore {
  constructor({ memoryStore }) {
    this.store = memoryStore;
  }

  async getConfig(tenantId, agentName, { userId, orgId } = {}) {
    // Try specific agent first, then fall back to 'default'
    const candidates = [agentName, 'default'].filter(Boolean);
    const seen = new Set();

    for (const agent of candidates) {
      if (seen.has(agent)) continue;
      seen.add(agent);
      try {
        const { memories } = await this.store.listMemories({
          user_id: userId,
          org_id: orgId,
          tags: ['tara-config', `agent:${agent}`],
          limit: 1,
        });

        if (memories?.length > 0) {
          try {
            const config = JSON.parse(memories[0].content);
            config._memory_id = memories[0].id;
            return config;
          } catch {
            return { ...DEFAULT_CONFIG, _memory_id: memories[0].id };
          }
        }
      } catch (err) {
        console.warn('[tara/config] Load failed for agent:', agent, err.message);
      }
    }

    return { ...DEFAULT_CONFIG };
  }

  async saveConfig(tenantId, agentName, config, { userId, orgId } = {}) {
    const fullConfig = { ...DEFAULT_CONFIG, ...config };
    delete fullConfig._memory_id;
    fullConfig.tenant_id = tenantId;
    fullConfig.agent_name = agentName;
    fullConfig.updated_at = new Date().toISOString();

    const content = JSON.stringify(fullConfig);
    const tags = ['tara-config', `tenant:${tenantId || 'default'}`, `agent:${agentName || 'default'}`];

    try {
      // Check if config already exists
      const existing = await this.getConfig(tenantId, agentName, { userId, orgId });
      if (existing._memory_id) {
        await this.store.updateMemory(existing._memory_id, { content, tags });
        return existing._memory_id;
      }

      // Create new
      const id = crypto.randomUUID();
      await this.store.createMemory({
        id,
        content,
        title: `TARA Config: ${agentName || 'default'}`,
        tags,
        memory_type: 'fact',  // Valid Prisma enum — identified by tags
        project: `tara/${tenantId || 'default'}`,
        user_id: userId,
        org_id: orgId,
      });
      return id;
    } catch (err) {
      console.error('[tara/config] Save failed:', err.message);
      throw err;
    }
  }
}

export { DEFAULT_CONFIG };
