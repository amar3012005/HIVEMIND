import crypto from 'node:crypto';

const digest = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const text = (value, limit = 1600) => String(value || '').trim().slice(0, limit);

export async function loadGovernedConversationContext({ prisma, orgId, userId, conversationId, turns = 6 } = {}) {
  const bounded = Number.isInteger(turns) ? Math.max(0, Math.min(12, turns)) : 6;
  if (!bounded || !prisma?.durableChatTurn || !orgId || !userId || !conversationId) return [];
  const rows = await prisma.durableChatTurn.findMany({
    where: { orgId, userId, threadDigest: digest(conversationId), status: 'completed' },
    orderBy: { completedAt: 'desc' },
    take: bounded,
    select: { requestPayload: true, responsePayload: true, completedAt: true },
  });
  return rows.reverse().flatMap(row => {
    const request = row.requestPayload || {};
    const response = row.responsePayload || {};
    const receipts = (response.steps || []).slice(-8).map(step => ({
      kind: text(step.kind, 40), tool: text(step.slug || step.name, 120), status: text(step.status, 40), summary: text(step.summary, 240),
    }));
    return [
      { role: 'user', content: text(request.message, 2000), occurred_at: row.completedAt },
      { role: 'assistant', content: text(response.response, 2400), receipts, occurred_at: row.completedAt },
    ].filter(turn => turn.content);
  });
}
