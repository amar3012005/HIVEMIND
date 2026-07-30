const OUTREACH_RE = /\b(client|clients|lead|leads|prospect|prospects|outreach|sales|customer|customers)\b/i;

const providerAliases = {
  gmail: ['gmail', 'google-mail'],
  'google-maps': ['google-maps'],
  linkedin: ['linkedin'],
  instagram: ['instagram'],
  x: ['x', 'twitter'],
};

function cleanLocation(value) {
  return String(value || '').trim().replace(/[.,;!?]+$/, '').slice(0, 160);
}

export function interpretHqInstruction(body, company = {}) {
  const text = String(body || '').trim();
  const explicit = text.match(/\b(?:in|around|near|from)\s+([A-Z][\p{L}\p{M}' -]{1,80})/u)?.[1];
  const location = cleanLocation(explicit || company.location || company.city || company.profile?.location || '');
  const outreach = OUTREACH_RE.test(text);
  return {
    intent: outreach ? 'outreach_growth' : 'operating_focus',
    location: location || null,
    required_capabilities: outreach ? ['google-maps', 'gmail'] : [],
    title: outreach ? `Build qualified pipeline${location ? ` in ${location}` : ''}` : 'Apply the new operating instruction',
    objective: location && !explicit ? `${text}\nUse the retained company location: ${location}.` : text,
    skill: outreach ? 'primary-outreach' : 'company-state-diagnosis',
  };
}

export async function ingestPendingInstructions({ prisma, runtime, company }) {
  const pending = await prisma.hqInstruction.findMany({
    where: { runtimeId: runtime.id, orgId: runtime.orgId, status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 20,
  });
  const created = [];
  for (const instruction of pending) {
    const interpreted = interpretHqInstruction(instruction.body, company);
    const todo = await prisma.$transaction(async (tx) => {
      const row = await tx.hqTodo.create({ data: {
        runtimeId: runtime.id, orgId: runtime.orgId, instructionId: instruction.id,
        title: interpreted.title, objective: interpreted.objective, kind: interpreted.intent,
        priority: 20, position: 0, requiredCapabilities: interpreted.required_capabilities,
        context: { location: interpreted.location, skill: interpreted.skill },
      } });
      await tx.hqInstruction.update({ where: { id: instruction.id }, data: { status: 'APPLIED', interpreted, appliedAt: new Date() } });
      return row;
    });
    created.push({ instruction, interpreted, todo });
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
  const connected = new Set(raw);
  for (const [canonical, aliases] of Object.entries(providerAliases)) if (aliases.some((alias) => raw.has(alias))) connected.add(canonical);
  return connected;
}

export async function reconcileTodoCapabilities({ prisma, runtime }) {
  const connected = await getConnectedCapabilities({ prisma, runtime });
  const todos = await prisma.hqTodo.findMany({
    where: { runtimeId: runtime.id, orgId: runtime.orgId, status: { in: ['READY', 'WAITING_FOR_CONNECTOR'] } },
    orderBy: [{ priority: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }], take: 30,
  });
  const resolved = [];
  for (const todo of todos) {
    const required = Array.isArray(todo.requiredCapabilities) ? todo.requiredCapabilities : [];
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
      resolved.push({ todo_id: todo.id, capabilities: required });
    }
  }
  return {
    connected: [...connected],
    todos: await prisma.hqTodo.findMany({ where: { runtimeId: runtime.id, orgId: runtime.orgId, status: { notIn: ['CANCELLED'] } }, orderBy: [{ priority: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }], take: 50 }),
    requests: await prisma.hqCapabilityRequest.findMany({ where: { runtimeId: runtime.id, orgId: runtime.orgId, status: 'REQUIRED' }, orderBy: { createdAt: 'asc' }, take: 20 }),
    resolved,
  };
}
