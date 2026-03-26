#!/usr/bin/env node

import { spawn } from 'node:child_process';

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--url':
        config.url = args[++i];
        break;
      case '--user-id':
        config.userId = args[++i];
        break;
      case '--api-key':
        config.apiKey = args[++i];
        break;
      case '--query':
        config.query = args[++i];
        break;
      case '--limit':
        config.limit = Number(args[++i]);
        break;
      case '--save-title':
        config.saveTitle = args[++i];
        break;
      case '--save-content':
        config.saveContent = args[++i];
        break;
      default:
        break;
    }
  }

  return {
    url: config.url || process.env.HIVEMIND_HOSTED_URL || process.env.HIVEMIND_API_URL,
    userId: config.userId || process.env.HIVEMIND_USER_ID,
    apiKey: config.apiKey || process.env.HIVEMIND_API_KEY,
    query: config.query || 'Gmail connector policy',
    limit: Number.isFinite(config.limit) ? config.limit : 3,
    saveTitle: config.saveTitle || '',
    saveContent: config.saveContent || ''
  };
}

function usage() {
  console.error('Usage: npm run smoke:hosted -- --url <descriptorUrl> --user-id <uuid> --api-key <key> [--query "text"] [--limit 3]');
}

function buildRequests(config) {
  const requests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'hivemind-smoke', version: '1.0.0' }
      }
    },
    {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {}
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'hivemind_recall',
        arguments: {
          query: config.query,
          limit: config.limit
        }
      }
    }
  ];

  if (config.saveTitle && config.saveContent) {
    requests.push({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'hivemind_save_memory',
        arguments: {
          title: config.saveTitle,
          content: config.saveContent,
          tags: ['smoke', 'mcp-bridge']
        }
      }
    });
  }

  return requests;
}

async function main() {
  const config = parseArgs();
  if (!config.url || !config.userId || !config.apiKey) {
    usage();
    process.exit(1);
  }

  const child = spawn(
    'node',
    [
      'dist/cli.js',
      'hosted',
      '--url',
      config.url,
      '--user-id',
      config.userId,
      '--api-key',
      config.apiKey,
      '--verbose'
    ],
    {
      cwd: new URL('..', import.meta.url),
      stdio: ['pipe', 'pipe', 'pipe']
    }
  );

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });

  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });

  for (const request of buildRequests(config)) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }
  child.stdin.end();

  const exitCode = await new Promise(resolve => {
    child.on('close', resolve);
  });

  console.log('--- STDERR ---');
  console.log(stderr.trim());
  console.log('--- STDOUT ---');
  console.log(stdout.trim());

  if (exitCode !== 0) {
    console.error(`Smoke test failed with exit code ${exitCode}`);
    process.exit(Number(exitCode) || 1);
  }

  if (!stdout.includes('"id":2') || !stdout.includes('"id":3')) {
    console.error('Smoke test did not receive tools/list and tools/call responses');
    process.exit(1);
  }

  console.log('Smoke test passed');
}

main().catch(error => {
  console.error(`Smoke test failed: ${error.message}`);
  process.exit(1);
});
