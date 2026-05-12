/**
 * EmployeeStore — Prisma-backed CRUD for DigitalEmployee.
 * Used by REST endpoints in control-plane and the Python sidecar's
 * runtime-config fetch.
 *
 * Permission model lives at the REST layer (P0-4 RBAC):
 *   - Create / archive: connector:manage OR org_admin
 *   - Pause / resume: team_lead of employee.teamId OR org_admin
 *   - Read:           any team member (scope-respecting)
 *
 * This module performs DB ops only; access checks happen upstream.
 */

const VALID_STATUSES = new Set(['draft', 'deploying', 'running', 'paused', 'error']);
const VALID_SCOPES = new Set(['personal', 'team', 'organization']);

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'agent';
}

const PUBLIC_FIELDS = {
  id: true,
  orgId: true,
  teamId: true,
  name: true,
  slug: true,
  avatarUrl: true,
  persona: true,
  model: true,
  llmProvider: true,
  scope: true,
  slackTeamId: true,
  slackBotUserId: true,
  slackChannelsAllowed: true,
  slackDisplayName: true,
  slackAvatarEmoji: true,
  roleArchetype: true,
  peerReviewTargets: true,
  tools: true,
  policyRules: true,
  status: true,
  replicas: true,
  maxReplicas: true,
  metricsLast24h: true,
  lastActiveAt: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
};

export class EmployeeStore {
  constructor(prisma) {
    if (!prisma) throw new Error('EmployeeStore: prisma required');
    this.prisma = prisma;
  }

  // ── Reads ────────────────────────────────────────────────

  async listForOrg({ orgId }) {
    return this.prisma.digitalEmployee.findMany({
      where: { orgId, archivedAt: null },
      select: PUBLIC_FIELDS,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async listForUserScope({ userId, orgId, teamIds }) {
    return this.prisma.digitalEmployee.findMany({
      where: {
        orgId,
        archivedAt: null,
        OR: [
          { scope: 'organization' },
          { scope: 'team', teamId: { in: teamIds } },
          { createdBy: userId },
        ],
      },
      select: PUBLIC_FIELDS,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async getById({ id, orgId }) {
    return this.prisma.digitalEmployee.findFirst({
      where: { id, orgId },
      select: PUBLIC_FIELDS,
    });
  }

  // Runtime config — used by Python sidecar at container boot.
  // Excludes raw API key (sidecar already has it via env).
  async getRuntimeConfig({ id }) {
    const emp = await this.prisma.digitalEmployee.findUnique({
      where: { id },
      select: {
        id: true, orgId: true, teamId: true, slug: true, name: true,
        persona: true, model: true, llmProvider: true, scope: true,
        slackTeamId: true, slackChannelsAllowed: true,
        tools: true, policyRules: true, status: true,
      },
    });
    if (!emp) return null;
    return {
      ...emp,
      hivemind_core_url: process.env.HIVEMIND_PUBLIC_CORE_URL
        || process.env.HIVEMIND_CORE_URL
        || null,
    };
  }

  // ── Mutations ────────────────────────────────────────────

  async create({ orgId, teamId, name, persona, model, llmProvider,
                 scope, slackTeamId, slackChannelsAllowed, tools,
                 policyRules, replicas, maxReplicas, avatarUrl,
                 slackDisplayName, slackAvatarEmoji,
                 roleArchetype, peerReviewTargets,
                 createdBy, hivemindApiKeyId }) {
    if (!name || !persona) throw new Error('name + persona required');
    if (scope && !VALID_SCOPES.has(scope)) throw new Error(`Invalid scope: ${scope}`);

    const baseSlug = slugify(name);
    let slug = baseSlug;
    let n = 1;
    while (await this.prisma.digitalEmployee.findUnique({
      where: { orgId_slug: { orgId, slug } },
    })) {
      n += 1;
      slug = `${baseSlug}-${n}`;
    }

    return this.prisma.digitalEmployee.create({
      data: {
        orgId,
        teamId: teamId || null,
        name: name.trim(),
        slug,
        avatarUrl: avatarUrl || null,
        persona,
        model: model || 'claude-haiku-4-5',
        llmProvider: llmProvider || 'anthropic',
        scope: scope || 'team',
        slackTeamId: slackTeamId || null,
        slackChannelsAllowed: Array.isArray(slackChannelsAllowed) ? slackChannelsAllowed : [],
        tools: Array.isArray(tools) ? tools : [
          'hivemind_recall', 'hivemind_save_memory',
          'hivemind_slack_post', 'hivemind_slack_search',
        ],
        policyRules: policyRules || {},
        replicas: replicas || 1,
        maxReplicas: maxReplicas || 3,
        status: 'draft',
        hivemindApiKeyId: hivemindApiKeyId || null,
        createdBy,
        slackDisplayName: slackDisplayName || null,
        slackAvatarEmoji: slackAvatarEmoji || null,
        roleArchetype: roleArchetype || null,
        peerReviewTargets: Array.isArray(peerReviewTargets) ? peerReviewTargets : [],
      },
      select: PUBLIC_FIELDS,
    });
  }

  async update({ id, data }) {
    const allowed = {};
    if (typeof data.name === 'string') allowed.name = data.name.trim();
    if (typeof data.persona === 'string') allowed.persona = data.persona;
    if (typeof data.model === 'string') allowed.model = data.model;
    if (typeof data.llmProvider === 'string') allowed.llmProvider = data.llmProvider;
    if (typeof data.avatarUrl === 'string') allowed.avatarUrl = data.avatarUrl;
    if (data.scope && VALID_SCOPES.has(data.scope)) allowed.scope = data.scope;
    if (Array.isArray(data.slackChannelsAllowed)) allowed.slackChannelsAllowed = data.slackChannelsAllowed;
    if (Array.isArray(data.tools)) allowed.tools = data.tools;
    if (data.policyRules && typeof data.policyRules === 'object') allowed.policyRules = data.policyRules;
    if (Number.isInteger(data.replicas)) allowed.replicas = data.replicas;
    if (Number.isInteger(data.maxReplicas)) allowed.maxReplicas = data.maxReplicas;
    if (typeof data.teamId === 'string' || data.teamId === null) allowed.teamId = data.teamId;
    if (typeof data.slackTeamId === 'string' || data.slackTeamId === null) allowed.slackTeamId = data.slackTeamId;
    if (typeof data.slackBotUserId === 'string') allowed.slackBotUserId = data.slackBotUserId;
    if (typeof data.slackDisplayName === 'string' || data.slackDisplayName === null) allowed.slackDisplayName = data.slackDisplayName;
    if (typeof data.slackAvatarEmoji === 'string' || data.slackAvatarEmoji === null) allowed.slackAvatarEmoji = data.slackAvatarEmoji;
    if (typeof data.roleArchetype === 'string' || data.roleArchetype === null) allowed.roleArchetype = data.roleArchetype;
    if (Array.isArray(data.peerReviewTargets)) allowed.peerReviewTargets = data.peerReviewTargets;

    if (Object.keys(allowed).length === 0) {
      throw new Error('No mutable fields supplied');
    }
    return this.prisma.digitalEmployee.update({
      where: { id },
      data: allowed,
      select: PUBLIC_FIELDS,
    });
  }

  async setStatus({ id, status, errorMessage }) {
    if (!VALID_STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
    const data = { status };
    if (status === 'paused' || status === 'running') data.lastActiveAt = new Date();
    if (errorMessage && status === 'error') {
      data.metricsLast24h = { ...{}, last_error: errorMessage, last_error_at: new Date().toISOString() };
    }
    return this.prisma.digitalEmployee.update({
      where: { id },
      data,
      select: PUBLIC_FIELDS,
    });
  }

  async archive({ id }) {
    return this.prisma.digitalEmployee.update({
      where: { id },
      data: { archivedAt: new Date(), status: 'paused' },
      select: PUBLIC_FIELDS,
    });
  }

  async pauseAllInOrg({ orgId }) {
    return this.prisma.digitalEmployee.updateMany({
      where: { orgId, archivedAt: null, status: { not: 'paused' } },
      data: { status: 'paused' },
    });
  }

  async setApiKeyId({ id, hivemindApiKeyId }) {
    return this.prisma.digitalEmployee.update({
      where: { id },
      data: { hivemindApiKeyId },
      select: PUBLIC_FIELDS,
    });
  }

  /**
   * Persist the encrypted plaintext scoped API key alongside the metadata
   * row. Phase 2.4 lets the Python sidecar fetch it (decrypted) on boot
   * via /v1/employees/bootstrap so we don't need per-employee env vars.
   */
  async setScopedApiKey({ id, apiKeyId, encryptedKey }) {
    return this.prisma.digitalEmployee.update({
      where: { id },
      data: { hivemindApiKeyId: apiKeyId, scopedApiKeyEncrypted: encryptedKey },
      select: PUBLIC_FIELDS,
    });
  }

  /**
   * Internal helper for the bootstrap endpoint. Returns rows WITH the
   * encrypted key so the caller can decrypt server-side and ship to the
   * sidecar over the internal docker network. Never expose this via UI.
   */
  async listForBootstrap({ orgId = null }) {
    const where = { archivedAt: null, status: { in: ['running', 'deploying'] } };
    if (orgId) where.orgId = orgId;
    return this.prisma.digitalEmployee.findMany({
      where,
      select: {
        ...PUBLIC_FIELDS,
        scopedApiKeyEncrypted: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  // Bump metrics — called by Python sidecar after each LLM call
  async incrementMetrics({ id, tokens = 0, messages = 0, errors = 0 }) {
    const emp = await this.prisma.digitalEmployee.findUnique({
      where: { id },
      select: { metricsLast24h: true },
    });
    if (!emp) return null;
    const m = emp.metricsLast24h || {};
    const next = {
      ...m,
      tokens: (m.tokens || 0) + tokens,
      messages: (m.messages || 0) + messages,
      errors: (m.errors || 0) + errors,
      updated_at: new Date().toISOString(),
    };
    return this.prisma.digitalEmployee.update({
      where: { id },
      data: { metricsLast24h: next, lastActiveAt: new Date() },
      select: { id: true, metricsLast24h: true },
    });
  }
}

export function publicEmployeeFields() {
  return PUBLIC_FIELDS;
}
