#!/usr/bin/env node
/**
 * HIVE-MIND MCP Bridge CLI
 *
 * Fixes:
 * 1) Uses official MCP stdio transport instead of ad-hoc newline JSON parsing.
 * 2) Calls hosted MCP JSON-RPC endpoint from server descriptor (connection.endpoints.jsonrpc).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
  ReadResourceRequestSchema,
  GetPromptRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

interface BridgeConfig {
  mode: 'hosted' | 'local';
  apiUrl: string;
  apiKey?: string;
  userId: string;
  connectionToken?: string;
  verbose: boolean;
}

interface HostedDescriptor {
  mcp?: {
    protocolVersion?: string;
    serverInfo?: { name?: string; version?: string };
    capabilities?: Record<string, unknown>;
  };
  tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  resources?: Array<Record<string, unknown>>;
  prompts?: Array<Record<string, unknown>>;
  connection?: {
    token?: string;
    baseUrl?: string;
    orgId?: string;
    endpoints?: {
      jsonrpc?: string;
    };
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
let packageVersion = '2.0.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8')) as { version?: string };
  packageVersion = pkg.version || packageVersion;
} catch {
  // Keep fallback version
}

function parseArgs(): Partial<BridgeConfig> {
  const args = process.argv.slice(2);
  const config: Partial<BridgeConfig> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case 'hosted':
      case '--hosted':
        config.mode = 'hosted';
        break;
      case 'local':
      case '--local':
        config.mode = 'local';
        break;
      case '--url':
        config.apiUrl = args[++i];
        break;
      case '--api-key':
        config.apiKey = args[++i];
        break;
      case '--user-id':
        config.userId = args[++i];
        break;
      case '--token':
        config.connectionToken = args[++i];
        break;
      case '-v':
      case '--verbose':
        config.verbose = true;
        break;
      case '--version':
        console.log(`@amar_528/mcp-bridge v${packageVersion}`);
        process.exit(0);
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return config;
}

function printHelp() {
  console.log(`
HIVE-MIND MCP Bridge v${packageVersion}
Connect MCP clients to sovereign EU HIVE-MIND hosted service

USAGE:
  npx @amar_528/mcp-bridge [mode] [options]

MODES:
  hosted    Connect to hosted HIVE-MIND API (default)
  local     Connect to local development server

OPTIONS:
  --url <url>         Base API URL or full hosted descriptor URL
  --api-key <key>     API key (for descriptor fetch)
  --user-id <id>      User ID (UUID)
  --token <token>     MCP connection token (optional override)
  --verbose, -v       Enable verbose logs
  --version           Show version
  --help, -h          Show help
`);
}

function generateUserId(): string {
  return randomUUID();
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function isHostedDescriptorUrl(url: string): boolean {
  return /\/api\/mcp\/servers\/[^/?#]+(?:\?.*)?$/i.test(url);
}

function stripQueryAndHash(url: string): string {
  return url.split(/[?#]/, 1)[0];
}

function loadConfig(): BridgeConfig {
  const cli = parseArgs();
  const mode = cli.mode || 'hosted';
  const verbose = cli.verbose || false;

  if (mode === 'hosted') {
    const apiUrl = cli.apiUrl || process.env.HIVEMIND_API_URL || process.env.HIVEMIND_HOSTED_URL || 'https://core.hivemind.davinciai.eu:8050';
    const apiKey = cli.apiKey || process.env.HIVEMIND_API_KEY || process.env.HIVEMIND_MASTER_API_KEY;
    const userId = cli.userId || process.env.HIVEMIND_USER_ID || process.env.CURRENT_USER_ID || generateUserId();
    const connectionToken = cli.connectionToken || process.env.HIVEMIND_CONNECTION_TOKEN;

    if (!isHostedDescriptorUrl(apiUrl) && !apiKey) {
      console.error('ERROR: Hosted mode requires HIVEMIND_API_KEY when --url is a base API URL');
      process.exit(1);
    }

    return { mode, apiUrl, apiKey, userId, connectionToken, verbose };
  }

  const apiUrl = cli.apiUrl || process.env.HIVEMIND_LOCAL_URL || 'http://localhost:3000';
  const apiKey = cli.apiKey || process.env.HIVEMIND_API_KEY;
  const userId = cli.userId || process.env.HIVEMIND_USER_ID || '00000000-0000-4000-8000-000000000001';
  const connectionToken = cli.connectionToken || process.env.HIVEMIND_CONNECTION_TOKEN;
  return { mode, apiUrl, apiKey, userId, connectionToken, verbose };
}

function log(config: BridgeConfig, message: string): void {
  if (config.verbose) {
    console.error(`[HIVE-MIND Bridge] ${message}`);
  }
}

function getDescriptorUrl(config: BridgeConfig): string {
  if (isHostedDescriptorUrl(config.apiUrl)) {
    return config.apiUrl;
  }
  return `${normalizeBaseUrl(config.apiUrl)}/api/mcp/servers/${config.userId}`;
}

async function fetchDescriptor(config: BridgeConfig): Promise<HostedDescriptor> {
  const url = getDescriptorUrl(config);
  const headers: Record<string, string> = {};

  if (config.apiKey) {
    headers['X-API-Key'] = config.apiKey;
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  } else if (config.connectionToken) {
    headers['Authorization'] = `Bearer ${config.connectionToken}`;
  }
  headers['X-User-Id'] = config.userId;

  log(config, `Fetching hosted descriptor: ${url}`);
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Descriptor fetch failed (${response.status} ${response.statusText}): ${body}`);
  }
  return (await response.json()) as HostedDescriptor;
}

function resolveRpcEndpoint(config: BridgeConfig, descriptor: HostedDescriptor): { url: string; token?: string } {
  const token = config.connectionToken || descriptor.connection?.token;

  if (descriptor.connection?.endpoints?.jsonrpc) {
    return { url: descriptor.connection.endpoints.jsonrpc, token };
  }

  const base = isHostedDescriptorUrl(config.apiUrl)
    ? normalizeBaseUrl(stripQueryAndHash(config.apiUrl)).replace(/\/api\/mcp\/servers\/[^/]+$/i, '')
    : normalizeBaseUrl(config.apiUrl);

  const fallback = `${base}/api/mcp/servers/${config.userId}/rpc`;
  return { url: fallback, token };
}

async function callRemoteTool(
  config: BridgeConfig,
  rpcUrl: string,
  token: string | undefined,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-User-Id': config.userId
  };

  if (config.apiKey) {
    headers['X-API-Key'] = config.apiKey;
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  const payload = {
    jsonrpc: '2.0',
    id: randomUUID(),
    method: 'tools/call',
    params: {
      name,
      arguments: args
    }
  };

  log(config, `POST ${rpcUrl} tools/call ${name}`);
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Remote RPC failed (${response.status}): ${JSON.stringify(data)}`);
  }

  if (data.error) {
    throw new Error(`Remote RPC error: ${JSON.stringify(data.error)}`);
  }

  const result = data.result as Record<string, unknown> | undefined;
  if (!result) {
    return {
      content: [{ type: 'text', text: 'Tool executed, but no result payload was returned.' }]
    };
  }

  return result;
}

function toQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      search.set(key, value.join(','));
      continue;
    }
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

function asMcpContent(result: unknown): Record<string, unknown> {
  return {
    content: [
      {
        type: 'text',
        text: typeof result === 'string' ? result : JSON.stringify(result)
      }
    ]
  };
}

async function callHttp(
  config: BridgeConfig,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-User-Id': config.userId
  };
  if (config.apiKey) {
    headers['X-API-Key'] = config.apiKey;
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${url} failed (${response.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

async function callToolFallback(
  config: BridgeConfig,
  descriptor: HostedDescriptor,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const baseUrl = normalizeBaseUrl(descriptor.connection?.baseUrl || (isHostedDescriptorUrl(config.apiUrl)
    ? config.apiUrl.replace(/\/api\/mcp\/servers\/[^/]+$/i, '')
    : config.apiUrl));
  const orgId = descriptor.connection?.orgId || process.env.HIVEMIND_ORG_ID || '00000000-0000-4000-8000-000000000002';

  switch (name) {
    case 'hivemind_save_memory': {
      const result = await callHttp(config, 'POST', `${baseUrl}/api/integrations/webapp/store`, {
        title: args.title,
        content: args.content,
        source_type: args.source_type || 'text',
        tags: args.tags || [],
        project: args.project || 'default',
        relationship: args.relationship,
        related_to: args.related_to,
        user_id: config.userId,
        org_id: orgId
      });
      return asMcpContent(result);
    }
    case 'hivemind_recall': {
      const result = await callHttp(config, 'POST', `${baseUrl}/api/integrations/webapp/prepare`, {
        query: args.query,
        max_memories: args.limit || 5,
        tags: args.tags || [],
        project: args.project,
        source_platforms: args.source_type ? [args.source_type] : [],
        user_id: config.userId,
        org_id: orgId
      });
      return asMcpContent(result);
    }
    case 'hivemind_get_memory': {
      const memoryId = String(args.memory_id || '');
      const result = await callHttp(config, 'GET', `${baseUrl}/api/memories/${memoryId}`);
      return asMcpContent(result);
    }
    case 'hivemind_list_memories': {
      const query = toQuery({
        user_id: config.userId,
        org_id: orgId,
        project: args.project,
        tags: args.tags,
        source_type: args.source_type,
        limit: args.limit || 10,
        page: args.page || 1
      });
      const result = await callHttp(config, 'GET', `${baseUrl}/api/memories${query}`);
      return asMcpContent(result);
    }
    default:
      return asMcpContent({
        warning: `Fallback for tool '${name}' is not implemented in bridge.`,
        recommendation: 'Enable hosted /api/mcp/servers/:userId/rpc to proxy all tools.'
      });
    }
}

async function runBridge(config: BridgeConfig): Promise<void> {
  const descriptor = await fetchDescriptor(config);
  const { url: rpcUrl, token } = resolveRpcEndpoint(config, descriptor);

  const capabilities = descriptor.mcp?.capabilities || { tools: {} };
  const tools = descriptor.tools || [];
  const resources = descriptor.resources || [];
  const prompts = descriptor.prompts || [];

  const server = new Server(
    { name: 'hivemind-mcp-bridge', version: packageVersion },
    { capabilities }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const toolArgs = (request.params.arguments || {}) as Record<string, unknown>;
    try {
      return await callRemoteTool(config, rpcUrl, token, toolName, toolArgs);
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes('404') || message.includes('Not found')) {
        log(config, `RPC unavailable, using fallback for ${toolName}`);
        return await callToolFallback(config, descriptor, toolName, toolArgs);
      }
      throw error;
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async () => ({
    contents: [{
      uri: 'hivemind://bridge',
      text: 'Resource reads are not proxied by this bridge version.'
    }]
  }));

  server.setRequestHandler(GetPromptRequestSchema, async () => ({
    description: 'Prompt retrieval is not proxied by this bridge version.',
    messages: [{ role: 'assistant', content: { type: 'text', text: 'Not implemented in bridge.' } }]
  }));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main() {
  try {
    const config = loadConfig();
    await runBridge(config);
  } catch (error) {
    console.error(`Fatal error: ${(error as Error).message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Unhandled error: ${(error as Error).message}`);
  process.exit(1);
});

export { runBridge, loadConfig, BridgeConfig };
