import crypto from 'node:crypto';
import { chatCompletionFetch, DEFAULT_HQ_DISPATCH_MODEL } from '../llm/chat-provider.js';
import {
  getHyperagentsRuntimeConnectorProvider,
  listRuntimeConnectedCapabilities,
  runtimeConnectorConnectPath,
} from '../connectors/runtime-provider-policy.js';

const providerAliases = {
  gmail: ['gmail', 'google-mail'],
  'google-docs': ['google-docs', 'google_docs', 'googledocs'],
  'google-drive': ['google-drive', 'google_drive', 'googledrive'],
  notion: ['notion'],
  github: ['github'],
  linear: ['linear'],
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

function normalizeRuntimeCapabilities(capabilities) {
  const aliases = new Map([
    ['google-maps', 'google-maps'], ['google_maps', 'google-maps'], ['maps', 'google-maps'],
    ['gmail', 'gmail'], ['google-mail', 'gmail'],
    ['x', 'x'], ['twitter', 'x'], ['x_organic', 'x'],
    ['linkedin', 'linkedin'], ['linkedin_ads', 'linkedin'],
    ['instagram', 'instagram'],
    ['facebook', 'facebook'], ['meta', 'facebook'],
    ['tiktok', 'tiktok'], ['youtube', 'youtube'], ['pinterest', 'pinterest'],
    ['reddit', 'reddit'], ['threads', 'threads'], ['bluesky', 'bluesky'],
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
  const exactTargets = [];
  const seenTargets = new Set();
  const retainTarget = (type, value) => {
    const normalized = String(value || '').trim();
    if (!normalized || seenTargets.has(`${type}:${normalized}`)) return;
    seenTargets.add(`${type}:${normalized}`);
    exactTargets.push({ type, value: normalized });
  };
  for (const match of text.matchAll(/\+[1-9][\d\s()/-]{6,20}/g)) {
    const phone = String(match[0]).replace(/[\s()/-]/g, '');
    if (/^\+[1-9]\d{6,14}$/.test(phone)) retainTarget('phone', phone);
  }
  for (const match of text.matchAll(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g)) retainTarget('email', match[0]);
  for (const match of text.matchAll(/https?:\/\/[^\s<>()]+/gi)) retainTarget('url', match[0].replace(/[.,;!?]+$/, ''));
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
    source_instruction: text,
    requested_action: 'complete_requested_outcome',
    requested_terminal_outcome: 'completed_as_requested',
    external_action_requested: false,
    exact_targets: exactTargets,
    execution_mode: 'single_outcome',
  };
  return { ...base, work_units: [{
    title: base.title, objective: base.objective, room_tag: base.room_tag,
    kind: base.intent, skill: base.skill,
    required_capabilities: base.required_capabilities, target: base.target,
      acceptance_criteria: base.acceptance_criteria,
      completion_requirements: [],
      authority_mode: 'PREPARE', depends_on: null,
      source_instruction: base.source_instruction,
      requested_action: base.requested_action,
      requested_terminal_outcome: base.requested_terminal_outcome,
      external_action_requested: base.external_action_requested,
      exact_targets: base.exact_targets,
    }] };
}

export function normalizeInstructionWorkUnits(parsed, fallback, availableRoomTags = []) {
  const allowedRooms = new Set([...availableRoomTags, fallback.room_tag, 'general'].map((value) => String(value || '').toLowerCase()));
  const source = Array.isArray(parsed?.work_units) && parsed.work_units.length ? parsed.work_units : fallback.work_units;
  const units = source.slice(0, 1).map((raw) => {
    const roomTag = allowedRooms.has(String(raw?.room_tag || '').toLowerCase())
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
      skill: fallback.skill,
      target,
      authority_mode: authorityMode,
      depends_on: null,
      required_capabilities: [],
      acceptance_criteria: Array.isArray(raw?.acceptance_criteria) && raw.acceptance_criteria.length
        ? raw.acceptance_criteria.map(String).slice(0, 10) : fallback.acceptance_criteria,
      source_instruction: String(raw?.source_instruction || fallback.source_instruction || fallback.objective).slice(0, 5000),
      requested_action: String(raw?.requested_action || fallback.requested_action || 'complete_requested_outcome').slice(0, 120),
      requested_terminal_outcome: String(raw?.requested_terminal_outcome || fallback.requested_terminal_outcome || 'completed_as_requested').slice(0, 120),
      external_action_requested: raw?.external_action_requested === true,
      exact_targets: Array.isArray(raw?.exact_targets) ? raw.exact_targets.slice(0, 50).map((targetRow) => ({
        type: String(targetRow?.type || 'entity').slice(0, 80),
        value: String(targetRow?.value || '').slice(0, 1000),
        ...(targetRow?.label ? { label: String(targetRow.label).slice(0, 240) } : {}),
      })).filter((targetRow) => targetRow.value) : [],
    };
    provisional.completion_requirements = [];
    return provisional;
  });
  return units.length ? units : fallback.work_units;
}

// Route through the canonical chat provider (Cerebras primary → OpenRouter
// failover), NOT a hardcoded provider endpoint. If classification is unavailable,
// the fallback preserves one complete objective without making a semantic routing
// decision; the playbook Director remains the only lifecycle selector.
export async function interpretHqInstructionSemantic(body, company = {}, availableRooms = []) {
  const fallback = interpretHqInstruction(body, company);
  const text = String(body || '').trim();
  if (!text) return fallback;
  try {
    const response = await chatCompletionFetch(process.env.HQ_DISPATCH_MODEL || DEFAULT_HQ_DISPATCH_MODEL, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        temperature: 0,
        reasoning: { enabled: false, exclude: true },
        response_format: { type: 'json_object' }, max_completion_tokens: 1400,
        messages: [
          { role: 'system', content: 'Interpret one company operating instruction by meaning in any language without decomposing its lifecycle. Return JSON only with intent, title, objective, room_tag, location, target:{quantity,sector,audience}, acceptance_criteria, source_instruction, requested_action, requested_terminal_outcome, external_action_requested, exact_targets:[{type,value,label}], execution_mode, and exactly one work_units item preserving those same request fields. Copy source_instruction verbatim. Preserve every explicit recipient, phone number, account, URL, geography, audience, quantity, timing, and external-action restriction in exact_targets and objective. Select room_tag semantically from available_rooms. The Director-selected versioned playbook owns all stages, dependencies, artifacts, connectors, skills, and authority gates. If geography was not explicitly stated, use the supplied retained company location and do not infer a broader market from the company profile. If quantity was not specified, use null; do not invent one. Set external_action_requested when the requested terminal outcome requires an external action. Set execution_mode to single_outcome only for one bounded requested result; use operating_plan for broad preferences or multi-area focus that should shape the initial company plan.' },
          { role: 'user', content: JSON.stringify({ instruction: String(body || '').slice(0, 5000), company, available_rooms: availableRooms }) },
        ],
      }),
    });
    if (!response.ok) return fallback;
    const payload = await response.json();
    const parsed = JSON.parse(String(payload?.choices?.[0]?.message?.content || '{}'));
    const allowedRooms = new Set([...availableRooms, 'general'].map((value) => String(value || '').toLowerCase()));
    if (!allowedRooms.has(String(parsed.room_tag || '').toLowerCase())) return fallback;
    const roomTag = String(parsed.room_tag).toLowerCase();
    const parsedTarget = parsed.target && typeof parsed.target === 'object' ? parsed.target : {};
    const explicitQuantity = Number(parsedTarget.quantity);
    const skill = fallback.skill;
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
      source_instruction: text,
      requested_action: String(parsed.requested_action || fallback.requested_action).slice(0, 120),
      requested_terminal_outcome: String(parsed.requested_terminal_outcome || fallback.requested_terminal_outcome).slice(0, 120),
      external_action_requested: parsed.external_action_requested === true,
      exact_targets: Array.isArray(parsed.exact_targets) ? parsed.exact_targets.slice(0, 50).map((targetRow) => ({
        type: String(targetRow?.type || 'entity').slice(0, 80),
        value: String(targetRow?.value || '').slice(0, 1000),
        ...(targetRow?.label ? { label: String(targetRow.label).slice(0, 240) } : {}),
      })).filter((targetRow) => targetRow.value) : [],
      execution_mode: parsed.execution_mode === 'operating_plan' ? 'operating_plan' : 'single_outcome',
    };
    interpreted.work_units = normalizeInstructionWorkUnits(parsed, { ...fallback, ...interpreted }, availableRooms);
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

export function resolveInstructionExecutionMode({ semantic = {}, persisted = {} } = {}) {
  if (persisted?.source === 'runtime_invitation' && persisted?.execution_mode === 'operating_plan') {
    return 'operating_plan';
  }
  return semantic?.execution_mode === 'operating_plan' ? 'operating_plan' : 'single_outcome';
}

export async function ingestPendingInstructions({ prisma, runtime, company, deferTodos = false, onProgress = null,
  interpretInstruction = interpretHqInstructionSemantic }) {
  const [pending, roomRows] = await Promise.all([
    prisma.hqInstruction.findMany({
      where: { runtimeId: runtime.id, orgId: runtime.orgId, status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 20,
    }),
    prisma.hyperRoom.findMany({
      where: { orgId: runtime.orgId, archivedAt: null }, select: { roomTag: true },
    }),
  ]);
  const availableRooms = [...new Set(roomRows.map((room) => room.roomTag).filter(Boolean))];
  const created = [];
  for (const instruction of pending) {
    if (onProgress) await onProgress({
      stage: 'interpreting',
      instructionId: instruction.id,
      createdAt: instruction.createdAt,
    });
    const semantic = await interpretInstruction(instruction.body, company, availableRooms);
    const persisted = instruction.interpreted && typeof instruction.interpreted === 'object' ? instruction.interpreted : {};
    const executionMode = resolveInstructionExecutionMode({ semantic, persisted });
    const interpreted = {
      ...semantic,
      execution_mode: executionMode,
      source_attribution: persisted.source || null,
      planning_focus_refs: Array.isArray(persisted.focuses) ? persisted.focuses : [],
    };
    if (shouldDeferInstruction({ deferTodos, instruction: { interpreted } })) {
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
      const units = normalizeInstructionWorkUnits(interpreted, interpretHqInstruction(instruction.body, company), availableRooms);
      const rows = [];
      for (let index = 0; index < units.length; index += 1) {
        const unit = units[index];
        const dependency = Number.isInteger(unit.depends_on) ? rows[unit.depends_on] : null;
        const row = await tx.hqTodo.create({ data: {
          runtimeId: runtime.id, orgId: runtime.orgId, instructionId: instruction.id,
          title: unit.title, objective: unit.objective, kind: unit.kind || canonicalInstructionKind(unit),
          status: dependency ? 'WAITING_FOR_DEPENDENCY' : 'PROPOSED',
          priority: -100 + index, position: index,
          requiredCapabilities: unit.required_capabilities,
          context: { location: unit.target?.location || interpreted.location, target: unit.target,
            skill: unit.skill, room_tag: unit.room_tag, acceptance_criteria: unit.acceptance_criteria,
            completion_requirements: unit.completion_requirements, authority_mode: unit.authority_mode,
            source_instruction: unit.source_instruction || interpreted.source_instruction || instruction.body,
            requested_action: unit.requested_action || interpreted.requested_action,
            requested_terminal_outcome: unit.requested_terminal_outcome || interpreted.requested_terminal_outcome,
            external_action_requested: unit.external_action_requested === true || interpreted.external_action_requested === true,
            exact_targets: unit.exact_targets?.length ? unit.exact_targets : interpreted.exact_targets || [],
            execution_mode: executionMode, workflow_index: index, workflow_size: units.length,
            proposal_origin: 'user_instruction',
            effect_class: unit.external_action_requested === true || interpreted.external_action_requested === true ? 'external' : 'internal',
            depends_on_todo_id: dependency?.id || null },
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
  const connectorProvider = getHyperagentsRuntimeConnectorProvider();
  const [runtimeConnectors, platform, zernio] = await Promise.all([
    listRuntimeConnectedCapabilities({ prisma, orgId: runtime.orgId, userId: runtime.ownerUserId, provider: connectorProvider }),
    prisma.platformIntegration.findMany({ where: { userId: runtime.ownerUserId, isActive: true }, select: { platformType: true } }).catch(() => []),
    prisma.zernioOrgProfile.findUnique({ where: { orgId: runtime.orgId }, select: { connectedAccounts: true } }).catch(() => null),
  ]);
  const raw = new Set([
    ...runtimeConnectors,
    ...platform.map((row) => row.platformType),
    ...(Array.isArray(zernio?.connectedAccounts) ? zernio.connectedAccounts.map((row) => row.platform || row.provider) : []),
  ].filter(Boolean).map((value) => String(value).toLowerCase()));
  const platformManaged = getPlatformManagedCapabilities();
  const connected = new Set([...raw, ...platformManaged]);
  for (const [canonical, aliases] of Object.entries(providerAliases)) if (aliases.some((alias) => raw.has(alias))) connected.add(canonical);
  return connected;
}

export async function reconcileTodoCapabilities({ prisma, runtime }) {
  const connectorProvider = getHyperagentsRuntimeConnectorProvider();
  const connected = await getConnectedCapabilities({ prisma, runtime });
  const platformManaged = getPlatformManagedCapabilities();
  const todos = await prisma.hqTodo.findMany({
    where: { runtimeId: runtime.id, orgId: runtime.orgId, status: { in: ['READY', 'WAITING_FOR_CONNECTOR'] } },
    orderBy: [{ priority: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }], take: 30,
  });
  const resolved = [];
  const changes = [];
  for (const todo of todos) {
    const original = Array.isArray(todo.requiredCapabilities) ? todo.requiredCapabilities : [];
    const runtimeRequired = normalizeRuntimeCapabilities(todo.context?.runtime_required_capabilities);
    const required = [...new Set([...normalizePrepareCapabilities(original, todo.kind), ...runtimeRequired])];
    const capabilitiesChanged = JSON.stringify(original) !== JSON.stringify(required);
    if (capabilitiesChanged) {
      changes.push(`requirements:${todo.id}`);
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
      if (todo.status !== 'WAITING_FOR_CONNECTOR' || todo.blockedReason !== `Missing: ${missing.join(', ')}`) {
        await prisma.hqTodo.update({ where: { id: todo.id }, data: { status: 'WAITING_FOR_CONNECTOR', blockedReason: `Missing: ${missing.join(', ')}` } });
        changes.push(`waiting:${todo.id}:${missing.join(',')}`);
      }
      for (const capability of missing) {
        const exists = await prisma.hqCapabilityRequest.findFirst({ where: { runtimeId: runtime.id, todoId: todo.id, capability, status: 'REQUIRED' } });
        if (!exists) {
          await prisma.hqCapabilityRequest.create({ data: {
            runtimeId: runtime.id, orgId: runtime.orgId, todoId: todo.id, capability, provider: connectorProvider,
            reason: `${todo.title} requires ${capability} before HQ can continue.`,
            connectPath: runtimeConnectorConnectPath(capability),
            correlationRef: `capability:${todo.id}:${capability}`,
            resumeCondition: { type: 'capability.connected', capability, todo_id: todo.id },
            stateFingerprint: crypto.createHash('sha256').update(`${runtime.id}:${todo.id}:${capability}:${connectorProvider}`).digest('hex'),
          } });
          changes.push(`request:${todo.id}:${capability}`);
        }
      }
    } else if (todo.status === 'WAITING_FOR_CONNECTOR') {
      await prisma.$transaction([
        prisma.hqTodo.update({ where: { id: todo.id }, data: { status: 'READY', blockedReason: null } }),
        prisma.hqCapabilityRequest.updateMany({ where: { runtimeId: runtime.id, todoId: todo.id, status: 'REQUIRED' }, data: { status: 'RESOLVED', resolvedAt: new Date() } }),
      ]);
      changes.push(`resolved:${todo.id}`);
      resolved.push({ todo_id: todo.id, capabilities: required, platform_managed: required.filter((capability) => platformManaged.has(String(capability).toLowerCase())), ignored_capabilities: capabilitiesChanged ? original.filter((item) => !required.includes(String(item || '').toLowerCase())) : [] });
    }
  }
  const stateFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    connected: [...connected].sort(),
    changes: [...changes].sort(),
  })).digest('hex');
  return {
    connected: [...connected],
    platform_managed: [...platformManaged],
    todos: await prisma.hqTodo.findMany({ where: { runtimeId: runtime.id, orgId: runtime.orgId, status: { notIn: ['CANCELLED'] } }, orderBy: [{ priority: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }], take: 50 }),
    requests: await prisma.hqCapabilityRequest.findMany({ where: { runtimeId: runtime.id, orgId: runtime.orgId, status: 'REQUIRED' }, orderBy: { createdAt: 'asc' }, take: 20 }),
    resolved,
    changed: changes.length > 0,
    stateFingerprint,
  };
}
