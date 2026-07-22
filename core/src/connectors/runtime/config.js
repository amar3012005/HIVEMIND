// Connector Runtime V1 — feature-flag configuration.
//
// Every flag defaults OFF. The runtime is purely additive until a surface is
// explicitly flipped (plan §10 Production Rollout). Flags are scoped by
// surface and by connector so canary can be narrow. Nothing in the V5
// ingestion/recall/chat paths changes unless the relevant flag is on.
//
//   CONNECTOR_RUNTIME_ENABLED     master switch (runtime may execute)
//   CONNECTOR_RUNTIME_CHAT        Chat surface uses the runtime adapter
//   CONNECTOR_RUNTIME_HYPER       HyperAgents uses the MCP gateway
//   CONNECTOR_RUNTIME_TARA        TARA uses the MCP gateway
//   CONNECTOR_RUNTIME_MCP         external MCP gateway enabled
//   CONNECTOR_RUNTIME_SYNC        durable sync jobs enabled
//   CONNECTOR_RUNTIME_CONNECTORS  comma list of connector ids allowed (empty = all registered)

const truthy = (v) => v === '1' || v === 'true' || v === 'yes' || v === 'on';

// When an explicit env object is passed (tests, sandboxes), it is AUTHORITATIVE
// — no silent process.env fallback (which made loadRuntimeConfig({}) inherit
// ambient CONNECTOR_RUNTIME_* flags). The default caller passes process.env.
function readEnv(name, env, explicit) {
  if (explicit) return (env[name] != null ? env[name] : '') || '';
  return (env && env[name] != null ? env[name] : process.env[name]) || '';
}

export function loadRuntimeConfig(env = process.env) {
  const explicit = env !== process.env;
  const rd = (name) => readEnv(name, env, explicit);
  const connectorsRaw = rd('CONNECTOR_RUNTIME_CONNECTORS');
  const connectors = connectorsRaw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    enabled: truthy(rd('CONNECTOR_RUNTIME_ENABLED')),
    surfaces: {
      chat: truthy(rd('CONNECTOR_RUNTIME_CHAT')),
      hyperagents: truthy(rd('CONNECTOR_RUNTIME_HYPER')),
      tara: truthy(rd('CONNECTOR_RUNTIME_TARA')),
      mcp: truthy(rd('CONNECTOR_RUNTIME_MCP')),
      sync: truthy(rd('CONNECTOR_RUNTIME_SYNC')),
      // admin/diagnostic access follows the master switch only
      admin: truthy(rd('CONNECTOR_RUNTIME_ENABLED')),
    },
    // empty set = every registered connector is allowed
    connectors: new Set(connectors),
  };
}

/**
 * Is the runtime allowed to serve `connectorId` on `surface`?
 * Master switch AND surface flag AND (connector allow-list empty OR includes id).
 */
export function isRuntimeAllowed(config, surface, connectorId) {
  if (!config || !config.enabled) return false;
  if (surface && !config.surfaces[surface]) return false;
  if (config.connectors.size > 0 && connectorId && !config.connectors.has(String(connectorId).toLowerCase())) return false;
  return true;
}
