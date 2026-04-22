import { ManagedToolClient } from '../../../sdk/node/index';
import { loadConnection, saveConnection } from './token-store';

const HIVE_BASE_URL = process.env.HIVEMIND_BASE_URL || 'http://localhost:3000';
const CLIENT_ID = process.env.HIVEMIND_OAUTH_CLIENT_ID || 'hivemind-local-dev';

export function createHiveMindClient(): ManagedToolClient | null {
  const connection = loadConnection();
  if (!connection) {
    return null;
  }

  return new ManagedToolClient({
    baseUrl: HIVE_BASE_URL,
    clientId: CLIENT_ID,
    getTokens: () => ({
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      scope: connection.scope
    }),
    saveTokens: (tokens) => {
      saveConnection({
        ...connection,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken || connection.refreshToken,
        scope: tokens.scope || connection.scope
      });
    }
  });
}