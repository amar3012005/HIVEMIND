#!/usr/bin/env node
/**
 * HIVE-MIND MCP Bridge CLI
 * Bridges local MCP clients to hosted HIVE-MIND MCP service
 *
 * Usage:
 *   npx @hivemind/mcp-bridge hosted
 *   npx @hivemind/mcp-bridge local
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'child_process';

const HIVEMIND_HOSTED_URL = process.env.HIVEMIND_HOSTED_URL || '';
const HIVEMIND_CONNECTION_TOKEN = process.env.HIVEMIND_CONNECTION_TOKEN || '';
const HIVEMIND_USER_ID = process.env.HIVEMIND_USER_ID || 'unknown';

if (!HIVEMIND_HOSTED_URL || !HIVEMIND_CONNECTION_TOKEN) {
  console.error('Error: HIVEMIND_HOSTED_URL and HIVEMIND_CONNECTION_TOKEN environment variables required');
  process.exit(1);
}

async function main() {
  const mode = process.argv[2] || 'hosted';

  if (mode === 'hosted') {
    // Connect to hosted MCP service via HTTP bridge
    console.error(`[HIVE-MIND MCP Bridge] Connecting to hosted service...`);
    console.error(`[HIVE-MIND MCP Bridge] URL: ${HIVEMIND_HOSTED_URL}`);

    // Fetch MCP configuration from hosted service
    const response = await fetch(HIVEMIND_HOSTED_URL, {
      headers: {
        'X-API-Key': HIVEMIND_CONNECTION_TOKEN,
        'X-User-Id': HIVEMIND_USER_ID || 'unknown'
      }
    });

    if (!response.ok) {
      console.error(`[HIVE-MIND MCP Bridge] Failed to connect: ${response.status}`);
      process.exit(1);
    }

    const config = await response.json() as { mcp: { serverInfo: { name: string } }, tools: Array<{ name: string }> };
    console.error(`[HIVE-MIND MCP Bridge] Connected! Server: ${config.mcp.serverInfo.name}`);
    console.error(`[HIVE-MIND MCP Bridge] Available tools: ${config.tools.length}`);

    // Start stdio bridge
    process.stdin.on('data', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.method === 'initialize') {
          // Return MCP configuration
          const response = {
            jsonrpc: '2.0',
            id: message.id,
            result: config.mcp
          };
          console.log(JSON.stringify(response));
        } else if (message.method === 'tools/list') {
          const response = {
            jsonrpc: '2.0',
            id: message.id,
            result: { tools: config.tools }
          };
          console.log(JSON.stringify(response));
        } else if (message.method === 'tools/call') {
          // Proxy tool call to hosted service
          const result = await fetch(`${HIVEMIND_HOSTED_URL}/rpc`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${HIVEMIND_CONNECTION_TOKEN}`
            },
            body: JSON.stringify(message)
          });

          const resultData = await result.json();
          console.log(JSON.stringify(resultData));
        } else {
          console.log(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Method not found' }
          }));
        }
      } catch (error: unknown) {
        console.error(`[HIVE-MIND MCP Bridge] Error: ${(error as Error).message}`);
      }
    });

    // Keep process alive
    setInterval(() => {}, 1000);
  } else {
    console.error(`[HIVE-MIND MCP Bridge] Unknown mode: ${mode}`);
    process.exit(1);
  }
}

main().catch(console.error);
