// Connector Runtime V1 — the single connector/tool registry.
//
// One registry holds every plugin. It resolves a canonical tool name to
// { plugin, tool }, and translates legacy tool names (gmail_search,
// gmail_send_email, gmail_send, ...) to canonical ones INBOUND ONLY during
// migration (plan §3 "Aliases may translate legacy names ... but only canonical
// names appear in new catalogs").
//
// This is what structurally prevents "one surface exposes a tool another
// surface cannot execute" (Phase 0 §0) — there is exactly one catalog.

import { ManifestError } from './errors.js';
import { TOOL_NAME_RE } from './contracts.js';

export class ConnectorRegistry {
  constructor() {
    /** @type {Map<string, import('./connector-plugin.js').ConnectorPlugin>} */
    this._plugins = new Map();
    /** canonical tool name -> connector id */
    this._toolIndex = new Map();
    /** legacy name -> canonical name (inbound alias) */
    this._aliases = new Map();
  }

  /** Register a plugin. Throws on duplicate connector id or tool-name clash. */
  register(plugin) {
    const id = plugin?.manifest?.id;
    if (!id) throw new ManifestError('plugin has no manifest.id');
    if (this._plugins.has(id)) throw new ManifestError(`connector "${id}" already registered`);
    for (const tool of plugin.manifest.tools) {
      if (this._toolIndex.has(tool.name)) {
        throw new ManifestError(`tool name "${tool.name}" already registered by "${this._toolIndex.get(tool.name)}"`);
      }
    }
    this._plugins.set(id, plugin);
    for (const tool of plugin.manifest.tools) {
      this._toolIndex.set(tool.name, id);
      // Auto-register the declared legacy name as an inbound alias.
      if (tool.legacyName) this.registerAlias(tool.legacyName, tool.name);
    }
    return this;
  }

  /** Map a legacy tool name to a canonical one (inbound translation only). */
  registerAlias(legacyName, canonicalName) {
    if (!legacyName || !canonicalName) return this;
    if (!TOOL_NAME_RE.test(canonicalName)) {
      throw new ManifestError(`alias target "${canonicalName}" is not a canonical name`);
    }
    const existing = this._aliases.get(legacyName);
    if (existing && existing !== canonicalName) {
      throw new ManifestError(`alias "${legacyName}" already maps to "${existing}"`);
    }
    this._aliases.set(legacyName, canonicalName);
    return this;
  }

  /** Resolve a possibly-legacy name to its canonical form. */
  toCanonical(name) {
    if (this._toolIndex.has(name)) return name; // already canonical
    return this._aliases.get(name) || name;
  }

  hasConnector(id) {
    return this._plugins.has(id);
  }

  getPlugin(id) {
    return this._plugins.get(id) || null;
  }

  listConnectors() {
    return [...this._plugins.values()];
  }

  /**
   * Resolve a canonical (or legacy) tool name to { plugin, tool, canonicalName }.
   * Returns null if unknown.
   */
  resolveTool(name) {
    const canonicalName = this.toCanonical(name);
    const connectorId = this._toolIndex.get(canonicalName);
    if (!connectorId) return null;
    const plugin = this._plugins.get(connectorId);
    const tool = plugin?.getTool(canonicalName);
    if (!plugin || !tool) return null;
    return { plugin, tool, canonicalName, connectorId };
  }
}
