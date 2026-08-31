import { safeUploadFilename } from './upload-contract.js';

const DEFAULT_TIMEOUT_MS = 30_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function knowledgeWorkflowEnvironment() {
  if (process.env.KNOWLEDGE_INGEST_WORKFLOW_ENABLED !== 'true') return null;
  const requested = String(process.env.KNOWLEDGE_INGEST_WORKFLOW_ENVIRONMENT || '').trim().toLowerCase();
  const localMode = process.env.HIVEMIND_LOCAL_MODE === 'true';
  if ((requested === '' || requested === 'local') && localMode) return 'local';
  if (requested === 'production'
    && !localMode
    && process.env.NODE_ENV === 'production'
    && process.env.KNOWLEDGE_INGEST_PRODUCTION_ACK === 'enable-cloudflare-workflow-v1') {
    return 'production';
  }
  return null;
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
    const response = await this._request(`/enabled?org_id=${encodeURIComponent(orgId)}&user_id=${encodeURIComponent(userId)}`, { method: 'GET' }, 5000);
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

  async persistFile({ orgId, checksum, filename, fileBuffer }) {
    const safeName = safeUploadFilename(filename);
    const objectKey = `org/${orgId}/sha256/${checksum}/${encodeURIComponent(safeName)}`;
    const attempts = Math.max(1, Number(process.env.KNOWLEDGE_INGEST_SOURCE_UPLOAD_ATTEMPTS || 3));
    const timeoutMs = Math.max(30_000, Number(process.env.KNOWLEDGE_INGEST_SOURCE_UPLOAD_TIMEOUT_MS || 300_000));
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this._request(`/objects/${objectKey}`, {
          method: 'PUT',
          headers: {
            'content-type': 'application/octet-stream',
            'x-hivemind-sha256': checksum,
            'x-hivemind-filename': encodeURIComponent(safeName),
          },
          body: fileBuffer,
        }, timeoutMs);
        const body = await response.json().catch(() => ({}));
        if (response.ok && body?.key) return { objectKey: body.key, etag: body.etag || null };
        lastError = Object.assign(new Error(body?.error || `R2 source upload failed with HTTP ${response.status}`), {
          code: 'SOURCE_OBJECT_STORE_FAILED', retryable: response.status >= 500,
        });
        if (!lastError.retryable) throw lastError;
      } catch (error) {
        lastError = Object.assign(error instanceof Error ? error : new Error(String(error)), {
          code: 'SOURCE_OBJECT_STORE_FAILED',
          retryable: error?.retryable !== false,
        });
        if (!lastError.retryable) throw lastError;
      }
      if (attempt < attempts) await sleep(Math.min(5000, 500 * (2 ** (attempt - 1))));
    }
    throw lastError || Object.assign(new Error('R2 source upload failed'), {
      code: 'SOURCE_OBJECT_STORE_FAILED', retryable: true,
    });
  }

  async enqueue({ userId, orgId, trackerJobId, processingVersion }) {
    const response = await this._request('/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        job_id: trackerJobId,
        org_id: orgId,
        user_id: userId,
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
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    return body?.status || null;
  }

  async getObject(objectKey, { expectedEtag = null } = {}) {
    if (!objectKey) throw Object.assign(new Error('Source object key is missing.'), { code: 'SOURCE_OBJECT_MISSING' });
    const response = await this._request(`/objects/${objectKey}`, { method: 'GET' }, 120_000);
    if (!response.ok) {
      throw Object.assign(new Error(`Source object read failed with HTTP ${response.status}`), {
        code: response.status === 404 ? 'SOURCE_OBJECT_MISSING' : 'SOURCE_OBJECT_READ_FAILED',
        retryable: response.status >= 500,
      });
    }
    const actualEtag = String(response.headers.get('etag') || '').replace(/^W\//, '').replace(/^"|"$/g, '');
    const wantedEtag = String(expectedEtag || '').replace(/^W\//, '').replace(/^"|"$/g, '');
    if (wantedEtag && actualEtag && actualEtag !== wantedEtag) {
      throw Object.assign(new Error('Durable source object ETag does not match admission.'), {
        code: 'SOURCE_OBJECT_INTEGRITY_FAILED', retryable: false,
      });
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async deleteObject(objectKey) {
    if (!objectKey) return;
    await this._request(`/objects/${objectKey}`, { method: 'DELETE' }).catch(() => null);
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
