// Connector Runtime V1 — ConnectorPlugin base class.
//
// One plugin per provider (plan §11 "one plugin per provider"). A plugin owns:
//   - a validated manifest (canonical tools),
//   - connection resolution (delegates to existing ConnectorStore/Nango),
//   - executeTool (wraps the ONE existing execution implementation),
//   - optional sync() (wraps the existing fetcher; plan §5 Ingestion).
//
// The base class provides manifest storage + default listTools; subclasses
// implement getConnection + executeTool (+ sync). Keeping this thin means each
// connector is its own small script under plugins/<id>/ — NOT a monolith.

import { validateManifest } from './contracts.js';

export class ConnectorPlugin {
  /** @param {import('./contracts.js').ConnectorManifest} manifest */
  constructor(manifest) {
    // Validate at construction — a malformed manifest fails fast at boot, not
    // at first tool call.
    this.manifest = validateManifest(manifest);
    this.id = this.manifest.id;
    this._toolsByName = new Map(this.manifest.tools.map((t) => [t.name, t]));
  }

  /** Canonical tool contract by name, or null. */
  getTool(name) {
    return this._toolsByName.get(name) || null;
  }

  /**
   * Tools visible for this context. Default: manifest tools filtered by the
   * caller's surface. Plugins may override to hide tools per connection state.
   * @returns {Promise<import('./contracts.js').CanonicalConnectorTool[]>}
   */
  async listTools(context) {
    const surface = context?.surface;
    return this.manifest.tools.filter((t) => !surface || t.allowedSurfaces.includes(surface));
  }

  /**
   * Resolve the active connection for this principal. Return a ConnectionState
   * or throw NotConnectedError/ReauthRequiredError. Base returns a minimal
   * "assume connected" state — providers that need a token override this.
   * @returns {Promise<{connected:boolean, connectionId?:string}>}
   */
  // eslint-disable-next-line no-unused-vars
  async getConnection(context) {
    return { connected: true };
  }

  /**
   * Execute one canonical tool. MUST return a CanonicalConnectorResult or throw
   * a ConnectorError. The runtime pipeline handles validation/approval/timeout
   * around this — the plugin only performs the provider call + normalization.
   * @returns {Promise<import('./contracts.js').CanonicalConnectorResult>}
   */
  // eslint-disable-next-line no-unused-vars
  async executeTool(toolName, input, context) {
    throw new Error(`${this.id}: executeTool not implemented`);
  }

  /** Whether this plugin supports background sync. */
  get canSync() {
    return typeof this.sync === 'function' && this.manifest.syncMode !== 'none';
  }
}
