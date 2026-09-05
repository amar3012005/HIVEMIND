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

function referenceCandidates(value, source, found = [], depth = 0) {
  if (value == null || depth > 8) return found;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) {
      if (item && typeof item === 'object' && !Array.isArray(item)) found.push({ source, record: item });
      referenceCandidates(item, source, found, depth + 1);
    }
  } else if (typeof value === 'object') {
    for (const item of Object.values(value).slice(0, 50)) referenceCandidates(item, source, found, depth + 1);
  }
  return found;
}

const normalized = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Resolve demonstratives such as "this email" against displayed evidence.
 * Matching uses the business values the user quoted; provider IDs remain an
 * output of resolution and are never expected from the user.
 */
export function resolveGovernedConversationReference(message, evidence = []) {
  const request = normalized(message);
  if (!request || !evidence.length) return null;
  const candidates = evidence.flatMap(item => referenceCandidates(item?.data, {
    prior_run_id: item?.prior_run_id, slug: item?.slug, completed_at: item?.completed_at,
  }));
  const scored = candidates.map(candidate => {
    const values = Object.values(candidate.record || {}).filter(value =>
      ['string', 'number'].includes(typeof value)).map(normalized).filter(value => value.length >= 4 && value.length <= 500);
    const matches = values.filter(value => request.includes(value));
    return { ...candidate, score: matches.reduce((sum, value) => sum + Math.min(80, value.length), 0), matches: matches.length };
  }).filter(item => item.matches > 0).sort((a, b) => b.score - a.score);
  if (!scored.length || (scored[1] && scored[0].score === scored[1].score)) return null;
  return projectGovernedEvidence({ ...scored[0].source, record: scored[0].record }, 12000);
}

/** Resolve an LLM-normalized ordinal selector against prior authenticated
 * receipt order. The selector is language-neutral; no provider or locale
 * vocabulary is embedded in the harness. */
export function resolveGovernedConversationReferenceBySelector(selector, evidence = []) {
  if (!selector || !evidence.length) return null;
  const position = selector.position === 'last' ? 'last' : Number(selector.position);
  const receipt = [...evidence].reverse().find(item => item?.data != null);
  if (!receipt) return null;
  const collections = [];
  const visit = (value, depth = 0) => {
    if (value == null || depth > 5) return;
    if (Array.isArray(value)) {
      if (value.some(item => item && typeof item === 'object' && !Array.isArray(item))) collections.push({ depth, value });
      for (const item of value.slice(0, 50)) visit(item, depth + 1);
      return;
    }
    if (typeof value === 'object') for (const item of Object.values(value).slice(0, 50)) visit(item, depth + 1);
  };
  visit(receipt.data);
  const records = collections.sort((left, right) => left.depth - right.depth || right.value.length - left.value.length)[0]?.value || [];
  const index = position === 'last' ? records.length - 1 : Math.max(0, Math.floor(position || 1) - 1);
  const record = records[index];
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  return projectGovernedEvidence({
    prior_run_id: receipt.prior_run_id,
    slug: receipt.slug,
    completed_at: receipt.completed_at,
    record,
  }, 12000);
}
