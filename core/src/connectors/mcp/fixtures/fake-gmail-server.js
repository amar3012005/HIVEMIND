function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolDefinition() {
  return {
    name: 'gmail_get_thread',
    description: 'Return a fake Gmail thread',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' }
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
          name: 'fake-gmail-mcp',
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
    if (params?.name !== 'gmail_get_thread') {
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

    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              thread: {
                id: params.arguments?.threadId || 'thread-1',
                labels: ['project-mcp', 'client'],
                messages: [
                  {
                    id: 'gmail-msg-fixture-1',
                    subject: 'MCP launch date',
                    snippet: 'Launch date is April 5.',
                    body: 'The customer confirmed the launch date for Project MCP is April 5, 2026.',
                    internalDate: '2026-03-13T10:00:00.000Z',
                    from: 'client@example.com',
                    to: ['amar@example.com'],
                    permalink: 'https://mail.google.com/mail/u/0/#inbox/gmail-msg-fixture-1'
                  }
                ]
              }
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
