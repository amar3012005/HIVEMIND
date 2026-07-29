export const DOMAIN_ROOM_DEFINITIONS = Object.freeze([
  { key: 'general', name: 'Company HQ', purpose: 'Coordinate cross-functional company work and choose the highest-leverage next move.' },
  { key: 'seo', name: 'SEO', purpose: 'Turn search demand and website evidence into measurable organic growth.' },
  { key: 'marketing', name: 'Marketing', purpose: 'Build audience, channel, campaign, and experiment systems grounded in the company offer.' },
  { key: 'campaign', name: 'Campaign Intelligence', purpose: 'Turn company truth into debated, channel-ready campaigns with explicit launch approval and measurement.' },
  { key: 'branding', name: 'Branding', purpose: 'Strengthen positioning, narrative, voice, and market-facing consistency.' },
  { key: 'fundraising', name: 'Fundraising', purpose: 'Prepare the investor narrative, evidence, target fit, materials, and process.' },
  { key: 'research', name: 'Research', purpose: 'Produce source-backed findings, challenge assumptions, and turn evidence into decisions.' },
  { key: 'product', name: 'Product', purpose: 'Translate customer problems into priorities, requirements, experiments, and delivery.' },
  { key: 'design', name: 'Design', purpose: 'Shape clear user journeys, interaction systems, states, and validation plans.' },
  { key: 'legal_finance', name: 'Legal & Finance', purpose: 'Analyze obligations, exposure, economics, controls, and review gates.' },
]);

/**
 * Provision the permanent domain homes for one organization. These are product
 * navigation, not user-created task rooms, so callers deliberately bypass the
 * commercial room allowance. The advisory lock makes retries and concurrent
 * onboarding/page-load calls idempotent.
 */
export async function ensureDomainRooms({ prisma, orgId, userId, participantIds = [], company = null }) {
  if (!prisma || !orgId || !userId) return [];
  const normalizedParticipants = Array.from(new Set(participantIds.filter(Boolean))).slice(0, 5);
  const companyName = String(company?.company || company?.name || '').trim();
  const mission = String(company?.mission || '').trim();

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `domain-rooms:${orgId}`);
    const existing = await tx.$queryRawUnsafe(
      `SELECT id, room_tag
         FROM "hivemind"."hyper_rooms"
        WHERE org_id = $1::uuid
          AND archived_at IS NULL
          AND agent_connectors->>'_domain_home' = 'true'`,
      orgId,
    );
    const existingByTag = new Map((existing || []).map((row) => [row.room_tag, row.id]));
    const rooms = [];

    for (const definition of DOMAIN_ROOM_DEFINITIONS) {
      const roomName = definition.key === 'general'
        ? `${companyName || 'Company'} HQ`.slice(0, 120)
        : definition.name;
      const existingId = existingByTag.get(definition.key);
      if (existingId) {
        if (definition.key === 'general') {
          await tx.hyperRoom.update({ where: { id: existingId }, data: { name: roomName } });
        }
        rooms.push({ id: existingId, room_tag: definition.key, created: false });
        continue;
      }
      const operatingContext = String(company?.company_context || '').trim();
      const companyContext = companyName
        ? ` You are operating ${companyName}${mission ? `, whose mission is: ${mission}` : ''}.${operatingContext ? `\nCOMPANY OPERATING CONTEXT:\n${operatingContext}` : ''}`
        : '';
      const room = await tx.hyperRoom.create({
        data: {
          userId,
          orgId,
          name: roomName,
          goal: `${definition.purpose}${companyContext}`.slice(0, 2000),
          participantIds: normalizedParticipants,
          template: 'auto',
          roomTag: definition.key,
          permanentLeadId: normalizedParticipants.slice().sort()[0] || null,
          agentConnectors: { _domain_home: true, _domain_version: 1 },
        },
      });
      rooms.push({ id: room.id, room_tag: definition.key, created: true });
    }
    return rooms;
  }, { timeout: 15000 });
}

export async function countQuotaHyperRooms(prisma, orgId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
       FROM "hivemind"."hyper_rooms"
      WHERE org_id = $1::uuid
        AND archived_at IS NULL
        AND NOT (agent_connectors ? '_domain_home')`,
    orgId,
  );
  return Number(rows?.[0]?.count || 0);
}
