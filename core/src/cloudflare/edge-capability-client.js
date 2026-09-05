import { DEFAULT_EDGE_CAPABILITIES, resolveEdgeCapabilities, verifySignedEdgeEntitlement } from './edge-entitlement.js';

/**
 * Reads the optional Cloudflare control-plane state without making Cloudflare a
 * runtime dependency. Callers receive all-disabled capabilities whenever the
 * local kill switch, endpoint, credentials, signature, or network is invalid.
 */
export class EdgeCapabilityClient {
  constructor({ baseUrl = process.env.CLOUDFLARE_EDGE_CONTROL_URL, token = process.env.CLOUDFLARE_EDGE_CONTROL_TOKEN, publicKey = process.env.CLOUDFLARE_EDGE_ENTITLEMENT_PUBLIC_KEY, featureEnabled = process.env.CLOUDFLARE_EDGE_CONTROL_ENABLED === 'true', fetchImpl = globalThis.fetch, now = () => new Date(), timeoutMs = 2_000 } = {}) {
    this.baseUrl = baseUrl?.replace(/\/$/, '');
    this.token = token;
    this.publicKey = publicKey;
    this.featureEnabled = featureEnabled;
    this.fetch = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
  }

  async getCapabilities(organizationId) {
    if (!this.featureEnabled || !this.baseUrl || !this.token || !this.publicKey || !this.fetch) return { ...DEFAULT_EDGE_CAPABILITIES };
    try {
      const response = await this.fetch(`${this.baseUrl}/v1/control/organizations/${encodeURIComponent(organizationId)}/entitlement`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return { ...DEFAULT_EDGE_CAPABILITIES };
      const envelope = await response.json();
      const entitlement = verifySignedEdgeEntitlement({ envelope, organizationId, publicKey: this.publicKey, now: this.now() });
      return resolveEdgeCapabilities({ featureEnabled: this.featureEnabled, entitlement });
    } catch {
      return { ...DEFAULT_EDGE_CAPABILITIES };
    }
  }
}
