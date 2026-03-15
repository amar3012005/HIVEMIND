import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({
  name: 'fake-gmail-mcp',
  version: '1.0.0',
}, {
  capabilities: {
    tools: {},
  },
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'gmail_get_thread',
      description: 'Return a fake Gmail thread',
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'string' }
        }
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'gmail_get_thread') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          thread: {
            id: request.params.arguments?.threadId || 'thread-1',
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
  };
});

await server.connect(new StdioServerTransport());
