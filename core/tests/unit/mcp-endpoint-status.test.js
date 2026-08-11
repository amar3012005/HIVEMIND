import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MCPIngestionService } from '../../src/connectors/mcp/service.js';

function serviceWithStatusRunner({ db, runner }) {
  const suffix = crypto.randomUUID();
  return new MCPIngestionService({
    ingestionPipeline: { async ingest() { return { jobId: 'unused' }; } },
    registryPath: `/tmp/hivemind-mcp-endpoints-${suffix}.json`,
    jobStorePath: `/tmp/hivemind-mcp-jobs-${suffix}.json`,
    db,
    runner,
  });
}

test('MCP status excludes OAuth-only REST mappings and skips disconnected endpoints', async () => {
  const user_id = crypto.randomUUID();
  const org_id = crypto.randomUUID();
  let inspections = 0;
  const service = serviceWithStatusRunner({
    db: {
      nangoConnection: {
        async findFirst({ where }) {
          return where.providerKey === 'connected-mcp' ? { connectionId: 'connected-1' } : null;
        },
      },
    },
    runner: {
      async inspect() {
        inspections += 1;
        return { tools: [{ name: 'search' }], resources: [], prompts: [] };
      },
    },
  });

  service.registerEndpoint({
    name: 'gmail-rest-mapping', user_id, org_id,
    mode: 'connect_only', mcp_health: 'not_applicable',
    transport: 'streamable-http', url: 'https://gmail.googleapis.com',
    nango_provider: 'gmail',
  });
  service.registerEndpoint({
    name: 'disconnected-mcp', user_id, org_id,
    mcp_health: 'probe', transport: 'streamable-http',
    url: 'https://mcp.example.test', nango_provider: 'not-connected',
  });
  service.registerEndpoint({
    name: 'connected-mcp', user_id, org_id,
    mcp_health: 'probe', transport: 'streamable-http',
    url: 'https://mcp.connected.test', nango_provider: 'connected-mcp',
  });
  service._resolveAuthenticatedEndpoint = async endpoint => endpoint;

  const result = await service.listEndpointStatuses({ user_id, org_id });

  assert.equal(result.total, 2);
  assert.equal(result.healthy, 1);
  assert.equal(result.unhealthy, 0);
  assert.equal(result.not_connected, 1);
  assert.equal(inspections, 1);
  assert.equal(result.statuses.find(item => item.name === 'gmail-rest-mapping'), undefined);
  assert.equal(result.statuses.find(item => item.name === 'disconnected-mcp').state, 'not_connected');
  assert.equal(result.statuses.find(item => item.name === 'disconnected-mcp').error, null);
  assert.equal(result.statuses.find(item => item.name === 'connected-mcp').state, 'healthy');
});
