export interface Env {
  INSTALLATION: DurableObjectNamespace;
  ARTIFACTS: R2Bucket;
  LIFECYCLE: AnalyticsEngineDataset;
  PORTAL_SERVICE_TOKEN: string;
  ENROLLMENT_SIGNING_KEY: string;
  INSTALLATION_TOKEN_KEY: string;
  RELEASE_BASE_URL: string;
}

type EnrollmentRequest = {
  organization_id: string;
  installation_id: string;
  release_channel: 'canary' | 'stable';
  release_key: string;
  license_key: string;
  expires_at: string;
};

type LifecycleEvent = {
  state: 'issued' | 'redeemed' | 'installing' | 'connected' | 'degraded' | 'offline' | 'update_failed';
  release?: string;
  ready?: boolean;
  error_code?: string;
};

const contentFieldNames = new Set(['content', 'query', 'prompt', 'answer', 'document', 'embedding', 'memory', 'evidence', 'text']);

export class InstallationState implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/issue' && request.method === 'POST') return this.issue(await request.json<EnrollmentRequest>());
    if (path === '/redeem' && request.method === 'POST') return this.redeem(await request.json<{ enrollment_code: string }>());
    if (path === '/heartbeat' && request.method === 'POST') return this.heartbeat(request);
    if (path === '/status' && request.method === 'GET') return json(await this.publicStatus());
    return json({ error: 'not_found' }, 404);
  }

  private async issue(input: EnrollmentRequest): Promise<Response> {
    if (!input.organization_id || !input.installation_id || !input.release_key || !input.license_key || !isFuture(input.expires_at)) return json({ error: 'invalid_enrollment' }, 400);
    const existing = await this.state.storage.get<EnrollmentRequest>('enrollment');
    if (existing && existing.organization_id !== input.organization_id) return json({ error: 'installation_id_already_bound' }, 409);
    const nonce = randomToken(32);
    const code = await signCode(this.env.ENROLLMENT_SIGNING_KEY, `${input.installation_id}.${input.expires_at}.${nonce}`);
    await this.state.storage.put({ enrollment: input, enrollment_code_hash: await sha256(code), state: 'issued', nonce });
    return json({ enrollment_code: code, expires_at: input.expires_at });
  }

  private async redeem(input: { enrollment_code: string }): Promise<Response> {
    const enrollment = await this.state.storage.get<EnrollmentRequest>('enrollment');
    const expected = await this.state.storage.get<string>('enrollment_code_hash');
    const state = await this.state.storage.get<string>('state');
    if (!enrollment || !expected || state !== 'issued' || !isFuture(enrollment.expires_at) || !timingSafeEqual(expected, await sha256(input.enrollment_code || ''))) {
      return json({ error: 'invalid_or_expired_enrollment' }, 403);
    }
    const installation_token = await signCode(this.env.INSTALLATION_TOKEN_KEY, `${enrollment.installation_id}.${randomToken(32)}`);
    await this.state.storage.put({ state: 'redeemed', installation_token_hash: await sha256(installation_token), redeemed_at: new Date().toISOString() });
    return json({
      installation_token,
      installation_id: enrollment.installation_id,
      manifest_url: artifactUrl(this.env, `${enrollment.release_key}/release.json`),
      signature_url: artifactUrl(this.env, `${enrollment.release_key}/release.sig`),
      public_key_url: artifactUrl(this.env, `${enrollment.release_key}/release.pub`),
      license_url: artifactUrl(this.env, `${enrollment.license_key}/license.json`),
      license_signature_url: artifactUrl(this.env, `${enrollment.license_key}/license.sig`),
      status_url: `/v1/engine-box/enroll/${encodeURIComponent(enrollment.installation_id)}/status`,
    });
  }

  private async heartbeat(request: Request): Promise<Response> {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
    const expected = await this.state.storage.get<string>('installation_token_hash');
    if (!expected || !timingSafeEqual(expected, await sha256(token))) return json({ error: 'unauthorized_installation' }, 401);
    const input = await request.json<LifecycleEvent>();
    if (!validLifecycle(input)) return json({ error: 'invalid_content_free_lifecycle_event' }, 400);
    await this.state.storage.put({ state: input.state, last_heartbeat: new Date().toISOString(), lifecycle: input });
    const enrollment = await this.state.storage.get<EnrollmentRequest>('enrollment');
    this.env.LIFECYCLE.writeDataPoint({ indexes: [enrollment?.installation_id || 'unknown', input.state], blobs: [input.release || '', input.error_code || ''], doubles: [input.ready ? 1 : 0] });
    return json({ ok: true });
  }

  private async publicStatus() {
    const enrollment = await this.state.storage.get<EnrollmentRequest>('enrollment');
    const lifecycle = await this.state.storage.get<LifecycleEvent>('lifecycle');
    return enrollment ? { installation_id: enrollment.installation_id, organization_id: enrollment.organization_id, state: await this.state.storage.get('state'), last_heartbeat: await this.state.storage.get('last_heartbeat'), lifecycle } : { state: 'unknown' };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true });
    if (url.pathname === '/v1/engine-box/enroll' && request.method === 'POST') {
      if (!portalAuthorized(request, env)) return json({ error: 'portal_authorization_required' }, 401);
      const input = await request.json<EnrollmentRequest>();
      const id = env.INSTALLATION.idFromName(input.installation_id);
      return env.INSTALLATION.get(id).fetch('https://installation.internal/issue', { method: 'POST', body: JSON.stringify(input) });
    }
    if (url.pathname === '/v1/engine-box/bootstrap' && request.method === 'POST') {
      const input = await request.json<{ enrollment_code: string }>();
      // The signed code starts with its opaque installation ID. Redemption is
      // still single-use because the Durable Object compares its stored hash.
      const installationId = String(input.enrollment_code || '').split('.', 1)[0];
      if (!installationId) return json({ error: 'installation_id_required' }, 400);
      const id = env.INSTALLATION.idFromName(installationId);
      return env.INSTALLATION.get(id).fetch('https://installation.internal/redeem', { method: 'POST', body: JSON.stringify(input) });
    }
    const match = url.pathname.match(/^\/v1\/engine-box\/enroll\/([^/]+)\/status$/);
    if (match && request.method === 'GET') return env.INSTALLATION.get(env.INSTALLATION.idFromName(decodeURIComponent(match[1]))).fetch('https://installation.internal/status');
    if (url.pathname === '/v1/engine-box/heartbeat' && request.method === 'POST') {
      const installationId = request.headers.get('x-engine-box-installation-id');
      if (!installationId) return json({ error: 'installation_id_required' }, 400);
      return env.INSTALLATION.get(env.INSTALLATION.idFromName(installationId)).fetch('https://installation.internal/heartbeat', request);
    }
    return json({ error: 'not_found' }, 404);
  },
};

function portalAuthorized(request: Request, env: Env) { return request.headers.get('x-engine-box-portal-token') === env.PORTAL_SERVICE_TOKEN; }
function validLifecycle(event: LifecycleEvent) { return !!event && typeof event.state === 'string' && ['issued', 'redeemed', 'installing', 'connected', 'degraded', 'offline', 'update_failed'].includes(event.state) && !Object.keys(event).some((key) => contentFieldNames.has(key)); }
function isFuture(value: string) { const timestamp = Date.parse(value); return Number.isFinite(timestamp) && timestamp > Date.now(); }
function artifactUrl(env: Env, key: string) { return `${env.RELEASE_BASE_URL.replace(/\/$/, '')}/${key}`; }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }); }
function randomToken(bytes: number) { const values = crypto.getRandomValues(new Uint8Array(bytes)); return btoa(String.fromCharCode(...values)).replace(/[+/=]/g, ''); }
async function sha256(value: string) { const bytes = new TextEncoder().encode(value); const hash = await crypto.subtle.digest('SHA-256', bytes); return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(''); }
async function signCode(key: string, value: string) { const cryptoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(value)); return `${value}.${Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('')}`; }
function timingSafeEqual(left: string, right: string) { if (left.length !== right.length) return false; let value = 0; for (let index = 0; index < left.length; index += 1) value |= left.charCodeAt(index) ^ right.charCodeAt(index); return value === 0; }
