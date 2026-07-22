// Connector Runtime V1 — audit + metrics hooks (plan §4 steps 17,18).
//
// Phase 0 §1 found AuditLogger EXISTS (server.js:934) but is NOT called on any
// connector-exec route. The runtime closes that gap: every call emits one audit
// event through the injected auditLogger (reuse — not a new audit system).
//
// Audit events carry NO secrets (the runtime already redacts error text and
// never puts tokens in results). Sensitive WRITES fail closed if audit throws
// (plan §9 "Audit failure: sensitive writes fail closed"); reads log-and-continue.

/**
 * Build an audit hook. `auditLogger` is the existing AuditLogger instance (or a
 * compatible { log(event) }). If absent, audit degrades to the runtime logger.
 */
export function makeAuditHook({ auditLogger = null, logger = console } = {}) {
  return async function audit({ tool, context, result, connectorId, error }) {
    const event = {
      kind: 'connector_exec',
      connector: connectorId || null,
      tool: tool?.name || result?.metadata?.tool || null,
      access: tool?.access || null,
      surface: context?.surface || null,
      userId: context?.userId || null,
      orgId: context?.orgId || null,
      requestId: context?.requestId || null,
      status: result?.status || (error ? error.status : null),
      durationMs: result?.metadata?.durationMs ?? null,
      truncated: result?.metadata?.truncated ?? false,
      errorCode: error?.code || null,
    };
    try {
      if (auditLogger && typeof auditLogger.log === 'function') await auditLogger.log(event);
      else logger.info?.('[connector-audit]', JSON.stringify(event));
    } catch (e) {
      // Fail closed ONLY when a write actually COMPLETED (a real side effect
      // occurred) — re-throw so the runtime does not report success without an
      // audit trail. approval_required / failed / reads log-and-continue.
      if (tool?.access === 'write' && result?.status === 'completed') throw e;
      logger.warn?.('[connector-audit] audit failed (non-fail-closed, continuing):', e?.message);
    }
  };
}

/**
 * Build a metrics hook. In-memory counters by (connector,tool,status); an
 * optional `emit(sample)` forwards to a real sink (statsd/otel) later.
 */
export function makeMetricsHook({ emit = null } = {}) {
  const counters = new Map();
  const hook = (sample) => {
    const key = `${sample.connector || '?'}::${sample.tool || '?'}::${sample.status || '?'}`;
    counters.set(key, (counters.get(key) || 0) + 1);
    if (typeof emit === 'function') { try { emit(sample); } catch { /* never throw from metrics */ } }
  };
  hook.snapshot = () => Object.fromEntries(counters);
  return hook;
}
