// Connector Runtime V1 — canonical contracts + validators.
//
// This is the single source of truth for the shapes every connector plugin,
// surface projection, and the MCP gateway agree on. Contracts are enforced at
// plugin-registration time (fail fast on a bad manifest) and referenced by the
// execution pipeline. Language- and tenant-neutral: no English keywords, no
// hard-coded provider list — everything is data on the manifest.
//
// See docs/connector-runtime/00-phase0-characterization.md §7 (frozen
// contracts) and the plan §3 (Desired Runtime Contracts).

import { ManifestError } from './errors.js';

/** Surfaces a connector tool may be exposed on. plan §3 ConnectorExecutionContext.surface */
export const SURFACES = Object.freeze(['chat', 'hyperagents', 'tara', 'mcp', 'sync', 'admin']);

/** Canonical result statuses. plan §3 CanonicalConnectorResult.status */
export const RESULT_STATUSES = Object.freeze([
  'completed',
  'approval_required',
  'not_connected',
  'reauth_required',
  'forbidden',
  'invalid_input',
  'timeout',
  'rate_limited',
  'failed',
]);

/** Access + approval + sync enums. */
export const ACCESS = Object.freeze(['read', 'write']);
export const APPROVAL = Object.freeze(['never', 'required']);
export const SYNC_MODES = Object.freeze(['none', 'poll', 'webhook', 'both']);

// Canonical tool naming: `<connector>__<operation>` (plan §3 "Stable tool
// naming"). connector + operation are each lower snake segments; the DOUBLE
// underscore is the only separator between them. This closes the "invalid MCP
// operation name" class (Phase 0 acceptance §9) — only names matching this can
// enter a catalog.
export const TOOL_NAME_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*__[a-z0-9]+(?:_[a-z0-9]+)*$/;
// Tool-name length limit — Phase 1 spike confirmed AgentScope/model tool names
// must stay well-bounded; 64 is the safe ceiling across OpenAI/Anthropic/MCP.
export const TOOL_NAME_MAX = 64;

/** Split `gmail__search` → { connector:'gmail', operation:'search' }. */
export function parseToolName(name) {
  const i = String(name || '').indexOf('__');
  if (i < 0) return { connector: null, operation: null };
  return { connector: name.slice(0, i), operation: name.slice(i + 2) };
}

function assert(cond, msg, meta) {
  if (!cond) throw new ManifestError(msg, meta);
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

/**
 * Validate one CanonicalConnectorTool. Throws ManifestError on any violation.
 * Returns a frozen, defaulted copy (so downstream code can rely on every field).
 */
export function validateToolContract(tool, { connectorId } = {}) {
  assert(isObj(tool), 'tool must be an object', { connectorId });
  assert(isStr(tool.name), 'tool.name required', { connectorId });
  assert(TOOL_NAME_RE.test(tool.name), `tool.name "${tool.name}" must match <connector>__<operation>`, { connectorId });
  assert(tool.name.length <= TOOL_NAME_MAX, `tool.name "${tool.name}" exceeds ${TOOL_NAME_MAX} chars`, { connectorId });
  if (connectorId) {
    const { connector } = parseToolName(tool.name);
    assert(connector === connectorId, `tool.name "${tool.name}" prefix must equal connector id "${connectorId}"`, { connectorId });
  }
  assert(isStr(tool.description), `tool.description required for ${tool.name}`, { connectorId });
  assert(isObj(tool.inputSchema), `tool.inputSchema (JSON Schema object) required for ${tool.name}`, { connectorId });
  assert(ACCESS.includes(tool.access), `tool.access must be read|write for ${tool.name}`, { connectorId });
  assert(APPROVAL.includes(tool.approval), `tool.approval must be never|required for ${tool.name}`, { connectorId });
  // Safety invariant: a write is not automatically approval:required (a draft
  // creation is a write but non-destructive), but a destructive tool MUST
  // require approval — you cannot silently destroy provider state.
  assert(!(tool.destructive === true && tool.approval !== 'required'),
    `destructive tool ${tool.name} must have approval:'required'`, { connectorId });
  const surfaces = tool.allowedSurfaces || SURFACES;
  assert(Array.isArray(surfaces) && surfaces.every((s) => SURFACES.includes(s)),
    `tool.allowedSurfaces for ${tool.name} must be a subset of ${SURFACES.join('|')}`, { connectorId });

  return Object.freeze({
    name: tool.name,
    title: tool.title || tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema || null,
    access: tool.access,
    approval: tool.approval,
    concurrencySafe: tool.concurrencySafe !== false, // default true
    idempotent: tool.idempotent === true,
    destructive: tool.destructive === true,
    openWorld: tool.openWorld === true,
    timeoutMs: Number.isFinite(tool.timeoutMs) ? tool.timeoutMs : (tool.access === 'write' ? 15000 : 8000),
    maxResultBytes: Number.isFinite(tool.maxResultBytes) ? tool.maxResultBytes : 32 * 1024,
    allowedSurfaces: Object.freeze([...surfaces]),
    minimumRole: tool.minimumRole || null,
    // legacy name this canonical tool wraps during migration (inbound alias only)
    legacyName: tool.legacyName || null,
  });
}

/**
 * Validate a ConnectorManifest. Throws ManifestError. Returns frozen manifest
 * with validated (frozen) tools.
 */
export function validateManifest(manifest) {
  assert(isObj(manifest), 'manifest must be an object');
  assert(isStr(manifest.id), 'manifest.id required');
  assert(/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(manifest.id), `manifest.id "${manifest.id}" must be lower snake_case`);
  assert(isStr(manifest.version), `manifest.version required for ${manifest.id}`);
  assert(isStr(manifest.displayName), `manifest.displayName required for ${manifest.id}`);
  assert(isStr(manifest.authProvider), `manifest.authProvider required for ${manifest.id}`);
  assert(SYNC_MODES.includes(manifest.syncMode || 'none'), `manifest.syncMode invalid for ${manifest.id}`);
  assert(Array.isArray(manifest.tools) && manifest.tools.length > 0, `manifest.tools[] required for ${manifest.id}`);

  const tools = manifest.tools.map((t) => validateToolContract(t, { connectorId: manifest.id }));
  const names = tools.map((t) => t.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert(dupes.length === 0, `manifest ${manifest.id} has duplicate tool names: ${[...new Set(dupes)].join(', ')}`);

  const surfaces = manifest.supportedSurfaces || SURFACES;
  assert(Array.isArray(surfaces) && surfaces.every((s) => SURFACES.includes(s)),
    `manifest.supportedSurfaces invalid for ${manifest.id}`);

  return Object.freeze({
    id: manifest.id,
    version: manifest.version,
    displayName: manifest.displayName,
    description: manifest.description || '',
    authProvider: manifest.authProvider,
    connectionAliases: Object.freeze([...(manifest.connectionAliases || [])]),
    supportedSurfaces: Object.freeze([...surfaces]),
    syncMode: manifest.syncMode || 'none',
    tools: Object.freeze(tools),
  });
}

/**
 * Validate a ConnectorExecutionContext. The model can never set these fields —
 * they are derived from the authenticated principal / capability token by the
 * surface adapter. Throws InvalidInputError-shaped ManifestError on violation.
 */
export function validateContext(ctx) {
  assert(isObj(ctx), 'execution context required');
  assert(isStr(ctx.requestId), 'ctx.requestId required');
  assert(isStr(ctx.userId), 'ctx.userId required');
  assert(isStr(ctx.orgId), 'ctx.orgId required');
  assert(SURFACES.includes(ctx.surface), `ctx.surface must be one of ${SURFACES.join('|')}`);
  return ctx;
}

/** Build a well-formed CanonicalConnectorResult. Never throws. */
export function makeResult({ status, content = [], approval = null, metadata = {} }) {
  const safeStatus = RESULT_STATUSES.includes(status) ? status : 'failed';
  return {
    status: safeStatus,
    content: Array.isArray(content) ? content : [],
    ...(approval ? { approval } : {}),
    metadata: {
      requestId: metadata.requestId || null,
      connector: metadata.connector || null,
      tool: metadata.tool || null,
      durationMs: Number.isFinite(metadata.durationMs) ? metadata.durationMs : 0,
      truncated: metadata.truncated === true,
      resultBytes: Number.isFinite(metadata.resultBytes) ? metadata.resultBytes : 0,
      ...(metadata.sourceIds ? { sourceIds: metadata.sourceIds } : {}),
    },
  };
}

/** Convenience: wrap an arbitrary JSON payload as a single json content block. */
export function jsonContent(data) {
  return [{ type: 'json', data }];
}
/** Convenience: wrap text as a single text content block. */
export function textContent(text) {
  return [{ type: 'text', text: String(text == null ? '' : text) }];
}
