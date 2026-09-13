import crypto from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 30_000;

export function knowledgeWorkflowEnvironment() {
  // Rollout is decided by the tenant-scoped Cloudflare Flagship evaluation in
  // the Worker.  Core only needs the protected transport credentials.  Keeping
  // a second ENABLED/ENVIRONMENT acknowledgement here created split-brain
  // deployments where a Flagship-enabled tenant still silently used BullMQ.
  return requireConfig() ? 'cloudflare' : null;
}

export function knowledgeWorkflowEnabled() {
  return knowledgeWorkflowEnvironment() !== null;
}

function requireConfig() {
  const baseUrl = String(process.env.KNOWLEDGE_INGEST_WORKFLOW_URL || '').replace(/\/$/, '');
  const secret = String(process.env.KNOWLEDGE_INGEST_WORKFLOW_SECRET || '');
  if (!baseUrl || !secret) return null;
  return { baseUrl, secret };
}

export class CloudflareKnowledgeIngestClient {
  constructor({ fetchImpl = fetch, logger = console } = {}) {
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.mode = 'cloudflare_workflow';
  }

  configured() {
    return knowledgeWorkflowEnabled() && !!requireConfig();
  }

  async _request(pathname, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const config = requireConfig();
    if (!knowledgeWorkflowEnabled() || !config) {
      throw Object.assign(new Error('Cloudflare knowledge ingestion is not configured for this environment.'), {
        code: 'CLOUDFLARE_INGEST_DISABLED', retryable: false,
      });
    }
    const response = await this.fetchImpl(`${config.baseUrl}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${config.secret}`,
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response;
  }

  async isEnabled(orgId, userId) {
    if (!this.configured() || !orgId || !userId) return false;
    // Flagship targeting remains tenant-specific without exposing stable tenant
    // or user identifiers to Cloudflare. The workflow transport secret is also
    // the HMAC key, so the pseudonym cannot be reversed or correlated outside
    // this installation/environment.
    const { secret } = requireConfig();
    const targetingKey = crypto.createHmac('sha256', secret)
      .update(`${orgId}:${userId}`)
      .digest('hex');
    const response = await this._request(`/enabled?targeting_key=${targetingKey}`, { method: 'GET' }, 5000);
    if (!response.ok) throw Object.assign(
      new Error(`Cloudflare ingestion admission failed with HTTP ${response.status}`),
      { code: 'WORKFLOW_ADMISSION_UNAVAILABLE', retryable: true },
    );
    const body = await response.json();
    return body?.enabled === true;
  }

  async isAvailable({ orgId, userId } = {}) {
    return this.isEnabled(orgId, userId);
  }

  async enqueue({ trackerJobId, processingVersion }) {
    const response = await this._request('/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        job_id: trackerJobId,
        processing_version: Number(processingVersion) || 1,
        admitted: true,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(body?.error || `Workflow admission failed with HTTP ${response.status}`), {
        code: body?.code || 'WORKFLOW_ADMISSION_FAILED',
        retryable: response.status >= 500,
      });
    }
    return {
      job_id: trackerJobId,
      queue_job_id: body.instance_id || body.queue_message_id || `kb-${trackerJobId}-v${processingVersion}`,
      workflow_instance_id: body.instance_id || null,
    };
  }

  async getWorkflowStatus(instanceId) {
    if (!instanceId) return null;
    const response = await this._request(`/status?instance_id=${encodeURIComponent(instanceId)}`, { method: 'GET' }, 5000);
    if (response.status === 404) return { status: 'missing' };
    if (!response.ok) {
      throw Object.assign(new Error(`Workflow status unavailable with HTTP ${response.status}`), {
        code: 'WORKFLOW_STATUS_UNAVAILABLE', retryable: response.status >= 500,
      });
    }
    const body = await response.json().catch(() => null);
    const status = typeof body?.status === 'string' ? body.status : body?.status?.status;
    return status ? { status } : null;
  }

  async stats() {
    return {
      enabled: this.configured(),
      mode: this.mode,
      environment: knowledgeWorkflowEnvironment(),
      local_only: knowledgeWorkflowEnvironment() === 'local',
      degraded: false,
    };
  }

  async close() {}
}
