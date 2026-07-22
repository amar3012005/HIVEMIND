// Connector Runtime V1 — the single execution authority.
//
// Every connector call from every surface enters here. plan §4 defines the
// 18-step pipeline. This file implements the Phase-2 subset fully and leaves
// EXPLICIT, marked hook points where Phase 3 inserts the safety stages
// (schema validation, policy, approval, idempotency, audit, metrics). The
// spine order never changes — later phases fill hooks, they do not reorder.
//
// Phase-2 guarantees already provided:
//   - context is validated (model can never set identity/surface)
//   - legacy names resolve to canonical inbound only
//   - a tool is executable only on its allowed surfaces
//   - execution is deadline-bounded (never hangs — Phase 0 §10 flagged the
//     legacy mcp/exec having NO timeout)
//   - provider errors classify to a structured status (never a raw stack)
//   - results are normalized + truncated to the tool's byte budget, secrets
//     redacted
//
// Nothing here touches ingestion/recall/chat. Surfaces opt in via config flags.

import {
  validateContext,
  makeResult,
  jsonContent,
  textContent,
} from './contracts.js';
import {
  ConnectorError,
  InvalidInputError,
  ForbiddenError,
  TimeoutError,
  classifyError,
  redactSecrets,
} from './errors.js';

const now = () => Date.now();

function withDeadline(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} exceeded ${ms}ms deadline`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Byte size of a content array's payload (UTF-8), used for truncation budget.
function contentBytes(content) {
  try {
    return Buffer.byteLength(JSON.stringify(content), 'utf8');
  } catch {
    return 0;
  }
}

// Truncate a result's content to maxResultBytes, preserving source IDs and
// flagging truncated=true (plan §4 "Result limits"). Language-neutral: operates
// on bytes + a bounded preview, no locale assumptions.
function truncateResult(result, maxBytes) {
  const bytes = contentBytes(result.content);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || bytes <= maxBytes) {
    result.metadata.resultBytes = bytes;
    return result;
  }
  // Build a bounded text preview from whatever content we have.
  let preview = '';
  for (const block of result.content) {
    if (block.type === 'text' && block.text) preview += block.text;
    else if (block.type === 'json') {
      try { preview += JSON.stringify(block.data); } catch { /* ignore */ }
    }
    if (Buffer.byteLength(preview, 'utf8') >= maxBytes) break;
  }
  // Trim preview to the byte budget on a char boundary.
  const buf = Buffer.from(preview, 'utf8').subarray(0, Math.max(0, maxBytes - 256));
  const safePreview = buf.toString('utf8');
  result.content = [{ type: 'text', text: safePreview }];
  result.metadata.truncated = true;
  result.metadata.resultBytes = Buffer.byteLength(safePreview, 'utf8');
  return result;
}

export class ConnectorRuntime {
  /**
   * @param {object} opts
   * @param {import('./connector-registry.js').ConnectorRegistry} opts.registry
   * @param {object} [opts.config]  loadRuntimeConfig() result (flag gating)
   * @param {object} [opts.db]      prisma/db handle passed to plugins
   * @param {object} [opts.logger]  { info, warn, error } — defaults to console
   * @param {object} [opts.hooks]   Phase-3 injectables (see below); all optional
   */
  constructor({ registry, config = null, db = null, logger = null, hooks = {} } = {}) {
    if (!registry) throw new Error('ConnectorRuntime requires a registry');
    this.registry = registry;
    this.config = config;
    this.db = db;
    this.log = logger || {
      info: (...a) => console.log('[connector-runtime]', ...a),
      warn: (...a) => console.warn('[connector-runtime]', ...a),
      error: (...a) => console.error('[connector-runtime]', ...a),
    };
    // Phase-3 hook points. Each defaults to a permissive/no-op so the spine is
    // identical whether or not the safety stages are installed. Later phases
    // pass real implementations here — no spine edits.
    this.hooks = {
      // (steps 3,5,6,7) authz: throw ConnectorError to deny; return void to allow
      authorize: hooks.authorize || (async () => {}),
      // (step 9) validate+coerce input against tool.inputSchema; return coerced input
      validateInput: hooks.validateInput || (async (_tool, input) => input),
      // (steps 10-12) approval + idempotency; return a CanonicalConnectorResult to
      // short-circuit (e.g. approval_required), or null/undefined to proceed
      gateWrite: hooks.gateWrite || (async () => null),
      // (step 13) tenant concurrency slot; return a release fn or void
      acquireSlot: hooks.acquireSlot || (async () => () => {}),
      // approved-write executor (approvalStore.executeApproved); null = not installed
      executeApproved: hooks.executeApproved || null,
      // durable sync job store (plan §7); null = not installed
      syncStore: hooks.syncStore || null,
      // canonical ingestion front door for the sync worker; null = not installed
      ingestSource: hooks.ingestSource || null,
      // (step 17) audit; fire-and-safe
      audit: hooks.audit || (async () => {}),
      // (step 18) metrics; fire-and-safe
      metrics: hooks.metrics || (() => {}),
    };
  }

  /** Catalog projection for a context: [{connector, tools:[...]}]. plan §4 step "list tools". */
  async listTools(context, { connectors = null } = {}) {
    validateContext(context);
    const out = [];
    for (const plugin of this.registry.listConnectors()) {
      if (connectors && !connectors.includes(plugin.id)) continue;
      if (this.config && !this._allowed(context.surface, plugin.id)) continue;
      const tools = await plugin.listTools(context);
      if (tools.length) out.push({ connector: plugin.id, manifestVersion: plugin.manifest.version, tools });
    }
    return out;
  }

  _allowed(surface, connectorId) {
    // Lazy import avoids a hard dep when config is absent (tests).
    if (!this.config) return true;
    if (!this.config.enabled) return false;
    if (surface && !this.config.surfaces[surface]) return false;
    if (this.config.connectors.size > 0 && !this.config.connectors.has(String(connectorId).toLowerCase())) return false;
    return true;
  }

  /**
   * Execute one canonical (or legacy-aliased) tool. Always resolves to a
   * CanonicalConnectorResult — never throws.
   */
  async executeTool(toolName, input, context) {
    const startedAt = now();
    let connectorId = null;
    let canonicalName = toolName;
    const meta = () => ({ requestId: context?.requestId || null, connector: connectorId, tool: canonicalName, durationMs: now() - startedAt });

    try {
      // 1-2. establish + validate execution context (identity is server-owned)
      validateContext(context);

      // 4. resolve canonical connector + tool (legacy name → canonical inbound)
      const resolved = this.registry.resolveTool(toolName);
      if (!resolved) {
        throw new InvalidInputError(`unknown tool "${toolName}"`);
      }
      const { plugin, tool } = resolved;
      canonicalName = resolved.canonicalName;
      connectorId = resolved.connectorId;

      // flag gate: is the runtime allowed to serve this connector on this surface?
      if (this.config && !this._allowed(context.surface, connectorId)) {
        throw new ForbiddenError(`connector "${connectorId}" not enabled for surface "${context.surface}"`);
      }

      // 6. surface permission (tool-level)
      if (!tool.allowedSurfaces.includes(context.surface)) {
        throw new ForbiddenError(`tool "${canonicalName}" not allowed on surface "${context.surface}"`);
      }

      // 3,5,7. authz hook (capability token / membership / role+project) — Phase 3
      await this.hooks.authorize({ plugin, tool, context, input });

      // 8. resolve active connection (never another user's — plugin enforces)
      const connection = await plugin.getConnection(context);
      if (connection && connection.connected === false) {
        throw new ConnectorError('connector not connected', { status: 'not_connected', code: 'not_connected' });
      }

      // 9. validate + coerce input against the tool schema — Phase 3 (no-op now)
      const coerced = await this.hooks.validateInput(tool, input, context);

      // 10-12. approval + idempotency for writes (Phase 3). Reads → null → proceed.
      // A surface whose own middleware owns approval (Chat's draft-approval —
      // the frozen draft_created contract) sets approvalOwnedBySurface so the
      // runtime does NOT double-gate: the surface has already created + approved
      // the draft, and calls in to execute the approved write once.
      const gated = context.approvalOwnedBySurface
        ? null
        : await this.hooks.gateWrite({ plugin, tool, context, input: coerced, connection, connectorId });
      if (gated) {
        const g = this._finalize(gated, tool, startedAt, connectorId, canonicalName);
        await this._observe({ tool, context, result: g, connectorId });
        return g;
      }

      // 13-16. concurrency slot + deadline-bounded execute + normalize
      const result = await this._invokeProvider(plugin, tool, canonicalName, coerced, context, connection);
      // 16-18. truncate + audit + metrics (audit may fail-close a completed write)
      const finalized = this._finalize(result, tool, startedAt, connectorId, canonicalName);
      await this._observe({ tool, context, result: finalized, connectorId });
      return finalized;
    } catch (err) {
      const ce = classifyError(err);
      const result = makeResult({
        status: ce.status,
        content: textContent(redactSecrets(ce.message)),
        approval: ce.approval || null,
        metadata: meta(),
      });
      // already rendering an error — never let an audit throw escape here
      await this._observe({ tool: null, context, result, connectorId, error: ce }).catch(() => {});
      return result;
    }
  }

  // Steps 13-15: acquire tenant slot, execute with deadline, normalize.
  async _invokeProvider(plugin, tool, canonicalName, coerced, context, connection) {
    const release = await this.hooks.acquireSlot({ tool, context });
    let result;
    try {
      result = await withDeadline(
        Promise.resolve(plugin.executeTool(canonicalName, coerced, { ...context, connection, db: this.db })),
        tool.timeoutMs,
        `${canonicalName}`,
      );
    } finally {
      try { if (typeof release === 'function') release(); } catch { /* ignore */ }
    }
    return this._coerceResult(result);
  }

  /**
   * Execute a previously-approved write EXACTLY ONCE (called by the approve
   * endpoint / surface adapter). Delegates the claim/replay-guard to the
   * approvalStore hook; the provider runs with the STORED validated args only.
   */
  async executeApproved(draftId, toolName, context) {
    const startedAt = now();
    let connectorId = null; let canonicalName = toolName;
    try {
      validateContext(context);
      const resolved = this.registry.resolveTool(toolName);
      if (!resolved) throw new InvalidInputError(`unknown tool "${toolName}"`);
      const { plugin, tool } = resolved;
      canonicalName = resolved.canonicalName; connectorId = resolved.connectorId;
      if (this.config && !this._allowed(context.surface, connectorId)) {
        throw new ForbiddenError(`connector "${connectorId}" not enabled for surface "${context.surface}"`);
      }
      if (!this.hooks.executeApproved) throw new ConnectorError('approval store not installed', { status: 'failed' });
      const connection = await plugin.getConnection(context);
      const result = await this.hooks.executeApproved(draftId, {
        tool,
        context,
        invoke: async (storedArgs) => this._coerceResult(
          await withDeadline(
            Promise.resolve(plugin.executeTool(canonicalName, storedArgs, { ...context, connection, db: this.db })),
            tool.timeoutMs, `${canonicalName}`,
          ),
        ),
      });
      const finalized = this._finalize(result, tool, startedAt, connectorId, canonicalName);
      await this._observe({ tool, context, result: finalized, connectorId });
      return finalized;
    } catch (err) {
      const ce = classifyError(err);
      return makeResult({ status: ce.status, content: textContent(redactSecrets(ce.message)), metadata: { requestId: context?.requestId || null, connector: connectorId, tool: canonicalName, durationMs: now() - startedAt } });
    }
  }

  /**
   * Enqueue a durable background sync for a connector (plan §7 Ingestion). The
   * job is the Postgres source of truth; a worker leases it and delegates to
   * the canonical SyncEngine (→ ingestSource). Does not run the fetch inline.
   * @returns {Promise<{jobId:string,status:string}|{error:string}>}
   */
  async startSync(connectorId, opts = {}) {
    if (!this.hooks.syncStore) return { error: 'sync store not installed' };
    if (this.config && !this._allowed('sync', connectorId)) return { error: `sync not enabled for connector "${connectorId}"` };
    if (!this.registry.hasConnector(connectorId)) return { error: `unknown connector "${connectorId}"` };
    if (!opts.orgId || !opts.userId) return { error: 'orgId + userId required' };
    const job = await this.hooks.syncStore.enqueue({
      orgId: opts.orgId, userId: opts.userId, connectorId,
      connectionId: opts.connectionId || null, mode: opts.mode || 'incremental',
      requestedScope: opts.requestedScope || null, projectIds: opts.projectIds || [],
      config: opts.config || null, key: opts.key || null,
    });
    return { jobId: job.id, status: job.status };
  }

  /**
   * Worker tick (Phase 10): lease ONE due sync job and run it. Returns
   * { drained: 0|1, jobId? }. A server-side loop calls this on an interval when
   * CONNECTOR_RUNTIME_SYNC is on. Safe when idle (no jobs → returns 0) and safe
   * when a plugin has no sync() (job fails gracefully, never throws).
   */
  async drainSyncOnce(leaseOwner = 'core') {
    if (!this.hooks.syncStore) return { drained: 0 };
    const job = await this.hooks.syncStore.leaseNext(leaseOwner).catch(() => null);
    if (!job) return { drained: 0 };
    await this._runSyncJob(job);
    return { drained: 1, jobId: job.id };
  }

  async _runSyncJob(job) {
    const plugin = this.registry.getPlugin(job.connectorId);
    if (!plugin || typeof plugin.sync !== 'function') {
      await this.hooks.syncStore.fail(job.id, `connector "${job.connectorId}" has no sync()`).catch(() => {});
      return;
    }
    await this.hooks.syncStore.markRunning(job.id).catch(() => {});
    const ctx = {
      requestId: `sync-${job.id}`, userId: job.userId, orgId: job.orgId, role: 'system',
      surface: 'sync', projectIds: job.projectIds || [], connectionId: job.connectionId || null, db: this.db,
    };
    let processed = 0; let imported = 0; let failed = 0; let cursor = job.cursor || null;
    try {
      const connection = await plugin.getConnection(ctx);
      if (connection && connection.connected === false) throw new ConnectorError('connector not connected', { status: 'not_connected' });
      const request = { mode: job.mode, cursor, requestedScope: job.requestedScope, projectIds: job.projectIds || [], config: job.config };
      for await (const batch of plugin.sync(request, { ...ctx, connection })) {
        for (const envelope of (batch?.records || [])) {
          processed += 1;
          try {
            if (this.hooks.ingestSource) { await this.hooks.ingestSource(envelope); imported += 1; }
          } catch (e) { failed += 1; this.log.warn(`[connector-sync] ingest failed for ${job.connectorId}:`, e?.message); }
        }
        if (batch && batch.cursor != null) cursor = batch.cursor;
        // renew lease + checkpoint after each committed batch (resume from cursor on restart)
        await this.hooks.syncStore.markRunning(job.id, { cursor }).catch(() => {});
      }
      await this.hooks.syncStore.complete(job.id, { processed, imported, failed, cursor }).catch(() => {});
    } catch (err) {
      const ce = classifyError(err);
      await this.hooks.syncStore.fail(job.id, redactSecrets(ce.message), { reauth: ce.status === 'reauth_required' }).catch(() => {});
    }
  }

  // Accept either a well-formed CanonicalConnectorResult (from a plugin that
  // built one) or a raw provider payload; wrap the latter as json content.
  _coerceResult(result) {
    if (result && typeof result === 'object' && Array.isArray(result.content) && result.status) {
      return result; // already canonical
    }
    return makeResult({ status: 'completed', content: jsonContent(result == null ? {} : result) });
  }

  _finalize(result, tool, startedAt, connectorId, canonicalName) {
    result.metadata = {
      ...result.metadata,
      requestId: result.metadata?.requestId || null,
      connector: connectorId,
      tool: canonicalName,
      durationMs: now() - startedAt,
    };
    return truncateResult(result, tool?.maxResultBytes);
  }

  // Awaited: audit may fail-close a completed write (the hook throws) — that
  // throw MUST propagate to the caller's catch so the result renders failed
  // rather than reporting success without an audit trail. Metrics never throw.
  async _observe({ tool, context, result, connectorId, error }) {
    await this.hooks.audit({ tool, context, result, connectorId, error });
    try {
      this.hooks.metrics({
        connector: connectorId,
        tool: tool?.name || result?.metadata?.tool || null,
        surface: context?.surface || null,
        status: result?.status,
        durationMs: result?.metadata?.durationMs,
        truncated: result?.metadata?.truncated,
      });
    } catch (e) { this.log.warn('metrics hook threw', e?.message); }
  }
}
