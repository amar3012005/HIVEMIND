#!/usr/bin/env node
/**
 * HIVE-MIND MCP Bridge CLI
 * Bridges local MCP clients to hosted HIVE-MIND MCP service
 *
 * Usage:
 *   npx @hivemind/mcp-bridge hosted     - Connect to hosted EU backend
 *   npx @hivemind/mcp-bridge local      - Connect to local development server
 *   npx @hivemind/mcp-bridge            - Defaults to hosted mode
 *
 * Environment Variables (hosted mode):
 *   HIVEMIND_API_URL        - HIVE-MIND API URL (required for hosted)
 *   HIVEMIND_API_KEY        - API key for authentication (required for hosted)
 *   HIVEMIND_USER_ID        - User identifier (optional, defaults to UUID)
 *
 * Environment Variables (local mode):
 *   HIVEMIND_LOCAL_URL      - Local server URL (default: http://localhost:3000)
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get package version
const __dirname = dirname(fileURLToPath(import.meta.url));
let packageVersion = '2.0.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));
  packageVersion = pkg.version;
} catch {
  // Ignore if package.json not found
}

// ============================================================================
// Configuration
// ============================================================================

interface BridgeConfig {
  mode: 'hosted' | 'local';
  apiUrl: string;
  apiKey: string;
  userId: string;
  verbose: boolean;
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
      case '-v':
      case '--verbose':
        config.verbose = true;
        break;
      case '--version':
        console.log(`@hivemind/mcp-bridge v${packageVersion}`);
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
Connect Claude Desktop/Cursor to sovereign EU memory storage

USAGE:
  npx @hivemind/mcp-bridge [mode] [options]

MODES:
  hosted    Connect to hosted HIVE-MIND API (default)
  local     Connect to local development server

OPTIONS:
  --url <url>         API URL (overrides env var)
  --api-key <key>     API key (overrides env var)
  --user-id <id>      User ID (overrides env var)
  --verbose, -v       Enable verbose logging
  --version           Show version number
  --help, -h          Show this help message

ENVIRONMENT VARIABLES:
  HIVEMIND_API_URL      API URL for hosted mode
  HIVEMIND_API_KEY      API key for authentication
  HIVEMIND_USER_ID      User identifier (UUID)
  HIVEMIND_LOCAL_URL    Local server URL (default: http://localhost:3000)

EXAMPLES:
  # Use with Claude Desktop (configured in claude_desktop_config.json)
  {
    "mcpServers": {
      "hivemind": {
        "command": "npx",
        "args": ["-y", "@hivemind/mcp-bridge", "hosted"],
        "env": {
          "HIVEMIND_API_URL": "https://hivemind.davinciai.eu",
          "HIVEMIND_API_KEY": "hm_master_key_...",
          "HIVEMIND_USER_ID": "00000000-0000-4000-8000-000000000001"
        }
      }
    }
  }

  # Local development
  npx @hivemind/mcp-bridge local --url http://localhost:3000

MORE INFO:
  https://github.com/hivemind/mcp-bridge
`);
}

function loadConfig(): BridgeConfig {
  const cliConfig = parseArgs();

  const mode = cliConfig.mode || 'hosted';
  const verbose = cliConfig.verbose || false;

  if (mode === 'hosted') {
    const apiUrl = cliConfig.apiUrl || process.env.HIVEMIND_API_URL;
    const apiKey = cliConfig.apiKey || process.env.HIVEMIND_API_KEY;
    const userId = cliConfig.userId || process.env.HIVEMIND_USER_ID || generateUserId();

    if (!apiUrl || !apiKey) {
      console.error('ERROR: Hosted mode requires HIVEMIND_API_URL and HIVEMIND_API_KEY');
      console.error('');
      console.error('Set environment variables:');
      console.error('  export HIVEMIND_API_URL="https://hivemind.davinciai.eu"');
      console.error('  export HIVEMIND_API_KEY="hm_master_key_..."');
      console.error('');
      console.error('Or configure in claude_desktop_config.json:');
      console.error('  "env": {');
      console.error('    "HIVEMIND_API_URL": "...",');
      console.error('    "HIVEMIND_API_KEY": "..."');
      console.error('  }');
      process.exit(1);
    }

    return { mode, apiUrl, apiKey, userId, verbose };
  } else {
    // Local mode
    const apiUrl = cliConfig.apiUrl || process.env.HIVEMIND_LOCAL_URL || 'http://localhost:3000';
    const apiKey = cliConfig.apiKey || process.env.HIVEMIND_API_KEY || 'hm_master_key_99228811';
    const userId = cliConfig.userId || '00000000-0000-4000-8000-000000000001';

    return { mode, apiUrl, apiKey, userId, verbose };
  }
}

function generateUserId(): string {
  // Generate a stable user ID based on hostname for local development
  const hostname = require('os').hostname();
  const hash = require('crypto').createHash('md5').update(hostname).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

// ============================================================================
// MCP Bridge Implementation
// ============================================================================

async function runHostedBridge(config: BridgeConfig) {
  log(config, `Starting HIVE-MIND MCP Bridge v${packageVersion}`);
  log(config, `Mode: HOSTED`);
  log(config, `API URL: ${config.apiUrl}`);
  log(config, `User ID: ${config.userId}`);

  // Fetch MCP configuration from hosted service
  log(config, 'Fetching MCP configuration...');

  try {
    const response = await fetch(`${config.apiUrl}/api/mcp/servers/${config.userId}`, {
      headers: {
        'X-API-Key': config.apiKey,
        'X-User-Id': config.userId
      }
    });

    if (!response.ok) {
      console.error(`Failed to connect to HIVE-MIND: ${response.status} ${response.statusText}`);
      console.error('');
      console.error('Troubleshooting:');
      console.error('  1. Check HIVEMIND_API_URL is correct');
      console.error('  2. Check HIVEMIND_API_KEY is valid');
      console.error('  3. Verify the server is running');
      process.exit(1);
    }

    const serverConfig = await response.json() as {
      mcp: { serverInfo: { name: string; version: string } };
      tools: Array<{ name: string; description: string }>;
    };

    log(config, `Connected! Server: ${serverConfig.mcp.serverInfo.name} v${serverConfig.mcp.serverInfo.version}`);
    log(config, `Available tools: ${serverConfig.tools.length}`);

    if (config.verbose) {
      serverConfig.tools.forEach(tool => {
        log(config, `  - ${tool.name}: ${tool.description}`);
      });
    }

    // Start stdio bridge - handle incoming MCP messages
    // Use readline-style buffering for newline-delimited JSON
    let buffer = '';
    process.stdin.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep last incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            handleMessage(message, config, serverConfig).catch((err) => {
              log(config, `Handler error: ${(err as Error).message}`);
            });
          } catch (error) {
            log(config, `Error parsing message: ${(error as Error).message}`);
            sendError(null, -32700, 'Parse error: Invalid JSON');
          }
        }
      }
    });

    // Keep process alive
    setInterval(() => {}, 1000);

  } catch (error) {
    console.error(`Connection error: ${(error as Error).message}`);
    process.exit(1);
  }
}

async function handleMessage(
  message: Record<string, unknown>,
  config: BridgeConfig,
  serverConfig: { mcp: unknown; tools: Array<{ name: string }> }
) {
  const { method, id, params } = message;

  switch (method) {
    case 'initialize':
      sendResponse(id, { result: serverConfig.mcp });
      break;

    case 'tools/list':
      sendResponse(id, { result: { tools: serverConfig.tools } });
      break;

    case 'tools/call': {
      const toolParams = params as Record<string, unknown>;
      const toolName = toolParams?.name as string;
      const toolArgs = toolParams?.arguments as Record<string, unknown>;

      log(config, `Tool call: ${toolName}`);

      if (config.verbose) {
        log(config, `  Arguments: ${JSON.stringify(toolArgs, null, 2)}`);
      }

      try {
        // Proxy tool call to hosted service
        const response = await fetch(`${config.apiUrl}/api/mcp/rpc`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
            'X-User-Id': config.userId
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: {
              name: toolName,
              arguments: toolArgs
            }
          })
        });

        const resultData = await response.json();

        if (config.verbose) {
          log(config, `  Response: ${JSON.stringify(resultData)}`);
        }

        console.log(JSON.stringify(resultData));
      } catch (error) {
        sendError(id, -32603, `Tool call failed: ${(error as Error).message}`);
      }
      break;
    }

    case 'ping':
      sendResponse(id, { result: {} });
      break;

    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

function sendResponse(id: unknown, response: Record<string, unknown>) {
  console.log(JSON.stringify({
    jsonrpc: '2.0',
    id,
    ...response
  }));
}

function sendError(id: unknown | null, code: number, message: string) {
  console.log(JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message }
  }));
}

function log(config: BridgeConfig, message: string) {
  if (config.verbose || !config.mode) {
    console.error(`[HIVE-MIND Bridge] ${message}`);
  }
}

async function runLocalBridge(config: BridgeConfig) {
  log(config, `Starting HIVE-MIND MCP Bridge v${packageVersion}`);
  log(config, `Mode: LOCAL`);
  log(config, `Local URL: ${config.apiUrl}`);

  // For local mode, we proxy to a local HIVEMIND server
  console.error(`[HIVE-MIND Bridge] Local mode connects to ${config.apiUrl}`);
  console.error(`[HIVE-MIND Bridge] This mode is for development only`);

  // Same implementation as hosted, but with local URL
  await runHostedBridge(config);
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
  try {
    const config = loadConfig();

    if (config.mode === 'hosted') {
      await runHostedBridge(config);
    } else {
      await runLocalBridge(config);
    }
  } catch (error) {
    console.error(`Fatal error: ${(error as Error).message}`);
    process.exit(1);
  }
}

// Run if called directly
main().catch(console.error);

// Export for module usage
export { runHostedBridge, runLocalBridge, loadConfig, BridgeConfig };
