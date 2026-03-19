import path from 'path';
import { fileURLToPath } from 'url';
import { MCPConnectorRegistry } from './registry.js';
import { MCPConnectorJobStore } from './job-store.js';
import { MCPConnectorRunner } from './runner.js';
import { getMcpAdapter } from './adapters/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY_PATH = path.join(__dirname, '../../../data/mcp-connectors.json');
const DEFAULT_JOB_STORE_PATH = path.join(__dirname, '../../../data/mcp-connector-jobs.json');

function buildJobSummary(jobs = []) {
  const counts = jobs.reduce((acc, job) => {
    const status = job.status || 'unknown';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});

  const latestJob = jobs[0] || null;
  const lastSuccess = jobs.find(job => job.status === 'queued' || job.status === 'completed') || null;
  const lastFailure = jobs.find(job => job.status === 'failed') || null;
  const failedCount = counts.failed || 0;
  const total = jobs.length;
  const healthGrade = total === 0
    ? 'idle'
    : failedCount === 0
      ? 'healthy'
      : failedCount === total
        ? 'degraded'
        : 'warning';

  return {
    total_jobs: total,
    pending_jobs: counts.pending || 0,
    running_jobs: counts.running || 0,
    queued_jobs: counts.queued || 0,
    completed_jobs: counts.completed || 0,
    failed_jobs: failedCount,
    replayable_jobs: counts.queued || 0,
    retryable_jobs: failedCount,
    last_job_status: latestJob?.status || null,
    last_job_at: latestJob?.updated_at || null,
    last_success_at: lastSuccess?.updated_at || null,
    last_failure_at: lastFailure?.updated_at || null,
    last_error: lastFailure?.error || null,
    health_grade: healthGrade,
  };
}

export class MCPIngestionService {
  constructor({
    ingestionPipeline,
    registryPath = DEFAULT_REGISTRY_PATH,
    jobStorePath = DEFAULT_JOB_STORE_PATH,
    runner = new MCPConnectorRunner()
  } = {}) {
    this.ingestionPipeline = ingestionPipeline;
    this.registry = new MCPConnectorRegistry({ filePath: registryPath });
    this.jobStore = new MCPConnectorJobStore({ filePath: jobStorePath });
    this.runner = runner;
  }

  registerEndpoint(endpoint) {
    return this.registry.upsert(endpoint);
  }

  listEndpoints(scope) {
    return this.registry.list(scope);
  }

  getEndpoint(name, scope) {
    const endpoint = this.registry.get(name, scope);
    if (!endpoint) {
      throw new Error(`Unknown MCP endpoint: ${name}`);
    }
    return endpoint;
  }

  async inspectEndpoint(name, scope) {
    const endpoint = this.getEndpoint(name, scope);
    const capabilities = await this.runner.inspect(endpoint);
    return {
      endpoint,
      ...capabilities,
    };
  }

  async listEndpointStatuses(scope) {
    const endpoints = this.listEndpoints(scope);
    const jobs = this.jobStore.list(scope, { limit: 500 });
    const statuses = await Promise.all(endpoints.map(async endpoint => {
      const endpointJobs = jobs.filter(job => job.endpoint_name === endpoint.name);
      const summary = buildJobSummary(endpointJobs);

      try {
        const inspection = await this.runner.inspect(endpoint);
        return {
          name: endpoint.name,
          transport: endpoint.transport,
          adapter_type: endpoint.adapter_type || null,
          url: endpoint.url || null,
          updated_at: endpoint.updated_at || null,
          healthy: true,
          tool_count: inspection.tools?.length || 0,
          resource_count: inspection.resources?.length || 0,
          prompt_count: inspection.prompts?.length || 0,
          ...summary,
          tools: inspection.tools || [],
          resources: inspection.resources || [],
          prompts: inspection.prompts || [],
          error: null
        };
      } catch (error) {
        return {
          name: endpoint.name,
          transport: endpoint.transport,
          adapter_type: endpoint.adapter_type || null,
          url: endpoint.url || null,
          updated_at: endpoint.updated_at || null,
          healthy: false,
          tool_count: 0,
          resource_count: 0,
          prompt_count: 0,
          ...summary,
          tools: [],
          resources: [],
          prompts: [],
          error: error.message
        };
      }
    }));

    return {
      total: statuses.length,
      healthy: statuses.filter(status => status.healthy).length,
      unhealthy: statuses.filter(status => !status.healthy).length,
      statuses
    };
  }

  listJobs(scope, options = {}) {
    return this.jobStore.list(scope, options).map(job => ({
      ...job,
      can_retry: job.status === 'failed',
      can_replay: job.status === 'queued' || job.status === 'completed',
    }));
  }

  getJob(jobId, scope) {
    const job = this.jobStore.get(jobId, scope);
    if (!job) {
      throw new Error(`Unknown MCP connector job: ${jobId}`);
    }
    return {
      ...job,
      can_retry: job.status === 'failed',
      can_replay: job.status === 'queued' || job.status === 'completed',
    };
  }

  async retryJob(jobId, scope, { replay = false } = {}) {
    const existing = this.getJob(jobId, scope);
    if (!replay && existing.status !== 'failed') {
      throw new Error('Only failed jobs can be retried');
    }

    return this.ingestFromEndpoint({
      endpoint_name: existing.endpoint_name,
      operation: existing.operation,
      adapter: existing.adapter,
      user_id: existing.user_id,
      org_id: existing.org_id,
      project: existing.project || null,
      tags: existing.tags || [],
      relationship: existing.relationship || null,
      replay_of: replay ? existing.id : null,
      retry_of: replay ? null : existing.id
    });
  }

  async ingestFromEndpoint({
    endpoint_name,
    operation,
    adapter,
    user_id,
    org_id,
    project = null,
    tags = [],
    relationship = null,
    retry_of = null,
    replay_of = null
  }) {
    if (!this.ingestionPipeline) {
      throw new Error('Ingestion pipeline unavailable');
    }

    const endpoint = this.getEndpoint(endpoint_name, { user_id, org_id });
    const selectedAdapter = adapter || endpoint.adapter_type;
    if (!selectedAdapter) {
      throw new Error('adapter or endpoint.adapter_type is required');
    }

    const orchestrationJob = this.jobStore.create({
      endpoint_name,
      adapter: selectedAdapter,
      operation,
      operation_type: operation?.type || null,
      project,
      tags,
      relationship,
      retry_of,
      replay_of,
      user_id,
      org_id
    });

    try {
      this.jobStore.update(orchestrationJob.id, {
        status: 'running',
        started_at: new Date().toISOString(),
        attempt_count: (orchestrationJob.attempt_count || 0) + 1
      });

      const result = await this.runner.execute(endpoint, operation);
      const normalize = getMcpAdapter(selectedAdapter);
      const jobs = normalize(result, {
        endpoint,
        operation,
        user_id,
        org_id,
        project,
        tags,
        relationship,
      });

      const accepted = [];
      for (const payload of jobs) {
        if (relationship && !payload.relationship) {
          payload.relationship = relationship;
        }
        const queued = await this.ingestionPipeline.ingest(payload);
        accepted.push({
          jobId: queued.jobId,
          source_type: payload.source_type,
          source_id: payload.source_id || null,
          project: payload.project || null,
          relationship_type: payload.relationship?.type || null,
        });
      }

      const updated = this.jobStore.update(orchestrationJob.id, {
        status: accepted.length > 0 ? 'queued' : 'completed',
        accepted_jobs: accepted,
        accepted_job_count: accepted.length,
        raw_result: result,
        completed_at: new Date().toISOString(),
      });

      return {
        job_id: updated.id,
        endpoint_name,
        adapter: selectedAdapter,
        accepted_jobs: accepted,
        raw_result: result,
        status: updated.status,
      };
    } catch (error) {
      const updated = this.jobStore.update(orchestrationJob.id, {
        status: 'failed',
        error: error.message,
        failed_at: new Date().toISOString(),
      });

      error.connectorJobId = updated?.id || orchestrationJob.id;
      throw error;
    }
  }
}
