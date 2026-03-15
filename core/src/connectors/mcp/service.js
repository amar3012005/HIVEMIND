import path from 'path';
import { fileURLToPath } from 'url';
import { MCPConnectorRegistry } from './registry.js';
import { MCPConnectorRunner } from './runner.js';
import { getMcpAdapter } from './adapters/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY_PATH = path.join(__dirname, '../../../data/mcp-connectors.json');

export class MCPIngestionService {
  constructor({ ingestionPipeline, registryPath = DEFAULT_REGISTRY_PATH, runner = new MCPConnectorRunner() } = {}) {
    this.ingestionPipeline = ingestionPipeline;
    this.registry = new MCPConnectorRegistry({ filePath: registryPath });
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

  async ingestFromEndpoint({ endpoint_name, operation, adapter, user_id, org_id, project = null, tags = [], relationship = null }) {
    if (!this.ingestionPipeline) {
      throw new Error('Ingestion pipeline unavailable');
    }

    const endpoint = this.getEndpoint(endpoint_name, { user_id, org_id });
    const selectedAdapter = adapter || endpoint.adapter_type;
    if (!selectedAdapter) {
      throw new Error('adapter or endpoint.adapter_type is required');
    }

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

    return {
      endpoint_name,
      adapter: selectedAdapter,
      accepted_jobs: accepted,
      raw_result: result,
    };
  }
}
