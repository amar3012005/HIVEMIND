// Connector Runtime V1 — shared base for the Google family (docs, sheets, …).
//
// These providers all execute through the ONE existing implementation
// `runGoogleTool` (google-native.js, direct Google REST), so a thin shared base
// wraps it: canonical→legacy name map, caller-scoped identity, result shaping,
// and the same error mapping the Gmail plugin uses. Each provider stays its own
// small script (plugins/<id>/index.js) that just supplies a manifest + map —
// NOT a monolith. The provider executor is injectable for tests.

import { ConnectorPlugin } from '../connector-plugin.js';
import { makeResult, jsonContent } from '../contracts.js';
import { NotConnectedError, ReauthRequiredError, classifyError } from '../errors.js';
import { runGoogleTool as realRunGoogleTool } from '../../google-native.js';

export class GoogleFamilyPlugin extends ConnectorPlugin {
  /**
   * @param {object} manifest validated by ConnectorPlugin
   * @param {Record<string,string>} toolMap canonical tool name → legacy runGoogleTool name
   * @param {object} [deps] { execGoogleTool, sourceIdsFor }
   */
  constructor(manifest, toolMap, deps = {}) {
    super(manifest);
    this._map = toolMap;
    this._exec = deps.execGoogleTool || realRunGoogleTool;
    this._sourceIdsFor = deps.sourceIdsFor || (() => []);
  }

  async executeTool(toolName, input, context) {
    const legacy = this._map[toolName];
    if (!legacy) throw new NotConnectedError(`${this.id} tool "${toolName}" is not implemented`);
    const scope = { user_id: context.userId, org_id: context.orgId };
    let payload;
    try {
      payload = await this._exec(legacy, input || {}, scope, context.db);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not connected/i.test(msg)) throw new NotConnectedError(`${this.manifest.displayName} is not connected for this user`, { provider: this.id });
      if (/\b401\b/.test(msg) || /invalid_grant|expired/i.test(msg)) throw new ReauthRequiredError(`${this.manifest.displayName} requires re-authorization`, { provider: this.id });
      throw classifyError(err);
    }
    return makeResult({
      status: 'completed',
      content: jsonContent(payload),
      metadata: { sourceIds: this._sourceIdsFor(toolName, payload || {}) },
    });
  }
}

// Helpers to build read/write tool contracts consistently across the family.
export function googleRead(name, description, inputSchema, legacyName, extra = {}) {
  return {
    name, title: name, description, inputSchema,
    access: 'read', approval: 'never',
    concurrencySafe: true, idempotent: true, destructive: false, openWorld: false,
    timeoutMs: 8000, maxResultBytes: 32 * 1024,
    allowedSurfaces: ['chat', 'hyperagents', 'tara', 'mcp', 'admin'],
    legacyName, ...extra,
  };
}
export function googleWrite(name, description, inputSchema, legacyName, { destructive = false } = {}) {
  return {
    name, title: name, description, inputSchema,
    access: 'write', approval: 'required',
    concurrencySafe: false, idempotent: false, destructive, openWorld: false,
    timeoutMs: 15000, maxResultBytes: 8 * 1024,
    allowedSurfaces: ['chat', 'hyperagents', 'mcp', 'admin'],
    legacyName,
  };
}
