// Connector Runtime V1 — bootstrap + lazy singleton.
//
// buildConnectorRuntime() wires the registry, registers each connector plugin
// (one small script per provider under ./plugins/), and constructs the runtime
// with flag config. getConnectorRuntime() is a process-lifetime singleton so
// the Chat in-process adapter and the MCP gateway share one authority.
//
// Registration order == migration order (plan §4). Phase 2 registers Gmail
// (reads). Later phases push more plugins here — each addition is one line.

import { ConnectorRegistry } from './connector-registry.js';
import { ConnectorRuntime } from './connector-runtime.js';
import { loadRuntimeConfig } from './config.js';
import { validateInput } from './input-validator.js';
import { makePolicyEngine } from './policy-engine.js';
import { ApprovalStore } from './approval-store.js';
import { makeAuditHook, makeMetricsHook } from './runtime-audit.js';
import { createGmailPlugin } from './plugins/gmail/index.js';

export { ConnectorRegistry } from './connector-registry.js';
export { ConnectorRuntime } from './connector-runtime.js';
export { ConnectorPlugin } from './connector-plugin.js';
export * as contracts from './contracts.js';
export * as errors from './errors.js';
export { loadRuntimeConfig, isRuntimeAllowed } from './config.js';

/**
 * Build a fresh registry with all production plugins registered.
 * @param {object} [deps] injectables forwarded to plugins (tests)
 */
export function buildRegistry(deps = {}) {
  const registry = new ConnectorRegistry();
  registry.register(createGmailPlugin(deps.gmail));
  // Phase 4 appends: google_docs, google_sheets, google_calendar, slack,
  // notion, github, linear, remaining Nango, external MCP — one line each.
  return registry;
}

/**
 * Build the production safety-pipeline hooks (plan §4). Reuses the existing
 * ajv, PendingWrite table, and AuditLogger — no new subsystems.
 * @param {object} opts { prisma?, auditLogger?, readOnlySurfaces?, logger? }
 */
export function buildDefaultHooks(opts = {}) {
  const logger = opts.logger || console;
  const hooks = {
    validateInput: (tool, input) => validateInput(tool, input),
    authorize: makePolicyEngine({ readOnlySurfaces: opts.readOnlySurfaces || [] }),
    audit: makeAuditHook({ auditLogger: opts.auditLogger || null, logger }),
    metrics: makeMetricsHook({ emit: opts.metricsEmit || null }),
  };
  const prisma = opts.prisma || opts.db || null;
  if (prisma && typeof prisma.pendingWrite?.create === 'function') {
    const store = new ApprovalStore({ prisma, logger });
    hooks.gateWrite = (args) => store.gateWrite(args);
    hooks.executeApproved = (draftId, ctx) => store.executeApproved(draftId, ctx);
  }
  return hooks;
}

/**
 * Construct a ConnectorRuntime (not a singleton).
 * @param {object} opts { db, prisma?, config?, logger?, hooks?, deps?, auditLogger?, readOnlySurfaces? }
 * If opts.hooks is given it is used verbatim (tests); otherwise production hooks
 * are built from opts (prisma/auditLogger/...).
 */
export function buildConnectorRuntime(opts = {}) {
  const registry = opts.registry || buildRegistry(opts.deps || {});
  const config = opts.config || loadRuntimeConfig();
  const hooks = opts.hooks || buildDefaultHooks({
    prisma: opts.prisma || opts.db,
    auditLogger: opts.auditLogger,
    readOnlySurfaces: opts.readOnlySurfaces,
    logger: opts.logger,
    metricsEmit: opts.metricsEmit,
  });
  return new ConnectorRuntime({
    registry,
    config,
    db: opts.db || null,
    logger: opts.logger || null,
    hooks,
  });
}

let _singleton = null;
/**
 * Process-lifetime runtime. First call fixes db/config; pass {force:true} to
 * rebuild (tests). Surfaces read flags off this instance's config.
 */
export function getConnectorRuntime(opts = {}) {
  if (_singleton && !opts.force) return _singleton;
  _singleton = buildConnectorRuntime(opts);
  // Expose for cross-module access without import cycles (matches the
  // globalThis.__hivemind* idiom used by document-first-ingestion).
  try { globalThis.__hivemindConnectorRuntime = _singleton; } catch { /* ignore */ }
  return _singleton;
}
