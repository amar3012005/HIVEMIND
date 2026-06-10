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
    targetScope = 'personal',
    teamId = null,
    accountRef,
    accessToken,
    refreshToken,
    tokenExpiresAt,
    scopes,
    cursor = null,
    metadata = {},
  }) {
    // TODO: When user A leaves the org, org-scoped connectors they own should be
    // transferred to the org owner via a background job (deactivation hook).
    const data = {
      authType: 'oauth2',
      targetScope,
      teamId: teamId || null,
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
    if (record) {
      const mapped = this._mapRecord(record);
      // Hydrate provider_metadata.instance_url from Nango for Salesforce
      // if missing — handles users connected before instance_url was
      // captured at OAuth time. Without this, SOQL queries cannot resolve
      // the org host and adapter returns 0 records.
      if (
        (provider === 'salesforce' || provider === 'salesforce-sandbox')
        && !mapped.provider_metadata?.instance_url
        && this.prisma.nangoConnection
      ) {
        try {
          const nangoRow = await this.prisma.nangoConnection.findFirst({
            where: { userId, providerKey: provider, status: 'active' },
            select: { connectionId: true },
          });
          if (nangoRow?.connectionId) {
            const { nangoGet } = await import('../mcp/nango-service.js');
            const creds = await nangoGet(
              `/connection/${encodeURIComponent(nangoRow.connectionId)}?provider_config_key=${encodeURIComponent(provider)}`,
            );
            const instanceUrl = creds?.connection_config?.instance_url
                            || creds?.credentials?.instance_url
                            || creds?.metadata?.instance_url
                            || null;
            if (instanceUrl) {
              mapped.provider_metadata = { ...(mapped.provider_metadata || {}), instance_url: instanceUrl };
              // Persist so subsequent syncs don't re-fetch
              try {
                await this.updateMetadata(userId, provider, {
                  provider_metadata: mapped.provider_metadata,
                });
              } catch (persistErr) {
                console.warn(`[connector-store] persist instance_url failed: ${persistErr.message}`);
              }
            }
          }
        } catch (err) {
          console.warn(`[connector-store] hydrate instance_url failed: ${err.message}`);
        }
      }
      return mapped;
    }

    // Nango-only fallback: user OAuthed via Nango Connect popup, no
    // legacy platformIntegration row exists. Synthesize a virtual record
    // so downstream sync/preview endpoints see "connected" and proceed.
    if (this.prisma.nangoConnection) {
      const NANGO_KEY_BY_PROVIDER = {
        atlassian: 'atlassian', jira: 'atlassian', confluence: 'confluence',
        gmail: 'gmail', 'google-docs': 'google-docs', 'google-gemini': 'google-gemini',
        'google-drive': 'google-drive', 'google-calendar': 'google-calendar',
      };
      const nangoKey = NANGO_KEY_BY_PROVIDER[provider] || provider;
      try {
        const nangoRow = await this.prisma.nangoConnection.findFirst({
          where: { userId, providerKey: nangoKey, status: 'active' },
          select: { id: true, connectionId: true, createdAt: true, updatedAt: true },
        });
        if (nangoRow) {
          // Salesforce + similar instance-scoped providers need
          // provider_metadata.instance_url for SOQL queries. Fetch from
          // Nango credentials endpoint and stash so SyncEngine + adapter
          // can read context.provider_metadata.instance_url without a
          // second round-trip per record. Cached on the connector row
          // shape — sync-engine line 92 reads this directly.
          let providerMetadata = {};
          if (['salesforce', 'salesforce-sandbox'].includes(nangoKey)) {
            try {
              const { nangoGet } = await import('../mcp/nango-service.js');
              const creds = await nangoGet(
                `/connection/${encodeURIComponent(nangoRow.connectionId)}?provider_config_key=${encodeURIComponent(nangoKey)}`,
              );
              const instanceUrl = creds?.connection_config?.instance_url
                              || creds?.credentials?.instance_url
                              || creds?.metadata?.instance_url
                              || null;
              if (instanceUrl) providerMetadata.instance_url = instanceUrl;
            } catch (err) {
              console.warn(`[connector-store] fetch instance_url failed: ${err.message}`);
            }
          }
          return {
            id: nangoRow.id,
            userId,
            platformType: provider,
            isActive: true,
            syncStatus: 'connected',
            target_scope: 'personal',
            connectorMetadata: { source: 'nango', connection_id: nangoRow.connectionId },
            provider_metadata: providerMetadata,
            createdAt: nangoRow.createdAt,
            updatedAt: nangoRow.updatedAt,
            _via_nango: true,
          };
        }
      } catch (err) {
        console.warn(`[connector-store] Nango getConnector fallback failed for ${provider}: ${err.message}`);
      }
    }
    return null;
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
   * List every connector across all users for a given provider.
   * Used by Pub/Sub watch renewal cron.
   */
  async listAllByProvider(provider) {
    const records = await this.prisma.platformIntegration.findMany({
      where: { platformType: provider, syncStatus: { not: 'revoked' } },
      orderBy: { lastSyncedAt: 'desc' },
    });
    return records.map((r) => this._mapRecord(r));
  }

  /**
   * Look up a connection by the external account it represents
   * (e.g. find gmail connector for user_account_ref = "alice@example.com").
   * Pub/Sub notifications carry the emailAddress; we map it back to userId.
   */
  async findByEmail(provider, email) {
    if (!email) return null;
    const normalized = String(email).toLowerCase();
    const record = await this.prisma.platformIntegration.findFirst({
      where: {
        platformType: provider,
        userAccountRef: { equals: normalized, mode: 'insensitive' },
        syncStatus: { not: 'revoked' },
      },
    });
    if (!record) return null;
    return this._mapRecord(record);
  }

  /**
   * Patch arbitrary keys into connectorMetadata (e.g. { watch: {...} }).
   * Other metadata fields preserved.
   */
  async updateMetadata(userId, provider, partial) {
    const existing = await this.prisma.platformIntegration.findUnique({
      where: { userId_platformType: { userId, platformType: provider } },
    });
    if (!existing) return null;
    const merged = {
      ...readConnectorMetadata(existing),
      ...partial,
    };
    return this.prisma.platformIntegration.update({
      where: { id: existing.id },
      data: { connectorMetadata: merged },
    });
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
   * Get decrypted access token for a connector. Refreshes if expired.
   */
  async getAccessToken(userId, provider) {
    // Map our provider id → Nango unique_key (the value in Nango's
    // _nango_configs.unique_key column — set when the integration is
    // registered in Nango dashboard). Mismatch here = "Integration does
    // not exist" 400. Keep ALL providers that have a Nango integration
    // mapped explicitly; unknown providers fall through to provider name.
    const NANGO_KEY_BY_PROVIDER = {
      atlassian: 'atlassian',
      jira: 'atlassian',
      confluence: 'confluence',
      gmail: 'gmail',                  // Nango unique_key is 'gmail' (not 'google-mail')
      'google-docs': 'google-docs',
      'google-gemini': 'google-gemini',
      'google-drive': 'google-drive',
      'google-calendar': 'google-calendar',
    };

    // Nango-FIRST lookup. If user has a live Nango connection for this
    // provider, use it regardless of whether a legacy platformIntegration
    // row exists. This makes the FE switch to Nango-only (Connectors page
    // shows Nango tile) actually route Gmail/GDocs/etc. through Nango
    // without requiring a manual disconnect of legacy creds.
    if (this.prisma.nangoConnection) {
      const nangoKey = NANGO_KEY_BY_PROVIDER[provider] || provider;
      try {
        const nangoRow = await this.prisma.nangoConnection.findFirst({
          where: { userId, providerKey: nangoKey, status: 'active' },
          select: { id: true, connectionId: true },
        });
        if (nangoRow?.connectionId) {
          const { fetchBearerFromNango } = await import('../mcp/nango-service.js');
          try {
            return await fetchBearerFromNango(nangoKey, nangoRow.connectionId);
          } catch (bearerErr) {
            // Self-heal: a connection whose credentials are permanently dead
            // ("refresh limit has been reached", invalid_credentials) will
            // never recover — flip it out of 'active' so every future lookup
            // skips straight to the native platformIntegration token instead
            // of hammering Nango (and spamming logs) on every call.
            if (/refresh limit|invalid_credentials|424/i.test(bearerErr.message || '')) {
              this.prisma.nangoConnection.update({
                where: { id: nangoRow.id },
                data: { status: 'error' },
              }).then(() => {
                console.warn(`[connector-store] marked dead Nango connection ${nangoRow.connectionId} (${provider}) status=error — falling back to native token`);
              }).catch(() => {});
            }
            throw bearerErr;
          }
        }
      } catch (err) {
        console.warn(`[connector-store] Nango token fetch failed for ${provider}: ${err.message}`);
      }
    }

    const record = await this.prisma.platformIntegration.findUnique({
      where: { userId_platformType: { userId, platformType: provider } },
    });
    if (!record || !record.isActive) return null;

    // Check if token is expired (with 5min buffer)
    const isExpired = record.tokenExpiresAt && new Date(record.tokenExpiresAt) < new Date(Date.now() + 5 * 60 * 1000);

    if (isExpired && record.refreshTokenEncrypted) {
      // Refresh the token
      try {
        const refreshToken = decryptToken(record.refreshTokenEncrypted);
        if (refreshToken && provider === 'gmail') {
          const resp = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: process.env.GOOGLE_CLIENT_ID,
              client_secret: process.env.GOOGLE_CLIENT_SECRET,
              refresh_token: refreshToken,
              grant_type: 'refresh_token',
            }),
          });
          if (resp.ok) {
            const tokens = await resp.json();
            const newExpiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
            await this.prisma.platformIntegration.update({
              where: { id: record.id },
              data: {
                accessTokenEncrypted: encryptToken(tokens.access_token),
                tokenExpiresAt: newExpiresAt,
                oauthLastRefreshed: new Date(),
              },
            });
            console.log(`[connector-store] Refreshed ${provider} token for user ${userId}`);
            return tokens.access_token;
          }
        }
      } catch (refreshErr) {
        console.warn(`[connector-store] Token refresh failed for ${provider}:`, refreshErr.message);
      }
    }

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
   * Disconnect a connector — clear tokens, set inactive, AND remove the
   * Nango connection row for the same provider if present. Without the
   * Nango cleanup the GET /v1/connectors overlay re-promotes the connector
   * back to 'connected' on every fetch (the overlay treats any active
   * nango_connections row as proof of connectivity), so the UI never
   * reflects the disconnect.
   *
   * Returns true if anything was changed (either a platformIntegration
   * row updated or a nangoConnection row removed).
   */
  async disconnect(userId, provider) {
    let changed = false;

    const existing = await this.prisma.platformIntegration.findUnique({
      where: { userId_platformType: { userId, platformType: provider } },
    });
    if (existing) {
      await this.prisma.platformIntegration.update({
        where: { id: existing.id },
        data: {
          isActive: false,
          accessTokenEncrypted: null,
          refreshTokenEncrypted: null,
          syncStatus: 'idle',
        },
      });
      changed = true;
    }

    // Nango cleanup — provider key is either the same as the registry id
    // (slack, notion, github, linear) or the mapped value (atlassian→jira,
    // gmail→google-mail, …). Delete on both sides so neither path survives.
    const NANGO_KEY_ALIASES = {
      atlassian: ['atlassian', 'jira'],
      confluence: ['confluence'],
      gmail: ['gmail', 'google-mail'],
      'google-mail': ['google-mail', 'gmail'],
      'google-drive': ['google-drive'],
      google_drive: ['google-drive'],
      'google-calendar': ['google-calendar'],
      google_calendar: ['google-calendar'],
      'google-docs': ['google-docs', 'gdocs'],
      google_docs: ['google-docs', 'gdocs'],
      gdocs: ['google-docs', 'gdocs'],
      'google-sheets': ['google-sheets'],
      google_sheets: ['google-sheets'],
      'google-slides': ['google-slides'],
      google_slides: ['google-slides'],
      'google-contacts': ['google-contacts'],
      google_contacts: ['google-contacts'],
      'google-tasks': ['google-tasks'],
      google_tasks: ['google-tasks'],
      'google-chat': ['google-chat'],
      google_chat: ['google-chat'],
      'google-forms': ['google-forms'],
      google_forms: ['google-forms'],
      'google-gemini': ['google-gemini', 'gemini'],
      gemini: ['google-gemini', 'gemini'],
    };
    const nangoKeys = NANGO_KEY_ALIASES[provider] || [provider];
    if (this.prisma.nangoConnection) {
      try {
        const rows = await this.prisma.nangoConnection.findMany({
          where: { userId, providerKey: { in: nangoKeys } },
          select: { id: true, providerKey: true, connectionId: true },
        });
        // Revoke each at Nango side first (best-effort), then delete locally.
        if (rows.length > 0) {
          const { deleteConnection } = await import('../mcp/nango-service.js');
          for (const r of rows) {
            try {
              await deleteConnection(r.providerKey, r.connectionId);
            } catch (revokeErr) {
              console.warn(`[connector-store] nango DELETE failed for ${r.providerKey}/${r.connectionId}: ${revokeErr.message}`);
            }
          }
          const del = await this.prisma.nangoConnection.deleteMany({
            where: { id: { in: rows.map(r => r.id) } },
          });
          if (del.count > 0) changed = true;
        }
      } catch (err) {
        // Don't block the disconnect on Nango bookkeeping failure — the
        // platform_integration update is the source of truth for legacy
        // OAuth-only providers.
        console.warn(`[connector-store] nango cleanup failed for ${provider}: ${err.message}`);
      }
    }

    return changed;
  }

  _mapRecord(record) {
    return {
      id: record.id,
      provider: record.platformType,
      account_ref: record.platformUserId,
      target_scope: record.targetScope || 'personal',
      team_id: record.teamId || null,
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
