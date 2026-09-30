import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('MCP client searches and reads the checked-out Harness docs', async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(directory, 'server.mjs')],
    env: { ...process.env, DSH_DOCS_ROOT: process.env.DSH_DOCS_ROOT },
  });
  const client = new Client({ name: 'dsh-docs-smoke', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['docs_catalog', 'docs_read', 'docs_search', 'docs_status']);
    const status = await client.callTool({ name: 'docs_status', arguments: {} });
    const metadata = JSON.parse(status.content[0].text);
    assert.ok(metadata.page_count > 100);
    assert.match(metadata.revision, /^[a-f0-9]{40}$/);
    const search = await client.callTool({ name: 'docs_search', arguments: { query: 'schedule delivery receipt' } });
    const matches = JSON.parse(search.content[0].text).matches;
    assert.ok(matches.some((match) => match.path === 'subsystems/schedule.md'));
    const read = await client.callTool({ name: 'docs_read', arguments: { path: 'subsystems/schedule.md', start_line: 1, line_count: 12 } });
    assert.match(JSON.parse(read.content[0].text).text, /Host-wide Schedule/);
    const rejected = await client.callTool({ name: 'docs_read', arguments: { path: '../auth.json' } });
    assert.equal(rejected.isError, true);
  } finally {
    await client.close();
  }
});
