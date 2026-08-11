import path from 'path';
import { fileURLToPath } from 'url';
import { MCPConnectorRegistry } from './registry.js';
import { MCPConnectorJobStore } from './job-store.js';
import { MCPConnectorRunner } from './runner.js';
import { getMcpAdapter } from './adapters/index.js';
import { enrichEndpointWithToken, createConnectSession, getConnectionId } from './nango-service.js';

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

function mcpHealthMode(endpoint) {
  // Catalog entries declare this explicitly. Custom endpoints are assumed to
  // be real MCP servers unless their owner opts out of status probing.
  return endpoint?.mcp_health || (endpoint?.mode === 'connect_only' ? 'not_applicable' : 'probe');
}

export class MCPIngestionService {
  constructor({
    ingestionPipeline,
    registryPath = DEFAULT_REGISTRY_PATH,
    jobStorePath = DEFAULT_JOB_STORE_PATH,
    runner = new MCPConnectorRunner(),
    db = null,
  } = {}) {
    this.ingestionPipeline = ingestionPipeline;
    this.registry = new MCPConnectorRegistry({ filePath: registryPath });
    this.jobStore = new MCPConnectorJobStore({ filePath: jobStorePath });
    this.runner = runner;
    this.db = db; // Prisma client for Nango token resolution
  }

  /**
   * Resolve Nango bearer token for an endpoint when requested with user scope.
   * No-op when no db or no nango_provider on endpoint.
   */
  async _resolveAuthenticatedEndpoint(endpoint, { user_id, org_id } = {}) {
    if (!this.db || !endpoint.nango_provider || !user_id) {
      return endpoint;
    }
    try {
      return await enrichEndpointWithToken(
        endpoint,
        { userId: user_id, orgId: org_id },
        { db: this.db },
      );
    } catch (err) {
      // Non-fatal — caller still gets unauthenticated endpoint;
      // the runner will fail with a clear auth error.
      console.warn(`[Nango] token resolution failed for ${endpoint.name}:`, err.message);
      return endpoint;
    }
  }

  async _connectionState(endpoint, { user_id, org_id } = {}) {
    if (endpoint.transport === 'internal') {
      const provider = endpoint.native_provider || endpoint.adapter_type;
      if (!this.db || !provider || !user_id) return 'unknown';
      const { ConnectorStore } = await import('../framework/connector-store.js');
      const token = await new ConnectorStore(this.db)
        .getAccessToken(user_id, provider)
        .catch(() => null);
      return token ? 'connected' : 'not_connected';
    }

    if (!endpoint.nango_provider) return 'not_required';
    if (!this.db || !user_id) return 'unknown';
    const connectionId = await getConnectionId(
      { userId: user_id, orgId: org_id, providerKey: endpoint.nango_provider },
      { db: this.db },
    );
    return connectionId ? 'connected' : 'not_connected';
  }

  registerEndpoint(endpoint) {
    return this.registry.upsert(endpoint);
  }

  listEndpoints(scope) {
    return this.registry.list(scope);
  }

  getEndpoint(name, scope) {
    // Alias fallback: rooms/callers use the bare provider id ("slack") while
    // the catalog ships suffixed entries ("slack-live"). Exact name wins so
    // per-tenant custom endpoints are never shadowed by the catalog.
    const endpoint = this.registry.get(name, scope) || this.registry.get(`${name}-live`, scope);
    if (!endpoint) {
      throw new Error(`Unknown MCP endpoint: ${name}`);
    }
    return endpoint;
  }

  /**
   * Health for transport:'internal' endpoints — tools are served in-process
   * by the native toolkit group (e.g. slack via SlackBridge), so there is no
   * external MCP server to inspect. Healthy ⇔ the user's native token
   * resolves (PlatformIntegration / Nango via ConnectorStore).
   */
  async _inspectInternal(endpoint, { user_id } = {}) {
    const provider = endpoint.native_provider || endpoint.adapter_type;
    // Tool specs live in code, not the (gitignored, box-patched) registry
    // file — static_tools in the data file is only a fallback for internal
    // providers without a native spec export.
    let tools = Array.isArray(endpoint.static_tools) ? endpoint.static_tools : [];
    if (provider === 'slack') {
      const { SLACK_TOOL_SPECS } = await import('../../agent/connector-toolkits/slack-tools.js');
      tools = SLACK_TOOL_SPECS;
    }
    if (!this.db || !provider || !user_id) {
      return { tools, resources: [], prompts: [] };
    }
    const { ConnectorStore } = await import('../framework/connector-store.js');
    const token = await new ConnectorStore(this.db)
      .getAccessToken(user_id, provider)
      .catch(() => null);
    if (!token) {
      throw new Error(`${provider} not connected — connect it from the Connectors page`);
    }
    return { tools, resources: [], prompts: [] };
  }

  async inspectEndpoint(name, scope) {
    const endpoint = this.getEndpoint(name, scope);
    if (endpoint.transport === 'internal') {
      const capabilities = await this._inspectInternal(endpoint, scope);
      return { endpoint, ...capabilities };
    }
    const authed = await this._resolveAuthenticatedEndpoint(endpoint, scope);
    const capabilities = await this.runner.inspect(authed);
    return {
      endpoint,
      ...capabilities,
    };
  }

  /**
   * Execute a single live tool/resource call on an endpoint (P3 bridge for
   * HyperAgents). Resolves the per-tenant Nango token, then runs it through
   * the transport runner. NOT for ingestion — that's ingestFromEndpoint.
   *
   * @param {string} name — endpoint name (e.g. "github", "notion")
   * @param {{ type:'tool'|'resource', name?:string, arguments?:object, uri?:string }} operation
   * @param {{ user_id?:string, org_id?:string }} scope
   * @returns {Promise<object>} raw MCP tool/resource result
   */
  async executeTool(name, operation, scope = {}) {
    if (!operation || !operation.type) {
      throw new Error('operation.type is required');
    }
    const endpoint = this.getEndpoint(name, scope);
    if (endpoint.transport === 'internal') {
      return this._executeInternal(endpoint, operation, scope);
    }
    const authed = await this._resolveAuthenticatedEndpoint(endpoint, scope);
    return this.runner.execute(authed, operation);
  }

  /**
   * Execute a tool on a transport:'internal' endpoint — served in-process by
   * the native toolkit group instead of an external MCP server. READ tools
   * only: the native executors reject write tools (draft-approval owns those).
   * Result is MCP-shaped ({content:[{type:'text',...}]}) so callers (the
   * HyperAgents engine parses exec results uniformly) see one format.
   */
  async _executeInternal(endpoint, operation, { user_id } = {}) {
    if (operation.type !== 'tool' || !operation.name) {
      throw new Error(`internal endpoint ${endpoint.name} only supports operation.type 'tool' with a name`);
    }
    const provider = endpoint.native_provider || endpoint.adapter_type;
    if (provider === 'slack') {
      if (!this.db) throw new Error('internal slack exec requires a db-backed service');
      const { ConnectorStore } = await import('../framework/connector-store.js');
      const { execSlackReadTool } = await import('../../agent/connector-toolkits/slack-tools.js');
      const result = await execSlackReadTool(
        operation.name,
        operation.arguments || {},
        { connectorStore: new ConnectorStore(this.db), userId: user_id },
      );
      return { content: [{ type: 'text', text: result?.text ?? String(result ?? '') }] };
    }
    throw new Error(`internal endpoint ${endpoint.name} has no native executor for provider '${provider}'`);
  }

  async listEndpointStatuses(scope) {
    const endpoints = this.listEndpoints(scope)
      .filter(endpoint => mcpHealthMode(endpoint) === 'probe');
    const jobs = this.jobStore.list(scope, { limit: 500 });
    const statuses = await Promise.all(endpoints.map(async endpoint => {
      const endpointJobs = jobs.filter(job => job.endpoint_name === endpoint.name);
      const summary = buildJobSummary(endpointJobs);
      const isInternal = endpoint.transport === 'internal';
      const checked_at = new Date().toISOString();

      let connectionState;
      try {
        connectionState = await this._connectionState(endpoint, scope);
      } catch (error) {
        return {
          name: endpoint.name,
          label: endpoint.label || endpoint.name,
          transport: endpoint.transport,
          adapter_type: endpoint.adapter_type || null,
          url: endpoint.url || null,
          updated_at: endpoint.updated_at || null,
          checked_at,
          state: 'error',
          healthy: false,
          tool_count: null,
          resource_count: null,
          prompt_count: null,
          ...summary,
          tools: [], resources: [], prompts: [],
          error: 'Connector connection state is unavailable',
        };
      }

      if (connectionState === 'not_connected') {
        return {
          name: endpoint.name,
          label: endpoint.label || endpoint.name,
          transport: endpoint.transport,
          adapter_type: endpoint.adapter_type || null,
          url: endpoint.url || null,
          updated_at: endpoint.updated_at || null,
          checked_at,
          state: 'not_connected',
          healthy: false,
          tool_count: null,
          resource_count: null,
          prompt_count: null,
          ...summary,
          tools: [], resources: [], prompts: [], error: null,
        };
      }

      const authed = isInternal ? endpoint : await this._resolveAuthenticatedEndpoint(endpoint, scope);

      try {
        const inspection = isInternal
          ? await this._inspectInternal(endpoint, scope)
          : await this.runner.inspect(authed);
        return {
          name: endpoint.name,
          label: endpoint.label || endpoint.name,
          transport: endpoint.transport,
          adapter_type: endpoint.adapter_type || null,
          url: endpoint.url || null,
          updated_at: endpoint.updated_at || null,
          checked_at,
          state: 'healthy',
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
          label: endpoint.label || endpoint.name,
          transport: endpoint.transport,
          adapter_type: endpoint.adapter_type || null,
          url: endpoint.url || null,
          updated_at: endpoint.updated_at || null,
          checked_at,
          state: 'error',
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
      unhealthy: statuses.filter(status => status.state === 'error').length,
      not_connected: statuses.filter(status => status.state === 'not_connected').length,
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

      const authedEndpoint = await this._resolveAuthenticatedEndpoint(
        endpoint,
        { user_id, org_id },
      );

      const result = await this.runner.execute(authedEndpoint, operation);
      const normalize = getMcpAdapter(selectedAdapter);
      const jobs = normalize(result, {
        endpoint: authedEndpoint,
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
          // Clone per-payload to prevent aliasing: a downstream mutation on one
          // payload's relationship (e.g. pushing to sourceIds) must not bleed
          // into sibling payloads that share the same object reference.
          payload.relationship = {
            ...relationship,
            ...(Array.isArray(relationship.sourceIds)
              ? { sourceIds: [...relationship.sourceIds] }
              : {}),
          };
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
