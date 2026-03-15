import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({
  name: 'fake-linear-mcp',
  version: '1.0.0',
}, {
  capabilities: {
    tools: {},
  },
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_issues',
      description: 'Return fake Linear issues',
      inputSchema: {
        type: 'object',
        properties: {
          team: { type: 'string' }
        }
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'list_issues') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const team = request.params.arguments?.team || 'HM';

  return {
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
  };
});

await server.connect(new StdioServerTransport());
