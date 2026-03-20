import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['-y', '@amar_528/mcp-bridge', 'hosted'],
  env: {
    ...process.env,
    HIVEMIND_API_URL: 'https://core.hivemind.davinciai.eu:8050',
    HIVEMIND_API_KEY: 'hm_master_key_99228811',
    HIVEMIND_USER_ID: '00000000-0000-4000-8000-000000000001',
    NODE_NO_WARNINGS: '1'
  }
});

const client = new Client({ name: 'probe', version: '1.0.0' });

try {
  await client.connect(transport);
  console.log('INIT_OK');
  const tools = await client.listTools();
  console.log(JSON.stringify(tools, null, 2));
} catch (error) {
  console.error('PROBE_ERROR', error?.stack || error?.message || error);
  process.exitCode = 1;
} finally {
  await transport.close().catch(() => {});
}
