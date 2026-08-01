import { chatCompletionFetch, DEFAULT_CHAT_SYNTHESIS_MODEL } from '../llm/chat-provider.js';

const providerAliases = {
  gmail: ['gmail', 'google-mail'],
  'google-maps': ['google-maps'],
  linkedin: ['linkedin'],
  instagram: ['instagram'],
  x: ['x', 'twitter'],
};

// Vocabularies the semantic classifier is held to. A model returning free prose
// for either of these breaks a downstream identifier lookup, not just a label.
const KNOWN_SKILLS = new Set([
  'baseline-establishment', 'blocker-resolution', 'company-state-diagnosis',
  'evidence-sufficiency', 'growth-constraint-diagnosis', 'growth-stage-planning',
  'memory-promotion', 'performance-diagnostics', 'primary-outreach',
  'specialist-delegation', 'stage-review', 'work-order-delegation',
]);

const PLATFORM_MANAGED_CAPABILITIES = {
  'google-maps': () => Boolean(process.env.GOOGLE_MAPS_API_KEY || process.env.HYPER_PLACES_KEY),
};

export function normalizePrepareCapabilities(capabilities, kind = '') {
  const aliases = new Map([
    ['google-maps', 'google-maps'], ['google_maps', 'google-maps'], ['maps', 'google-maps'],
    ['gmail', 'gmail'], ['google-mail', 'gmail'],
  ]);
  return [...new Set((Array.isArray(capabilities) ? capabilities : [])
    .map((value) => aliases.get(String(value || '').trim().toLowerCase()))
    .filter(Boolean))];
}

export function getPlatformManagedCapabilities() {
  return new Set(Object.entries(PLATFORM_MANAGED_CAPABILITIES)
    .filter(([, available]) => available())
    .map(([capability]) => capability));
}

function cleanLocation(value) {
  return String(value || '').trim().replace(/[.,;!?]+$/, '').slice(0, 160);
}

export function interpretHqInstruction(body, company = {}) {
  const text = String(body || '').trim();
  const location = cleanLocation(company.location || company.city || company.profile?.location || '');
  const base = {
    intent: 'operating_instruction',
    location: location || null,
    required_capabilities: [],
    title: 'Apply the new operating instruction',
    objective: location ? `${text}\nUse the retained company location: ${location}.` : text,
    skill: 'specialist-delegation',
    room_tag: 'general',
    target: { location: location || null, quantity: null, sector: null, audience: null },
    acceptance_criteria: ['Reach a terminal playbook state with every expected artifact accepted by its declared predicates.'],
  };
  return { ...base, work_units: [{
    title: base.title, objective: base.objective, room_tag: base.room_tag,
    kind: base.intent, skill: base.skill,
    required_capabilities: base.required_capabilities, target: base.target,
    acceptance_criteria: base.acceptance_criteria,
    completion_requirements: [],
    authority_mode: 'PREPARE', depends_on: null,
  }] };
}

const ROOM_TAGS = new Set(['general', 'outreach', 'seo', 'marketing', 'campaign', 'branding', 'research', 'product', 'fundraising', 'legal_finance']);
const REQUIREMENT_TYPES = new Set([
  'records_persisted', 'source_evidence', 'distinct_fields', 'evidence_refs',
  'deliverables', 'email_drafts', 'external_actions', 'delivery_receipts',
]);

function normalizeRequirement(row) {
  if (!row || typeof row !== 'object') return null;
  const type = String(row.type || '').trim().toLowerCase();
  if (!REQUIREMENT_TYPES.has(type)) return null;
  const requirement = { type };
  if (Number.isFinite(Number(row.minimum))) requirement.minimum = Math.max(0, Math.min(50, Number(row.minimum)));
  if (Number.isFinite(Number(row.maximum))) requirement.maximum = Math.max(0, Math.min(50, Number(row.maximum)));
  if (row.entity) requirement.entity = String(row.entity).slice(0, 60);
  if (Array.isArray(row.fields)) requirement.fields = row.fields.map(String).slice(0, 8);
  return requirement;
}

function defaultRequirements(unit, target) {
  return [];
}

export function normalizeInstructionWorkUnits(parsed, fallback) {
  const source = Array.isArray(parsed?.work_units) && parsed.work_units.length ? parsed.work_units : fallback.work_units;
  const units = source.slice(0, 1).map((raw) => {
    const roomTag = ROOM_TAGS.has(String(raw?.room_tag || '').toLowerCase())
      ? String(raw.room_tag).toLowerCase() : fallback.room_tag;
    const target = { ...(fallback.target || {}), ...(raw?.target && typeof raw.target === 'object' ? raw.target : {}) };
    const quantity = Number(target.quantity);
    target.quantity = Number.isFinite(quantity) && quantity > 0 ? Math.min(50, Math.floor(quantity)) : null;
    const authorityMode = String(raw?.authority_mode || 'PREPARE').toUpperCase() === 'EXECUTE' ? 'EXECUTE' : 'PREPARE';
    const provisional = {
      title: String(raw?.title || fallback.title).slice(0, 240),
      objective: String(raw?.objective || fallback.objective).slice(0, 5000),
      room_tag: roomTag,
      kind: String(raw?.kind || fallback.intent).slice(0, 60).toLowerCase(),
      skill: KNOWN_SKILLS.has(String(raw?.skill || '').toLowerCase()) ? String(raw.skill).toLowerCase()
        : fallback.skill,
      target,
      authority_mode: authorityMode,
      depends_on: null,
      required_capabilities: [],
      acceptance_criteria: Array.isArray(raw?.acceptance_criteria) && raw.acceptance_criteria.length
        ? raw.acceptance_criteria.map(String).slice(0, 10) : fallback.acceptance_criteria,
    };
    const requirements = Array.isArray(raw?.completion_requirements)
      ? raw.completion_requirements.map(normalizeRequirement).filter(Boolean) : [];
    provisional.completion_requirements = requirements.length ? requirements : defaultRequirements(provisional, target);
    return provisional;
  });
  return units.length ? units : fallback.work_units;
}

// Route through the canonical chat provider (Cerebras primary → OpenRouter
// failover), NOT a hardcoded provider endpoint. If classification is unavailable,
// the fallback preserves one complete objective without making a semantic routing
// decision; the playbook Director remains the only lifecycle selector.
export async function interpretHqInstructionSemantic(body, company = {}) {
  const fallback = interpretHqInstruction(body, company);
  const text = String(body || '').trim();
  if (!text) return fallback;
  try {
    const response = await chatCompletionFetch(process.env.HQ_DISPATCH_MODEL || DEFAULT_CHAT_SYNTHESIS_MODEL, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        temperature: 0,
        response_format: { type: 'json_object' }, max_completion_tokens: 1400,
        messages: [
          { role: 'system', content: 'Interpret one company operating instruction by meaning in any language without decomposing its domain lifecycle. Return JSON only with intent, title, objective, room_tag, skill, location, target:{quantity,sector,audience}, required_capabilities, acceptance_criteria, and exactly one work_units item preserving the complete requested outcome. The Director-selected versioned playbook owns all stages, dependencies, artifacts, connectors, and authority gates. room_tag must be one of general,outreach,seo,marketing,campaign,branding,research,product,fundraising,legal_finance. Preserve exact audience, geography, quantity, timing, and external-action restrictions. If quantity was not specified, use null; do not invent one.' },
          { role: 'user', content: JSON.stringify({ instruction: String(body || '').slice(0, 5000), company }) },
        ],
      }),
    });
    if (!response.ok) return fallback;
    const payload = await response.json();
    const parsed = JSON.parse(String(payload?.choices?.[0]?.message?.content || '{}'));
    if (!ROOM_TAGS.has(String(parsed.room_tag || '').toLowerCase())) return fallback;
    const skillId = String(parsed.skill || '').toLowerCase().trim();
    const roomTag = String(parsed.room_tag).toLowerCase();
    const parsedTarget = parsed.target && typeof parsed.target === 'object' ? parsed.target : {};
    const explicitQuantity = Number(parsedTarget.quantity);
    const skill = KNOWN_SKILLS.has(skillId) ? skillId : fallback.skill;
    const interpreted = {
      intent: String(parsed.intent || parsed.room_tag || fallback.intent).slice(0, 60),
      title: String(parsed.title || fallback.title).slice(0, 240),
      objective: String(parsed.objective || body || fallback.objective).slice(0, 5000),
      room_tag: roomTag, skill,
      location: cleanLocation(parsed.location || fallback.location || '') || null,
      target: {
        location: cleanLocation(parsed.location || fallback.location || '') || null,
        quantity: Number.isFinite(explicitQuantity) && explicitQuantity > 0 ? Math.min(50, Math.floor(explicitQuantity)) : null,
        sector: parsedTarget.sector ? String(parsedTarget.sector).slice(0, 240) : null,
        audience: parsedTarget.audience ? String(parsedTarget.audience).slice(0, 240) : null,
      },
      required_capabilities: [],
      acceptance_criteria: Array.isArray(parsed.acceptance_criteria) && parsed.acceptance_criteria.length
        ? parsed.acceptance_criteria.map(String).slice(0, 12) : fallback.acceptance_criteria,
    };
    interpreted.work_units = normalizeInstructionWorkUnits(parsed, { ...fallback, ...interpreted });
    return interpreted;
  } catch {
    return fallback;
  }
}

export function canonicalInstructionKind(interpreted = {}) {
  return String(interpreted.intent || 'operating_focus').trim().toLowerCase();
}

export function shouldDeferInstruction({ deferTodos = false, instruction = {} } = {}) {
  return Boolean(deferTodos && instruction?.interpreted?.execution_mode !== 'single_outcome');
}

export async function ingestPendingInstructions({ prisma, runtime, company, deferTodos = false }) {
  const pending = await prisma.hqInstruction.findMany({
    where: { runtimeId: runtime.id, orgId: runtime.orgId, status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 20,
  });
  const created = [];
  for (const instruction of pending) {
    const interpreted = await interpretHqInstructionSemantic(instruction.body, company);
    const executionMode = instruction.interpreted?.execution_mode === 'single_outcome'
      ? 'single_outcome' : 'operating_plan';
    if (shouldDeferInstruction({ deferTodos, instruction })) {
      await prisma.hqInstruction.update({ where: { id: instruction.id }, data: {
        status: 'APPLIED', interpreted: { ...interpreted, execution_mode: executionMode, incorporated_into_initial_plan: true }, appliedAt: new Date(),
      } });
      created.push({ instruction, interpreted, todo: null });
      continue;
    }
    const todos = await prisma.$transaction(async (tx) => {
      // Direct owner instructions preempt autonomous plan work. They still pass
      // through the same capability and governance gates, but they must be the
      // first executable item considered on the next wake.
      const units = normalizeInstructionWorkUnits(interpreted, interpretHqInstruction(instruction.body, company));
      const rows = [];
      for (let index = 0; index < units.length; index += 1) {
        const unit = units[index];
        const dependency = Number.isInteger(unit.depends_on) ? rows[unit.depends_on] : null;
        const row = await tx.hqTodo.create({ data: {
          runtimeId: runtime.id, orgId: runtime.orgId, instructionId: instruction.id,
          title: unit.title, objective: unit.objective, kind: unit.kind || canonicalInstructionKind(unit),
          status: dependency ? 'WAITING_FOR_DEPENDENCY' : 'READY',
          priority: -100 + index, position: index,
          requiredCapabilities: unit.required_capabilities,
          context: { location: unit.target?.location || interpreted.location, target: unit.target,
            skill: unit.skill, room_tag: unit.room_tag, acceptance_criteria: unit.acceptance_criteria,
            completion_requirements: unit.completion_requirements, authority_mode: unit.authority_mode,
            workflow_index: index, workflow_size: units.length, depends_on_todo_id: dependency?.id || null },
        } });
        rows.push(row);
      }
      await tx.hqInstruction.update({ where: { id: instruction.id }, data: {
        status: 'APPLIED', interpreted: {
          ...interpreted,
          execution_mode: executionMode,
          work_units: units,
          workflow_todo_ids: rows.map((row) => row.id),
        }, appliedAt: new Date(),
      } });
      return rows;
    });
    created.push({ instruction, interpreted, todo: todos[0] || null, todos });
  }
  return created;
}

export async function getConnectedCapabilities({ prisma, runtime }) {
  const [nango, platform, zernio] = await Promise.all([
    prisma.nangoConnection.findMany({ where: { orgId: runtime.orgId, status: 'active' }, select: { providerKey: true } }).catch(() => []),
    prisma.platformIntegration.findMany({ where: { userId: runtime.ownerUserId, isActive: true }, select: { platformType: true } }).catch(() => []),
    prisma.zernioOrgProfile.findUnique({ where: { orgId: runtime.orgId }, select: { connectedAccounts: true } }).catch(() => null),
  ]);
  const raw = new Set([
    ...nango.map((row) => row.providerKey),
    ...platform.map((row) => row.platformType),
    ...(Array.isArray(zernio?.connectedAccounts) ? zernio.connectedAccounts.map((row) => row.platform || row.provider) : []),
  ].filter(Boolean).map((value) => String(value).toLowerCase()));
  const platformManaged = getPlatformManagedCapabilities();
  const connected = new Set([...raw, ...platformManaged]);
  for (const [canonical, aliases] of Object.entries(providerAliases)) if (aliases.some((alias) => raw.has(alias))) connected.add(canonical);
  return connected;
}

export async function reconcileTodoCapabilities({ prisma, runtime }) {
  const connected = await getConnectedCapabilities({ prisma, runtime });
  const platformManaged = getPlatformManagedCapabilities();
  const todos = await prisma.hqTodo.findMany({
    where: { runtimeId: runtime.id, orgId: runtime.orgId, status: { in: ['READY', 'WAITING_FOR_CONNECTOR'] } },
    orderBy: [{ priority: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }], take: 30,
  });
  const resolved = [];
  for (const todo of todos) {
    const original = Array.isArray(todo.requiredCapabilities) ? todo.requiredCapabilities : [];
    const required = normalizePrepareCapabilities(original, todo.kind);
    const capabilitiesChanged = JSON.stringify(original) !== JSON.stringify(required);
    if (capabilitiesChanged) {
      await prisma.$transaction([
        prisma.hqTodo.update({ where: { id: todo.id }, data: {
          requiredCapabilities: required,
          context: { ...(todo.context || {}), ignored_capability_suggestions: original.filter((item) => !required.includes(String(item || '').toLowerCase())) },
        } }),
        prisma.hqCapabilityRequest.updateMany({
          where: { runtimeId: runtime.id, todoId: todo.id, status: 'REQUIRED', capability: { notIn: required } },
          data: { status: 'RESOLVED', resolvedAt: new Date() },
        }),
      ]);
    }
    const missing = required.filter((item) => !connected.has(String(item).toLowerCase()));
    if (missing.length) {
      await prisma.hqTodo.update({ where: { id: todo.id }, data: { status: 'WAITING_FOR_CONNECTOR', blockedReason: `Missing: ${missing.join(', ')}` } });
      for (const capability of missing) {
        const exists = await prisma.hqCapabilityRequest.findFirst({ where: { runtimeId: runtime.id, todoId: todo.id, capability, status: 'REQUIRED' } });
        if (!exists) await prisma.hqCapabilityRequest.create({ data: {
          runtimeId: runtime.id, orgId: runtime.orgId, todoId: todo.id, capability, provider: capability,
          reason: `${todo.title} requires ${capability} before HQ can continue.`,
          connectPath: `/hivemind/app/connectors?connect=${encodeURIComponent(capability)}`,
        } });
      }
    } else if (todo.status === 'WAITING_FOR_CONNECTOR') {
      await prisma.$transaction([
        prisma.hqTodo.update({ where: { id: todo.id }, data: { status: 'READY', blockedReason: null } }),
        prisma.hqCapabilityRequest.updateMany({ where: { runtimeId: runtime.id, todoId: todo.id, status: 'REQUIRED' }, data: { status: 'RESOLVED', resolvedAt: new Date() } }),
      ]);
      resolved.push({ todo_id: todo.id, capabilities: required, platform_managed: required.filter((capability) => platformManaged.has(String(capability).toLowerCase())), ignored_capabilities: capabilitiesChanged ? original.filter((item) => !required.includes(String(item || '').toLowerCase())) : [] });
    }
  }
  return {
    connected: [...connected],
    platform_managed: [...platformManaged],
    todos: await prisma.hqTodo.findMany({ where: { runtimeId: runtime.id, orgId: runtime.orgId, status: { notIn: ['CANCELLED'] } }, orderBy: [{ priority: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }], take: 50 }),
    requests: await prisma.hqCapabilityRequest.findMany({ where: { runtimeId: runtime.id, orgId: runtime.orgId, status: 'REQUIRED' }, orderBy: { createdAt: 'asc' }, take: 20 }),
    resolved,
  };
}
