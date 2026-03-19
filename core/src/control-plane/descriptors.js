function withApiKey(value, apiKey) {
  return apiKey || value;
}

export function buildClientDescriptor(client, {
  coreApiBaseUrl,
  userId,
  apiKey = null
}) {
  const placeholder = 'YOUR_API_KEY';
  const effectiveKey = withApiKey(placeholder, apiKey);

  const sharedEnv = {
    HIVEMIND_API_URL: coreApiBaseUrl,
    HIVEMIND_USER_ID: userId,
    HIVEMIND_API_KEY: effectiveKey
  };

  switch (client) {
    case 'claude':
      return {
        client: 'claude',
        config: {
          mcpServers: {
            hivemind: {
              command: 'npx',
              args: ['-y', '@amar_528/mcp-bridge', 'hosted'],
              env: sharedEnv
            }
          }
        }
      };

    case 'antigravity':
      return {
        client: 'antigravity',
        config: {
          mcpServers: {
            hivemind: {
              command: 'npx',
              args: ['-y', '@amar_528/mcp-bridge', 'hosted'],
              env: {
                ...sharedEnv,
                NODE_NO_WARNINGS: '1'
              }
            }
          }
        }
      };

    case 'vscode':
      return {
        client: 'vscode',
        config: {
          mcpServers: {
            hivemind: {
              command: 'npx',
              args: ['-y', '@amar_528/mcp-bridge', 'hosted'],
              env: sharedEnv
            }
          }
        }
      };

    case 'remote-mcp':
      return {
        client: 'remote-mcp',
        config: {
          mcpServers: {
            hivemind: {
              serverUrl: `${coreApiBaseUrl}/api/mcp/rpc`,
              headers: {
                Authorization: `Bearer ${effectiveKey}`,
                'X-User-Id': userId,
                'Content-Type': 'application/json'
              }
            }
          }
        }
      };

    default:
      throw new Error(`Unsupported client: ${client}`);
  }
}

export function buildAllClientDescriptors(options) {
  return [
    buildClientDescriptor('claude', options),
    buildClientDescriptor('antigravity', options),
    buildClientDescriptor('vscode', options),
    buildClientDescriptor('remote-mcp', options)
  ];
}
