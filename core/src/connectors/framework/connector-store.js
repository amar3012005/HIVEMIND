/**
 * Connector Store
 *
 * Manages connector state in the database via Prisma's PlatformIntegration model.
 * Maps the generic connector domain model onto the existing schema.
 *
 * PlatformIntegration fields used:
 *   platformType     -> provider id (currently Gmail-first, future providers can be added to the enum/migration)
 *   authType         -> always 'oauth2' for connectors
 *   accessTokenEncrypted  -> AES-256-GCM encrypted access token
 *   refreshTokenEncrypted -> AES-256-GCM encrypted refresh token
 *   tokenExpiresAt   -> access token expiry
 *   oauthScopes      -> granted scopes
 *   syncStatus       -> connector status
 *   lastSyncedAt     -> last successful sync
 *   lastErrorMessage -> last error
 *   lastErrorAt      -> when error occurred
 *   consecutiveFailures -> retry counter
 *   platformUserId   -> provider account ref (e.g. email address)
 *   connectorMetadata (JSON) -> { cursor, sync_stats, provider_metadata }
 */

import crypto from 'crypto';

const ENCRYPTION_KEY = process.env.HIVEMIND_CONNECTOR_ENCRYPTION_KEY
  || process.env.HIVEMIND_MCP_TOKEN_SECRET
  || process.env.SESSION_SECRET
  || 'default-dev-key-change-in-production-32b';

function deriveKey(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }
  return metadata;
}

function buildConnectorMetadata({ cursor = null, syncStats = null, providerMetadata = {} } = {}) {
  return {
    cursor,
    sync_stats: syncStats,
    provider_metadata: normalizeMetadata(providerMetadata),
  };
}

function readConnectorMetadata(record) {
  return normalizeMetadata(record?.connectorMetadata);
}

export function encryptToken(plaintext) {
  if (!plaintext) return null;
  const key = deriveKey(ENCRYPTION_KEY);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptToken(ciphertext) {
  if (!ciphertext) return null;
  try {
    const [ivHex, tagHex, encHex] = ciphertext.split(':');
    const key = deriveKey(ENCRYPTION_KEY);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(encHex, 'hex')) + decipher.final('utf8');
  } catch {
    return null;
  }
}

// Connector status constants matching the spec
export const CONNECTOR_STATUS = {
  DISCONNECTED: 'idle',       // Maps to SyncStatus.idle
  CONNECTING: 'syncing',      // In-progress OAuth
  CONNECTED: 'idle',          // Connected + idle
  SYNCING: 'syncing',         // Active sync
  ERROR: 'error',             // Sync failed
  REAUTH_REQUIRED: 'revoked', // Token expired/revoked
};

export class ConnectorStore {
  constructor(prisma) {
    this.prisma = prisma;
  }

  /**
   * Create or update a connector for a user+provider.
   */
  async upsertConnector({
    userId,
    provider,
    accountRef,
    accessToken,
    refreshToken,
    tokenExpiresAt,
    scopes,
    cursor = null,
    metadata = {},
  }) {
    const data = {
      authType: 'oauth2',
      platformUserId: accountRef,
      accessTokenEncrypted: encryptToken(accessToken),
      refreshTokenEncrypted: encryptToken(refreshToken),
      tokenExpiresAt: tokenExpiresAt ? new Date(tokenExpiresAt) : null,
      oauthScopes: scopes || [],
      oauthGrantedAt: new Date(),
      oauthLastRefreshed: new Date(),
      isActive: true,
      syncStatus: 'idle',
      consecutiveFailures: 0,
      lastErrorMessage: null,
      lastErrorAt: null,
      connectorMetadata: buildConnectorMetadata({
        cursor,
        providerMetadata: metadata,
      }),
    };

    // Store cursor and sync stats in a JSON metadata field via raw update
    const existing = await this.prisma.platformIntegration.findUnique({
      where: { userId_platformType: { userId, platformType: provider } },
    });

    if (existing) {
      return this.prisma.platformIntegration.update({
        where: { id: existing.id },
        data: {
          ...data,
          connectorMetadata: {
            ...readConnectorMetadata(existing),
            ...data.connectorMetadata,
          },
        },
      });
    }

    return this.prisma.platformIntegration.create({
      data: {
        userId,
        platformType: provider,
        ...data,
      },
    });
  }

  /**
   * Get a connector for a user+provider.
   */
  async getConnector(userId, provider) {
    const record = await this.prisma.platformIntegration.findUnique({
      where: { userId_platformType: { userId, platformType: provider } },
    });
    if (!record) return null;
    return this._mapRecord(record);
  }

  /**
   * List all connectors for a user.
   */
  async listConnectors(userId) {
    const records = await this.prisma.platformIntegration.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return records.map((r) => this._mapRecord(r));
  }

  /**
   * Update connector sync status.
   */
  async updateStatus(userId, provider, { status, error = null, cursor = null, syncStats = null }) {
    const existing = await this.prisma.platformIntegration.findUnique({
      where: { userId_platformType: { userId, platformType: provider } },
    });
    if (!existing) return null;

    const patch = {
      syncStatus: status,
    };

    const nextMetadata = {
      ...readConnectorMetadata(existing),
    };

    if (cursor !== null && cursor !== undefined) {
      nextMetadata.cursor = cursor;
    }

    if (syncStats !== null && syncStats !== undefined) {
      nextMetadata.sync_stats = syncStats;
    }

    patch.connectorMetadata = nextMetadata;

    if (status === 'error' || status === 'revoked') {
      patch.lastErrorMessage = error;
      patch.lastErrorAt = new Date();
      patch.consecutiveFailures = existing.consecutiveFailures + 1;
    }

    if (status === 'idle' && !error) {
      patch.lastSyncedAt = new Date();
      patch.consecutiveFailures = 0;
      patch.lastErrorMessage = null;
    }

    return this.prisma.platformIntegration.update({
      where: { id: existing.id },
      data: patch,
    });
  }

  /**
   * Get decrypted access token for a connector. Handles refresh if needed.
   */
  async getAccessToken(userId, provider) {
    const record = await this.prisma.platformIntegration.findUnique({
      where: { userId_platformType: { userId, platformType: provider } },
    });
    if (!record || !record.isActive) return null;
    return decryptToken(record.accessTokenEncrypted);
  }

  /**
   * Get decrypted refresh token.
   */
  async getRefreshToken(userId, provider) {
    const record = await this.prisma.platformIntegration.findUnique({
      where: { userId_platformType: { userId, platformType: provider } },
    });
    if (!record) return null;
    return decryptToken(record.refreshTokenEncrypted);
  }

  /**
   * Update tokens after refresh.
   */
  async updateTokens(userId, provider, { accessToken, refreshToken, tokenExpiresAt }) {
    const existing = await this.prisma.platformIntegration.findUnique({
      where: { userId_platformType: { userId, platformType: provider } },
    });
    if (!existing) return null;

    const patch = {
      oauthLastRefreshed: new Date(),
    };
    if (accessToken) patch.accessTokenEncrypted = encryptToken(accessToken);
    if (refreshToken) patch.refreshTokenEncrypted = encryptToken(refreshToken);
    if (tokenExpiresAt) patch.tokenExpiresAt = new Date(tokenExpiresAt);

    return this.prisma.platformIntegration.update({
      where: { id: existing.id },
      data: patch,
    });
  }

  /**
   * Disconnect a connector — clear tokens, set inactive.
   */
  async disconnect(userId, provider) {
    const existing = await this.prisma.platformIntegration.findUnique({
      where: { userId_platformType: { userId, platformType: provider } },
    });
    if (!existing) return false;

    await this.prisma.platformIntegration.update({
      where: { id: existing.id },
      data: {
        isActive: false,
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        syncStatus: 'idle',
      },
    });
    return true;
  }

  _mapRecord(record) {
    return {
      id: record.id,
      provider: record.platformType,
      account_ref: record.platformUserId,
      status: this._mapStatus(record),
      scopes: record.oauthScopes,
      is_active: record.isActive,
      last_sync_at: record.lastSyncedAt,
      last_error: record.lastErrorMessage,
      last_error_at: record.lastErrorAt,
      consecutive_failures: record.consecutiveFailures,
      token_expires_at: record.tokenExpiresAt,
      cursor: readConnectorMetadata(record).cursor || null,
      sync_stats: readConnectorMetadata(record).sync_stats || null,
      provider_metadata: readConnectorMetadata(record).provider_metadata || {},
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
  }

  _mapStatus(record) {
    if (!record.isActive) return 'disconnected';
    if (record.syncStatus === 'revoked') return 'reauth_required';
    if (record.syncStatus === 'error') return record.consecutiveFailures >= 3 ? 'degraded' : 'error';
    if (record.syncStatus === 'syncing') return 'syncing';
    return 'connected';
  }
}
