/**
 * HIVE-MIND GDPR Data Erasure Service
 * Implements Article 17 - Right to Erasure ('Right to be Forgotten')
 * Compliance: GDPR Article 17, Article 30 (Records of Processing)
 */

const { Pool } = require('pg');
const crypto = require('crypto');
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const { AuditLogger } = require('../audit/logger');

// Configuration
const ERASURE_CONFIG = {
  // Grace period before permanent deletion (30 days)
  gracePeriodDays: 30,
  
  // Retention periods for different data types
  retention: {
    auditLogs: 7 * 365, // 7 years (NIS2/DORA compliance)
    consentRecords: 7 * 365, // 7 years
    legalHold: 10 * 365, // 10 years for legal obligations
  },
  
  // Processing settings
  batchSize: 1000,
  verificationRequired: true,
};

// Data deletion stages
const ERASURE_STAGES = {
  PENDING: 'pending',
  GRACE_PERIOD: 'grace_period',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
};

// Data categories and their deletion policies
const DATA_CATEGORIES = {
  PROFILE: {
    table: 'users',
    softDelete: true,
    permanentAfter: 30,
    cascade: ['user_sessions', 'user_preferences'],
  },
  MEMORIES: {
    table: 'memories',
    softDelete: true,
    permanentAfter: 30,
    cascade: ['memory_embeddings', 'memory_tags'],
  },
  SESSIONS: {
    table: 'user_sessions',
    softDelete: false,
    permanentAfter: 0,
  },
  INTEGRATIONS: {
    table: 'user_integrations',
    softDelete: true,
    permanentAfter: 30,
    revokeTokens: true,
  },
  PREFERENCES: {
    table: 'user_preferences',
    softDelete: false,
    permanentAfter: 0,
  },
  AUDIT_LOGS: {
    table: 'audit_logs',
    softDelete: false,
    permanentAfter: 7 * 365, // Retained for 7 years
    anonymize: true,
  },
  CONSENT: {
    table: 'user_consent',
    softDelete: false,
    permanentAfter: 7 * 365, // Retained for 7 years
  },
};

class GDPRErasureService {
  constructor(config = {}) {
    this.config = { ...ERASURE_CONFIG, ...config };
    this.auditLogger = new AuditLogger();
    
    // Initialize database pool
    this.dbPool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'hivemind',
      user: process.env.DB_USER || 'hivemind',
      password: process.env.DB_PASSWORD,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });
    
    // Initialize job queue
    const redis = new IORedis({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD,
    });
    
    this.erasureQueue = new Queue('gdpr-erasure', { connection: redis });
    
    // Schedule grace period completion check
    this.scheduleGracePeriodCheck();
  }

  /**
   * Initiate erasure request with grace period
   * @param {string} userId - User ID requesting erasure
   * @param {Object} options - Erasure options
   * @returns {Promise<Object>} Erasure request details
   */
  async initiateErasure(userId, options = {}) {
    const requestId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    
    // Verify user exists
    const userExists = await this.verifyUserExists(userId);
    if (!userExists) {
      throw new GDPRErasureError('User not found', 'USER_NOT_FOUND', 404);
    }
    
    // Check for existing pending erasure
    const existingRequest = await this.getPendingErasure(userId);
    if (existingRequest) {
      return {
        requestId: existingRequest.id,
        status: existingRequest.status,
        message: 'Erasure request already pending',
        canCancel: existingRequest.status === ERASURE_STAGES.GRACE_PERIOD,
        scheduledDeletion: existingRequest.scheduled_deletion_at,
      };
    }
    
    // Check for legal holds
    const legalHolds = await this.checkLegalHolds(userId);
    if (legalHolds.length > 0 && !options.force) {
      throw new GDPRErasureError(
        'Data subject to legal hold. Contact support for assistance.',
        'LEGAL_HOLD',
        403
      );
    }
    
    // Calculate scheduled deletion date
    const scheduledDeletion = new Date();
    scheduledDeletion.setDate(scheduledDeletion.getDate() + this.config.gracePeriodDays);
    
    // Create erasure request record
    const query = `
      INSERT INTO gdpr_erasure_requests (
        id, user_id, status, requested_at, 
        scheduled_deletion_at, grace_period_days, 
        categories, confirmation_token, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;
    
    const confirmationToken = crypto.randomBytes(32).toString('hex');
    const categories = options.categories || Object.keys(DATA_CATEGORIES);
    
    const result = await this.dbPool.query(query, [
      requestId,
      userId,
      ERASURE_STAGES.GRACE_PERIOD,
      timestamp,
      scheduledDeletion.toISOString(),
      this.config.gracePeriodDays,
      JSON.stringify(categories),
      confirmationToken,
      JSON.stringify({
        ipAddress: options.ipAddress,
        userAgent: options.userAgent,
        reason: options.reason || 'User requested',
      }),
    ]);
    
    // Log the request
    await this.auditLogger.log({
      userId,
      eventType: 'GDPR_ERASURE_REQUESTED',
      eventCategory: 'DATA_DELETION',
      resourceType: 'USER_DATA',
      resourceId: userId,
      action: 'ERASURE_REQUEST',
      metadata: {
        requestId,
        scheduledDeletion: scheduledDeletion.toISOString(),
        categories,
      },
    });
    
    // Soft-delete user data immediately
    await this.softDeleteUserData(userId, categories);
    
    return {
      requestId,
      status: ERASURE_STAGES.GRACE_PERIOD,
      message: `Erasure request received. Data will be permanently deleted after ${this.config.gracePeriodDays} days.`,
      gracePeriodDays: this.config.gracePeriodDays,
      scheduledDeletion: scheduledDeletion.toISOString(),
      canCancel: true,
      cancellationDeadline: scheduledDeletion.toISOString(),
      confirmationToken, // Required for cancellation
    };
  }

  /**
   * Cancel erasure request during grace period
   * @param {string} userId - User ID
   * @param {string} requestId - Erasure request ID
   * @param {string} confirmationToken - Confirmation token
   * @returns {Promise<Object>} Cancellation result
   */
  async cancelErasure(userId, requestId, confirmationToken) {
    // Verify request exists and is in grace period
    const query = `
      SELECT * FROM gdpr_erasure_requests
      WHERE id = $1 AND user_id = $2 AND status = $3
    `;
    
    const result = await this.dbPool.query(query, [
      requestId, userId, ERASURE_STAGES.GRACE_PERIOD,
    ]);
    
    if (result.rows.length === 0) {
      throw new GDPRErasureError(
        'Erasure request not found or cannot be cancelled',
        'NOT_CANCELLABLE',
        400
      );
    }
    
    const request = result.rows[0];
    
    // Verify confirmation token
    if (request.confirmation_token !== confirmationToken) {
      throw new GDPRErasureError(
        'Invalid confirmation token',
        'INVALID_TOKEN',
        403
      );
    }
    
    // Update request status
    const updateQuery = `
      UPDATE gdpr_erasure_requests
      SET status = $1, cancelled_at = $2, cancelled_by = $3
      WHERE id = $4
    `;
    
    await this.dbPool.query(updateQuery, [
      ERASURE_STAGES.CANCELLED,
      new Date().toISOString(),
      userId,
      requestId,
    ]);
    
    // Restore soft-deleted data
    await this.restoreUserData(userId, JSON.parse(request.categories));
    
    // Log cancellation
    await this.auditLogger.log({
      userId,
      eventType: 'GDPR_ERASURE_CANCELLED',
      eventCategory: 'DATA_DELETION',
      resourceType: 'USER_DATA',
      resourceId: userId,
      action: 'ERASURE_CANCEL',
      metadata: { requestId },
    });
    
    return {
      requestId,
      status: ERASURE_STAGES.CANCELLED,
      message: 'Erasure request cancelled successfully. Your data has been restored.',
    };
  }

  /**
   * Soft-delete user data (immediate effect)
   */
  async softDeleteUserData(userId, categories) {
    const client = await this.dbPool.connect();
    
    try {
      await client.query('BEGIN');
      
      for (const category of categories) {
        const policy = DATA_CATEGORIES[category];
        if (!policy) continue;
        
        if (policy.softDelete) {
          // Soft delete by setting deleted_at
          const query = `
            UPDATE ${policy.table}
            SET deleted_at = NOW(),
                deletion_reason = 'GDPR Article 17 erasure request'
            WHERE user_id = $1 AND deleted_at IS NULL
          `;
          await client.query(query, [userId]);
          
          // Handle cascade deletions
          if (policy.cascade) {
            for (const cascadeTable of policy.cascade) {
              const cascadeQuery = `
                UPDATE ${cascadeTable}
                SET deleted_at = NOW()
                WHERE user_id = $1 AND deleted_at IS NULL
              `;
              await client.query(cascadeQuery, [userId]);
            }
          }
        }
        
        // Revoke integration tokens immediately
        if (policy.revokeTokens) {
          await this.revokeIntegrationTokens(userId);
        }
      }
      
      // Disable user account
      await client.query(`
        UPDATE users
        SET account_status = 'pending_deletion',
            deletion_requested_at = NOW()
        WHERE id = $1
      `, [userId]);
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Restore user data (cancellation)
   */
  async restoreUserData(userId, categories) {
    const client = await this.dbPool.connect();
    
    try {
      await client.query('BEGIN');
      
      for (const category of categories) {
        const policy = DATA_CATEGORIES[category];
        if (!policy || !policy.softDelete) continue;
        
        // Restore soft-deleted records
        const query = `
          UPDATE ${policy.table}
          SET deleted_at = NULL,
              deletion_reason = NULL
          WHERE user_id = $1 AND deleted_at IS NOT NULL
        `;
        await client.query(query, [userId]);
        
        // Restore cascade tables
        if (policy.cascade) {
          for (const cascadeTable of policy.cascade) {
            const cascadeQuery = `
              UPDATE ${cascadeTable}
              SET deleted_at = NULL
              WHERE user_id = $1 AND deleted_at IS NOT NULL
            `;
            await client.query(cascadeQuery, [userId]);
          }
        }
      }
      
      // Restore user account
      await client.query(`
        UPDATE users
        SET account_status = 'active',
            deletion_requested_at = NULL
        WHERE id = $1
      `, [userId]);
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Process permanent erasure after grace period
   */
  async processPermanentErasure(requestId) {
    const query = `
      SELECT * FROM gdpr_erasure_requests
      WHERE id = $1 AND status = $2
    `;
    
    const result = await this.dbPool.query(query, [
      requestId, ERASURE_STAGES.GRACE_PERIOD,
    ]);
    
    if (result.rows.length === 0) {
      throw new GDPRErasureError('Erasure request not found', 'NOT_FOUND', 404);
    }
    
    const request = result.rows[0];
    const userId = request.user_id;
    const categories = JSON.parse(request.categories);
    
    // Update status to processing
    await this.dbPool.query(`
      UPDATE gdpr_erasure_requests
      SET status = $1, processing_started_at = $2
      WHERE id = $3
    `, [ERASURE_STAGES.PROCESSING, new Date().toISOString(), requestId]);
    
    try {
      // Perform permanent deletion for each category
      for (const category of categories) {
        await this.permanentlyDeleteCategory(userId, category);
      }
      
      // Anonymize audit logs (retain for compliance)
      await this.anonymizeAuditLogs(userId);
      
      // Mark request as completed
      await this.dbPool.query(`
        UPDATE gdpr_erasure_requests
        SET status = $1, completed_at = $2
        WHERE id = $3
      `, [ERASURE_STAGES.COMPLETED, new Date().toISOString(), requestId]);
      
      // Log completion
      await this.auditLogger.log({
        userId,
        eventType: 'GDPR_ERASURE_COMPLETED',
        eventCategory: 'DATA_DELETION',
        resourceType: 'USER_DATA',
        resourceId: userId,
        action: 'ERASURE_COMPLETE',
        metadata: { requestId, categories },
      });
      
    } catch (error) {
      // Mark as failed
      await this.dbPool.query(`
        UPDATE gdpr_erasure_requests
        SET status = $1, error_message = $2
        WHERE id = $3
      `, [ERASURE_STAGES.FAILED, error.message, requestId]);
      
      throw error;
    }
  }

  /**
   * Permanently delete data for a category
   */
  async permanentlyDeleteCategory(userId, category) {
    const policy = DATA_CATEGORIES[category];
    if (!policy) return;
    
    const client = await this.dbPool.connect();
    
    try {
      await client.query('BEGIN');
      
      if (policy.permanentAfter === 0) {
        // Immediate permanent deletion
        await client.query(`
          DELETE FROM ${policy.table}
          WHERE user_id = $1
        `, [userId]);
      } else if (policy.softDelete) {
        // Delete soft-deleted records
        await client.query(`
          DELETE FROM ${policy.table}
          WHERE user_id = $1 AND deleted_at IS NOT NULL
        `, [userId]);
      }
      
      // Handle cascade deletions
      if (policy.cascade) {
        for (const cascadeTable of policy.cascade) {
          await client.query(`
            DELETE FROM ${cascadeTable}
            WHERE user_id = $1
          `, [userId]);
        }
      }
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Anonymize audit logs (retain for compliance but remove PII)
   */
  async anonymizeAuditLogs(userId) {
    const anonymizedId = crypto.randomUUID();
    
    await this.dbPool.query(`
      UPDATE audit_logs
      SET user_id = $1,
          ip_address = '[REDACTED]',
          user_agent = '[REDACTED]',
          metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{anonymized}',
            'true'::jsonb
          )
      WHERE user_id = $2
    `, [anonymizedId, userId]);
  }

  /**
   * Revoke integration tokens
   */
  async revokeIntegrationTokens(userId) {
    // Get all integrations
    const result = await this.dbPool.query(`
      SELECT id, provider, access_token, refresh_token
      FROM user_integrations
      WHERE user_id = $1 AND deleted_at IS NULL
    `, [userId]);
    
    for (const integration of result.rows) {
      try {
        // Revoke at provider
        await this.revokeAtProvider(integration);
        
        // Clear tokens locally
        await this.dbPool.query(`
          UPDATE user_integrations
          SET access_token = '[REVOKED]',
              refresh_token = '[REVOKED]',
              status = 'revoked'
          WHERE id = $1
        `, [integration.id]);
      } catch (error) {
        // Log but continue - tokens will expire anyway
        console.error(`Failed to revoke tokens for integration ${integration.id}:`, error);
      }
    }
  }

  /**
   * Revoke tokens at provider
   */
  async revokeAtProvider(integration) {
    // Implementation depends on provider
    // Example for OAuth2 providers:
    const providerConfigs = {
      google: {
        revokeUrl: 'https://oauth2.googleapis.com/revoke',
      },
      github: {
        revokeUrl: 'https://api.github.com/applications/{client_id}/token',
      },
      // Add more providers as needed
    };
    
    const config = providerConfigs[integration.provider];
    if (!config) return;
    
    // Make revocation request
    // Implementation depends on provider's revocation endpoint
  }

  /**
   * Check for legal holds
   */
  async checkLegalHolds(userId) {
    const query = `
      SELECT * FROM legal_holds
      WHERE user_id = $1
      AND (expires_at IS NULL OR expires_at > NOW())
      AND status = 'active'
    `;
    
    const result = await this.dbPool.query(query, [userId]);
    return result.rows;
  }

  /**
   * Verify user exists
   */
  async verifyUserExists(userId) {
    const result = await this.dbPool.query(
      'SELECT 1 FROM users WHERE id = $1',
      [userId]
    );
    return result.rows.length > 0;
  }

  /**
   * Get pending erasure for user
   */
  async getPendingErasure(userId) {
    const query = `
      SELECT * FROM gdpr_erasure_requests
      WHERE user_id = $1
      AND status IN ($2, $3)
    `;
    
    const result = await this.dbPool.query(query, [
      userId,
      ERASURE_STAGES.PENDING,
      ERASURE_STAGES.GRACE_PERIOD,
    ]);
    
    return result.rows[0] || null;
  }

  /**
   * Get erasure status
   */
  async getErasureStatus(requestId, userId) {
    const query = `
      SELECT 
        id, status, requested_at, scheduled_deletion_at,
        grace_period_days, cancelled_at, completed_at,
        categories, error_message
      FROM gdpr_erasure_requests
      WHERE id = $1 AND user_id = $2
    `;
    
    const result = await this.dbPool.query(query, [requestId, userId]);
    
    if (result.rows.length === 0) {
      throw new GDPRErasureError('Erasure request not found', 'NOT_FOUND', 404);
    }
    
    const request = result.rows[0];
    
    return {
      requestId: request.id,
      status: request.status,
      requestedAt: request.requested_at,
      scheduledDeletion: request.scheduled_deletion_at,
      gracePeriodDays: request.grace_period_days,
      canCancel: request.status === ERASURE_STAGES.GRACE_PERIOD,
      cancelledAt: request.cancelled_at,
      completedAt: request.completed_at,
      categories: JSON.parse(request.categories),
      error: request.error_message,
    };
  }

  /**
   * Schedule grace period completion check
   */
  scheduleGracePeriodCheck() {
    // This would typically be done via a cron job or scheduled function
    // For now, we'll provide a method that can be called periodically
  }

  /**
   * Process expired grace periods (call this from cron job)
   */
  async processExpiredGracePeriods() {
    const query = `
      SELECT id FROM gdpr_erasure_requests
      WHERE status = $1
      AND scheduled_deletion_at <= NOW()
    `;
    
    const result = await this.dbPool.query(query, [ERASURE_STAGES.GRACE_PERIOD]);
    
    for (const row of result.rows) {
      try {
        await this.processPermanentErasure(row.id);
        console.log(`Processed permanent erasure for request ${row.id}`);
      } catch (error) {
        console.error(`Failed to process erasure ${row.id}:`, error);
      }
    }
    
    return result.rows.length;
  }

  /**
   * Close connections
   */
  async close() {
    await this.dbPool.end();
    await this.erasureQueue.close();
  }
}

class GDPRErasureError extends Error {
  constructor(message, code, statusCode = 500) {
    super(message);
    this.name = 'GDPRErasureError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

module.exports = {
  GDPRErasureService,
  GDPRErasureError,
  ERASURE_STAGES,
  DATA_CATEGORIES,
};
