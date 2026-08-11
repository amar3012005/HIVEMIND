// Connector Runtime V1 — approval + idempotency over the EXISTING PendingWrite
// table (plan §4 "Approval"/"Idempotency"; plan §2 "adopt this flow rather than
// creating another approval system").
//
// This is the runtime-layer wrapper around the same `pending_writes` rows the
// chat draft-approval middleware uses, with the same hash formulas (see
// approval-hash.js). Prisma is injected so it is unit-testable with an in-memory
// fake.
//
// Write flow:
//   gateWrite(tool=write) -> if an idempotency-matching pending row exists,
//     return its approval (no dup); else create a draft row -> return
//     approval_required { id, summary, expiresAt }.
//   The provider is NOT called here — execution happens only after approval.
//
// Approved execution (called by the approve endpoint / adapter):
//   executeApproved(draftId, {tool, ctx, invoke}) -> reload validated args,
//   re-check scope + argsHash + expiry, atomically CLAIM the row (updateMany
//   count must be 1 = replay guard), invoke once, persist result.

import { makeResult, textContent } from './contracts.js';
import { ApprovalRequiredError } from './errors.js';
import { hashArgs, idempotencyKeyFor, draftTtlMs } from './approval-hash.js';

function buildSummary(connectorId, toolName, args) {
  // Bounded, language-neutral preview. Providers may override via a
  // plugin-supplied previewFn in a later phase; default is safe + generic.
  const s = (() => { try { return JSON.stringify(args || {}); } catch { return ''; } })();
  return `${connectorId}/${toolName}: ${s.slice(0, 200)}`;
}

export class ApprovalStore {
  /** @param {{ prisma:any, logger?:any }} deps */
  constructor({ prisma, logger = console } = {}) {
    if (!prisma) throw new Error('ApprovalStore requires prisma');
    this.prisma = prisma;
    this.log = logger;
  }

  /**
   * gateWrite hook. Returns a CanonicalConnectorResult (approval_required) for
   * write tools, or null to let reads proceed.
   */
  async gateWrite({ tool, context, input, connectorId, connection }) {
    if (!tool || tool.access !== 'write' || tool.approval !== 'required') return null;

    const argsHash = hashArgs(input);
    const idempotencyKey = idempotencyKeyFor({
      orgId: context.orgId,
      userId: context.userId,
      projectId: context.projectIds?.[0] || context.projectId,
      toolGroup: connectorId,
      toolName: tool.name,
      argsHash,
      traceId: context.requestId,
    });

    // Idempotency: identical pending/approved request → return existing approval
    // (no duplicate row). Same-key-while-pending returns the existing approval.
    const existing = await this.prisma.pendingWrite.findUnique({ where: { idempotencyKey } }).catch(() => null);
    if (existing && ['draft', 'approved', 'executing'].includes(existing.status)) {
      const unexpired = existing.expiresAt && new Date(existing.expiresAt).getTime() > Date.now();
      if (unexpired) return this._approvalResult(existing, context, connectorId, tool.name);
    }
    if (existing && existing.status === 'sent' && existing.result != null) {
      // Same approved key returns the prior result (idempotent replay).
      return makeResult({
        status: 'completed',
        content: [{ type: 'json', data: existing.result }],
        metadata: { requestId: context.requestId, connector: connectorId, tool: tool.name },
      });
    }

    const expiresAt = new Date(Date.now() + draftTtlMs());
    const preview = buildSummary(connectorId, tool.name, input);
    let row;
    try {
      row = await this.prisma.pendingWrite.create({
        data: {
          userId: context.userId,
          orgId: context.orgId || null,
          provider: connectorId,
          toolGroup: connectorId,
          toolName: tool.name,
          toolArgs: input || {},
          argsHash,
          projectId: (context.projectIds?.[0] || context.projectId) || null,
          connectionId: (connection && connection.connectionId) || context.connectionId || null,
          traceId: context.requestId || null,
          idempotencyKey,
          expiresAt,
          preview,
          status: 'draft',
        },
      });
    } catch (err) {
      // Unique-constraint race: another concurrent gate created it first.
      const dup = await this.prisma.pendingWrite.findUnique({ where: { idempotencyKey } }).catch(() => null);
      if (dup) return this._approvalResult(dup, context, connectorId, tool.name);
      this.log.warn('[connector-runtime] approval persist failed:', err?.message);
      return makeResult({ status: 'failed', content: textContent(`approval persist failed: ${err?.message}`), metadata: { requestId: context.requestId, connector: connectorId, tool: tool.name } });
    }
    return this._approvalResult(row, context, connectorId, tool.name);
  }

  _approvalResult(row, context, connectorId, toolName) {
    return makeResult({
      status: 'approval_required',
      content: textContent(`Awaiting approval: ${row.preview || toolName}`),
      approval: { id: row.id, summary: row.preview || toolName, expiresAt: (row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt) },
      metadata: { requestId: context.requestId, connector: connectorId, tool: toolName },
    });
  }

  /**
   * Execute a previously-approved write exactly once. `invoke(args)` performs
   * the real provider call and returns a CanonicalConnectorResult.
   * @returns {Promise<import('./contracts.js').CanonicalConnectorResult>}
   */
  async executeApproved(draftId, { tool, context, invoke }) {
    const row = await this.prisma.pendingWrite.findUnique({ where: { id: draftId } }).catch(() => null);
    if (!row) return makeResult({ status: 'invalid_input', content: textContent('unknown draft'), metadata: { requestId: context.requestId } });

    // Re-check membership, scope, argsHash, expiry — the browser can NEVER
    // substitute arguments; we execute the STORED validated args only.
    const storedHash = hashArgs(row.toolArgs);
    const unexpired = row.expiresAt && new Date(row.expiresAt).getTime() > Date.now();
    const scopeOk = row.status === 'approved'
      && row.toolName === tool.name
      && row.userId === context.userId
      && (row.orgId || null) === (context.orgId || null)
      && (row.projectId || null) === ((context.projectIds?.[0] || context.projectId) || null)
      && row.argsHash === storedHash
      && unexpired;
    if (!scopeOk) {
      return makeResult({ status: 'forbidden', content: textContent('draft not approved, expired, or scope changed'), metadata: { requestId: context.requestId, tool: tool.name } });
    }

    // Atomic claim — exactly one caller transitions approved -> executing.
    // A double-approve races here; only the winner (count===1) executes.
    const claimed = await this.prisma.pendingWrite.updateMany({
      where: {
        id: row.id, status: 'approved', toolName: tool.name,
        userId: context.userId, orgId: context.orgId || null,
        argsHash: storedHash, expiresAt: { gt: new Date() },
      },
      data: { status: 'executing' },
    }).catch(() => ({ count: 0 }));
    if (!claimed || claimed.count !== 1) {
      return makeResult({ status: 'forbidden', content: textContent('draft already claimed or authorization changed'), metadata: { requestId: context.requestId, tool: tool.name } });
    }

    let result;
    try {
      result = await invoke(row.toolArgs); // STORED args only — never the browser's
    } catch (err) {
      await this.prisma.pendingWrite.update({ where: { id: row.id }, data: { status: 'failed', sentAt: new Date(), errorMsg: String(err?.message || err).slice(0, 500) } }).catch(() => {});
      throw err;
    }
    const failed = result?.status && result.status !== 'completed';
    await this.prisma.pendingWrite.update({
      where: { id: row.id },
      data: {
        status: failed ? 'failed' : 'sent',
        sentAt: new Date(),
        result: failed ? null : (result?.content?.[0]?.data ?? result?.content ?? null),
        errorMsg: failed ? (result?.content?.[0]?.text || result?.status) : null,
      },
    }).catch(() => {});
    return result;
  }
}
