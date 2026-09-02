import crypto from "crypto";

const MODES = new Set(["off", "shadow", "dual_write", "authoritative"]);
export function platformRegistryMode(
  value = process.env.PLATFORM_REGISTRY_MODE,
) {
  return MODES.has(value) ? value : "off";
}
export function registryEventId() {
  return crypto.randomUUID();
}
export function hashInviteToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}
export class PlatformRegistryClient {
  constructor({
    baseUrl = process.env.PLATFORM_REGISTRY_URL,
    secret = process.env.PLATFORM_REGISTRY_ADMISSION_SECRET,
    mode = platformRegistryMode(),
    fetchImpl = fetch,
  } = {}) {
    this.baseUrl = baseUrl?.replace(/\/$/, "");
    this.secret = secret;
    this.mode = mode;
    this.fetch = fetchImpl;
  }
  get enabled() {
    return this.mode !== "off" && Boolean(this.baseUrl && this.secret);
  }
  async mirror(event) {
    if (!this.enabled) return { skipped: true, reason: "disabled" };
    const response = await this.fetch(
      `${this.baseUrl}/internal/v1/registry/events`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(5000),
      },
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(
        String(result.error || `platform_registry_${response.status}`),
      );
      error.retryable = response.status >= 500;
      throw error;
    }
    return result;
  }
}
