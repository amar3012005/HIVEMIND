function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolDefinition() {
  return {
    name: 'list_issues',
    description: 'Return fake Linear issues',
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string' }
      }
    }
  };
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') {
    return;
  }

  const { id, method, params } = message;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'fake-linear-mcp',
          version: '1.0.0'
        }
      }
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [toolDefinition()]
      }
    });
    return;
  }

  if (method === 'tools/call') {
    if (params?.name !== 'list_issues') {
      send({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32602,
          message: `Unknown tool: ${params?.name || 'undefined'}`
        }
      });
      return;
    }

    const team = params.arguments?.team || 'HM';
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              issues: [
                {
                  id: 'linear-issue-1',
                  identifier: `${team}-101`,
                  title: 'Ship MCP connector ingestion',
                  description: 'Use the generic MCP connector to ingest external provider data into HIVE-MIND.',
                  priority: 2,
                  priorityLabel: 'High',
                  url: `https://linear.app/hivemind/issue/${team.toLowerCase()}-101`,
                  createdAt: '2026-03-13T00:00:00.000Z',
                  updatedAt: '2026-03-13T00:10:00.000Z',
                  state: { name: 'In Progress' },
                  team: { key: team, name: 'HIVE-MIND' },
                  project: { id: 'linear-project-1', name: 'Connector Platform', slugId: 'connector-platform' },
                  assignee: { name: 'Amar' },
                  labels: [{ name: 'integration' }, { name: 'mcp' }]
                }
              ]
            })
          }
        ]
      }
    });
    return;
  }

  send({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: `Unsupported method: ${method}`
    }
  });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf('\n');
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line) {
      try {
        handleMessage(JSON.parse(line));
      } catch (error) {
        send({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: error.message
          }
        });
      }
    }
    newlineIndex = buffer.indexOf('\n');
  }
});

setInterval(() => {}, 1 << 30);
