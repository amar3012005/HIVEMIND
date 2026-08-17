/**
 * One-click approval links embedded in persona emails (2026-08-17).
 *
 * Same established pattern as OrgInvite's public `/v1/join/:token` preview +
 * decline (control-plane-server.js) — a public, unguessable, single-use
 * token gates the action instead of a session, so the owner can approve
 * from a phone without logging into the desktop app. The PREVIEW (GET) never
 * mutates anything; only the explicit POST /approve call does — this matters
 * because email clients and security scanners are known to auto-fetch links
 * in an email's body, and a GET that performed the approval would fire on
 * that prefetch, not on a real human decision.
 *
 * v1 covers ONLY the 'authority' kind (approval_required — a governed
 * external-action checkpoint, e.g. "send this campaign"). The activation-
 * sprint "first plan is ready" decision is a rarer, one-time-per-company
 * event and is deliberately NOT wired to a one-click link yet — narrated by
 * email as before, without a button. Explicit scoping choice, not an
 * oversight.
 */
import crypto from 'node:crypto';
import { stageAuthorityHash } from '../runtime-playbooks/stage-executor.js';

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — matches OrgInvite's typical window

function mintToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Create a one-click approval token for a WAITING_AUTHORITY checkpoint.
 * Returns null (never throws) if the run/gate can't be resolved — the
 * caller (persona-narrator.js) falls back to an email with no button.
 */
export async function createAuthorityApprovalToken({ prisma, runtime, orgName, runId, gate, title, summary }) {
  if (!prisma || !runtime || !runId || !gate) return null;
  try {
    const token = mintToken();
    await prisma.hqApprovalToken.create({
      data: {
        token, orgId: runtime.orgId, runtimeId: runtime.id, kind: 'authority',
        runId, gate, title: String(title || '').slice(0, 500), summary: String(summary || ''),
        orgName: orgName || null,
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      },
    });
    return token;
  } catch {
    return null;
  }
}

/**
 * GET preview — read-only, never mutates. Returns a status the caller uses
 * to render the approval page: 'ready' | 'used' | 'expired' | 'not_found' |
 * 'stale' (the underlying run moved on and this checkpoint no longer needs
 * a decision — a real, honest outcome, not an error).
 */
export async function previewApprovalToken({ prisma, token }) {
  if (!prisma || !token) return { status: 'not_found' };
  const approval = await prisma.hqApprovalToken.findUnique({ where: { token } });
  if (!approval) return { status: 'not_found' };
  if (approval.usedAt) return { status: 'used', title: approval.title, orgName: approval.orgName };
  if (approval.expiresAt < new Date()) return { status: 'expired', title: approval.title, orgName: approval.orgName };

  const run = approval.runId
    ? await prisma.runtimePlaybookRun.findFirst({ where: { id: approval.runId, orgId: approval.orgId } })
    : null;
  if (!run || run.status !== 'WAITING_AUTHORITY') {
    return { status: 'stale', title: approval.title, orgName: approval.orgName };
  }

  return {
    status: 'ready',
    title: approval.title,
    summary: approval.summary,
    orgName: approval.orgName,
    gate: approval.gate,
  };
}

/**
 * POST approve — the ONLY mutating action. Consumes the token (marks it
 * used, single-use) and grants the exact authority gate it was minted for,
 * via the same service.grantAuthority primitive the session-gated route
 * uses — no parallel approval mechanism, same underlying grant.
 */
export async function consumeApprovalToken({ prisma, token, runtimePlaybooks, wakeScheduler }) {
  if (!prisma || !token) return { ok: false, status: 'not_found' };
  const approval = await prisma.hqApprovalToken.findUnique({ where: { token } });
  if (!approval) return { ok: false, status: 'not_found' };
  if (approval.usedAt) return { ok: false, status: 'used' };
  if (approval.expiresAt < new Date()) return { ok: false, status: 'expired' };

  const service = typeof runtimePlaybooks === 'function' ? runtimePlaybooks() : runtimePlaybooks;
  if (!service) return { ok: false, status: 'service_unavailable' };

  const run = approval.runId
    ? await prisma.runtimePlaybookRun.findFirst({ where: { id: approval.runId, orgId: approval.orgId } })
    : null;
  if (!run || run.status !== 'WAITING_AUTHORITY') return { ok: false, status: 'stale' };

  const playbook = service.registry.get(run.playbookId, run.playbookVersion, { scopeKey: run.scopeKey });
  const stage = playbook?.stages?.find((candidate) => candidate.id === run.currentStageId);
  if (!stage || stage.authority_gate !== approval.gate) return { ok: false, status: 'stale' };

  // Consume the token FIRST (single-use, race-safe: a concurrent second
  // click gets 'used' from the updateMany count, never a double-grant).
  const consumed = await prisma.hqApprovalToken.updateMany({
    where: { token, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (consumed.count !== 1) return { ok: false, status: 'used' };

  await service.grantAuthority(run.id, approval.orgId, approval.gate, {
    grantedBy: null,
    payload: { source: 'email_approval_link', input_hash: stageAuthorityHash(run, stage) },
  });
  Promise.resolve(typeof wakeScheduler === 'function' ? wakeScheduler() : null).catch(() => {});
  return { ok: true, status: 'approved', title: approval.title };
}
