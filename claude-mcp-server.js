#!/usr/bin/env node
/**
 * HIVE-MIND MCP Server for Claude Desktop
 * Connects Claude Desktop to your HIVE-MIND memory API
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const HIVEMIND_URL = process.env.HIVEMIND_URL || 'https://core.hivemind.davinciai.eu:8050';
const HIVEMIND_API_KEY = process.env.HIVEMIND_API_KEY;

if (!HIVEMIND_API_KEY) {
  console.error('Error: HIVEMIND_API_KEY environment variable required');
  process.exit(1);
}

const server = new Server(
  {
    name: 'hivemind-memory',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'save_conversation',
        description: 'Save this conversation to HIVE-MIND memory',
        inputSchema: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'Title for this memory',
            },
            content: {
              type: 'string',
              description: 'Content to save',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tags for categorization',
            },
            project: {
              type: 'string',
              description: 'Project name',
            },
          },
          required: ['title', 'content'],
        },
      },
      {
        name: 'search_memories',
        description: 'Search HIVE-MIND for relevant memories',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query',
            },
            limit: {
              type: 'number',
              default: 5,
              description: 'Number of results',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'query_memories',
        description: 'Query memories with semantic search',
        inputSchema: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'Question to ask your memory',
            },
          },
          required: ['question'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'save_conversation') {
    try {
      const response = await fetch(`${HIVEMIND_URL}/api/memories`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${HIVEMIND_API_KEY}`,
        },
        body: JSON.stringify({
          source_type: 'conversation',
          title: args.title,
          content: args.content,
          tags: args.tags || ['claude', 'ai-chat'],
          project: args.project || 'claude-desktop',
          user_id: 'claude-user',
          org_id: 'claude-org',
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const result = await response.json();
      return {
        content: [
          {
            type: 'text',
            text: `✓ Saved to HIVE-MIND! Memory ID: ${result.memory_id || result.id}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error saving: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (name === 'search_memories') {
    try {
      const response = await fetch(
        `${HIVEMIND_URL}/api/search?query=${encodeURIComponent(args.query)}&limit=${args.limit || 5}`,
        {
          headers: {
            'Authorization': `Bearer ${HIVEMIND_API_KEY}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const results = await response.json();
      const memories = results.memories || results.results || [];

      if (memories.length === 0) {
        return {
          content: [{ type: 'text', text: 'No memories found.' }],
        };
      }

      const formatted = memories.map((m, i) =>
        `${i + 1}. ${m.title}\n   ${m.content?.substring(0, 200)}...\n   Tags: ${m.tags?.join(', ') || 'none'}`
      ).join('\n\n');

      return {
        content: [
          {
            type: 'text',
            text: `Found ${memories.length} memories:\n\n${formatted}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error searching: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (name === 'query_memories') {
    try {
      const response = await fetch(`${HIVEMIND_URL}/api/memories/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${HIVEMIND_API_KEY}`,
        },
        body: JSON.stringify({
          query: args.question,
          user_id: 'claude-user',
          org_id: 'claude-org',
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const result = await response.json();

      return {
        content: [
          {
            type: 'text',
            text: result.answer || result.response || JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error querying: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

// Start server
const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  console.error('HIVE-MIND MCP server running on stdio');
});
