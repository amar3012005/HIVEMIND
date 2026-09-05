import crypto from 'node:crypto';
import { projectGovernedEvidence } from './governed-evidence-projection.js';

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

/**
 * Recover structured evidence from earlier completed turns in this exact
 * tenant/user/conversation. AgentRun is the canonical receipt store. The
 * checkpoint fallback keeps turns created before structured receipt
 * persistence usable during a rolling migration.
 */
export async function loadGovernedConversationEvidence({
  prisma, checkpointer, orgId, userId, conversationId, turns = 4,
} = {}) {
  const bounded = Number.isInteger(turns) ? Math.max(0, Math.min(8, turns)) : 4;
  if (!bounded || !prisma?.durableChatTurn?.findMany || !prisma?.agentRun?.findMany || !orgId || !userId || !conversationId) return [];
  const turnRows = await prisma.durableChatTurn.findMany({
    where: { orgId, userId, threadDigest: digest(conversationId), status: 'completed' },
    orderBy: { completedAt: 'desc' }, take: bounded,
    select: { responsePayload: true, completedAt: true },
  });
  const runIds = [...new Set(turnRows.map(row => row.responsePayload?.execution?.run_id).filter(Boolean))];
  if (!runIds.length) return [];
  const runs = await prisma.agentRun.findMany({
    where: { id: { in: runIds }, orgId, userId },
    select: { id: true, scratch: true },
  });
  const byId = new Map(runs.map(run => [run.id, run]));
  const evidence = [];
  for (const turn of turnRows.reverse()) {
    const run = byId.get(turn.responsePayload?.execution?.run_id);
    if (!run) continue;
    let receipts = Array.isArray(run.scratch?.receipts) ? run.scratch.receipts : [];
    if (!receipts.some(row => row?.data != null) && checkpointer?.getTuple && run.scratch?.graph_thread_id) {
      const tuple = await checkpointer.getTuple({ configurable: { thread_id: run.scratch.graph_thread_id } }).catch(() => null);
      receipts = tuple?.checkpoint?.channel_values?.receipts || receipts;
    }
    for (const receipt of receipts.filter(row => row?.successful && row.data != null).slice(-4)) {
      evidence.push(projectGovernedEvidence({
        prior_run_id: run.id,
        completed_at: turn.completedAt,
        slug: receipt.slug,
        summary: receipt.summary,
        data: receipt.data,
      }, 16000));
    }
  }
  return evidence.slice(-8);
}
