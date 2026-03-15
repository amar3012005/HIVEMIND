/**
 * HIVE-MIND GDPR Data Export Service
 * Implements Article 20 - Right to Data Portability
 * Compliance: GDPR Article 20, Article 30 (Records of Processing)
 */

const { Pool } = require('pg');
const { createWriteStream } = require('fs');
const { pipeline } = require('stream/promises');
const { createGzip } = require('zlib');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const { AuditLogger } = require('../audit/logger');
const { DataInventory } = require('./data-inventory');

// Configuration
const EXPORT_CONFIG = {
  // Export format settings
  format: 'json',
  compression: 'gzip',
  encoding: 'utf8',
  
  // Storage settings
  storage: {
    type: process.env.EXPORT_STORAGE_TYPE || 's3', // 's3' or 'filesystem'
    bucket: process.env.EXPORT_S3_BUCKET || 'hivemind-gdpr-exports',
    region: process.env.EXPORT_S3_REGION || 'eu-west-3', // EU (Paris)
    retentionDays: 7, // Export files retained for 7 days
  },
  
  // URL expiry
  signedUrlExpiry: 24 * 60 * 60, // 24 hours in seconds
  
  // Rate limiting
  maxExportsPerDay: 2,
  
  // Processing
  batchSize: 1000,
  maxFileSize: 100 * 1024 * 1024, // 100MB
};

// Sensitive fields to exclude from export
const EXCLUDED_FIELDS = new Set([
  'password',
  'password_hash',
  'api_secret',
  'private_key',
  'session_token',
  'refresh_token',
  'mfa_secret',
  'encryption_key',
  'hsm_pin',
  'vault_token',
]);

// Data categories for structured export
const DATA_CATEGORIES = {
  PROFILE: 'profile',
  MEMORIES: 'memories',
  SESSIONS: 'sessions',
  INTEGRATIONS: 'integrations',
  PREFERENCES: 'preferences',
  AUDIT_LOG: 'audit_log',
  CONSENT: 'consent',
};

class GDPRExportService {
  constructor(config = {}) {
    this.config = { ...EXPORT_CONFIG, ...config };
    this.auditLogger = new AuditLogger();
    this.dataInventory = new DataInventory();
    
    // Initialize database pool
    this.dbPool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'hivemind',
      user: process.env.DB_USER || 'hivemind',
      password: process.env.DB_PASSWORD,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });
    
    // Initialize S3 client for EU region
    if (this.config.storage.type === 's3') {
      this.s3Client = new S3Client({
        region: this.config.storage.region,
        endpoint: process.env.S3_ENDPOINT, // For MinIO or other S3-compatible
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      });
    }
    
    // Initialize job queue for async processing
    const redis = new IORedis({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD,
    });
    
    this.exportQueue = new Queue('gdpr-export', { connection: redis });
  }

  /**
   * Initiate async GDPR data export
   * @param {string} userId - User ID requesting export
   * @param {Object} options - Export options
   * @returns {Promise<Object>} Export job details
   */
  async initiateExport(userId, options = {}) {
    const requestId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    
    // Log the request
    await this.auditLogger.log({
      userId,
      eventType: 'GDPR_EXPORT_REQUESTED',
      eventCategory: 'DATA_ACCESS',
      resourceType: 'USER_DATA',
      resourceId: userId,
      action: 'EXPORT',
      metadata: {
        requestId,
        format: options.format || this.config.format,
        timestamp,
      },
    });

    // Check rate limit
    const recentExports = await this.getRecentExportCount(userId);
    if (recentExports >= this.config.maxExportsPerDay) {
      throw new GDPRExportError(
        'Export rate limit exceeded. Maximum 2 exports per day allowed.',
        'RATE_LIMIT_EXCEEDED',
        429
      );
    }

    // Create export job
    const job = await this.exportQueue.add(
      'process-export',
      {
        userId,
        requestId,
        options: {
          format: options.format || this.config.format,
          includeCategories: options.categories || Object.values(DATA_CATEGORIES),
        },
      },
      {
        jobId: requestId,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 60000,
        },
        removeOnComplete: false,
        removeOnFail: false,
      }
    );

    return {
      requestId,
      status: 'PROCESSING',
      estimatedCompletion: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 min estimate
      checkStatusUrl: `/api/gdpr/export/${requestId}/status`,
    };
  }

  /**
   * Process export job (called by worker)
   * @param {Object} job - BullMQ job
   */
  async processExport(job) {
    const { userId, requestId, options } = job.data;
    
    try {
      // Gather all user data
      const userData = await this.gatherUserData(userId, options.includeCategories);
      
      // Generate export file
      const exportResult = await this.generateExportFile(userId, requestId, userData, options);
      
      // Update job with result
      await job.updateProgress(100);
      
      // Log completion
      await this.auditLogger.log({
        userId,
        eventType: 'GDPR_EXPORT_COMPLETED',
        eventCategory: 'DATA_ACCESS',
        resourceType: 'USER_DATA',
        resourceId: userId,
        action: 'EXPORT_COMPLETE',
        metadata: {
          requestId,
          fileSize: exportResult.size,
          downloadUrl: exportResult.downloadUrl,
          expiresAt: exportResult.expiresAt,
        },
      });
      
      return exportResult;
    } catch (error) {
      // Log failure
      await this.auditLogger.log({
        userId,
        eventType: 'GDPR_EXPORT_FAILED',
        eventCategory: 'DATA_ACCESS',
        resourceType: 'USER_DATA',
        resourceId: userId,
        action: 'EXPORT_FAILED',
        metadata: {
          requestId,
          error: error.message,
        },
      });
      
      throw error;
    }
  }

  /**
   * Gather all user data across categories
   * @param {string} userId - User ID
   * @param {Array} categories - Data categories to include
   * @returns {Promise<Object>} Structured user data
   */
  async gatherUserData(userId, categories) {
    const data = {
      exportMetadata: {
        userId,
        generatedAt: new Date().toISOString(),
        version: '1.0',
        schema: 'hivemind-gdpr-export-v1',
        categories: [],
      },
    };

    for (const category of categories) {
      switch (category) {
        case DATA_CATEGORIES.PROFILE:
          data.profile = await this.getProfileData(userId);
          data.exportMetadata.categories.push(DATA_CATEGORIES.PROFILE);
          break;
          
        case DATA_CATEGORIES.MEMORIES:
          data.memories = await this.getMemoriesData(userId);
          data.exportMetadata.categories.push(DATA_CATEGORIES.MEMORIES);
          break;
          
        case DATA_CATEGORIES.SESSIONS:
          data.sessions = await this.getSessionsData(userId);
          data.exportMetadata.categories.push(DATA_CATEGORIES.SESSIONS);
          break;
          
        case DATA_CATEGORIES.INTEGRATIONS:
          data.integrations = await this.getIntegrationsData(userId);
          data.exportMetadata.categories.push(DATA_CATEGORIES.INTEGRATIONS);
          break;
          
        case DATA_CATEGORIES.PREFERENCES:
          data.preferences = await this.getPreferencesData(userId);
          data.exportMetadata.categories.push(DATA_CATEGORIES.PREFERENCES);
          break;
          
        case DATA_CATEGORIES.CONSENT:
          data.consent = await this.getConsentData(userId);
          data.exportMetadata.categories.push(DATA_CATEGORIES.CONSENT);
          break;
          
        case DATA_CATEGORIES.AUDIT_LOG:
          data.auditLog = await this.getAuditLogData(userId);
          data.exportMetadata.categories.push(DATA_CATEGORIES.AUDIT_LOG);
          break;
      }
    }

    return data;
  }

  /**
   * Get user profile data
   */
  async getProfileData(userId) {
    const query = `
      SELECT 
        id, email, username, display_name, 
        created_at, updated_at, last_login_at,
        email_verified, account_status, timezone, locale
      FROM users 
      WHERE id = $1
    `;
    
    const result = await this.dbPool.query(query, [userId]);
    return this.sanitizeData(result.rows[0]);
  }

  /**
   * Get user memories (core functionality data)
   */
  async getMemoriesData(userId) {
    const memories = [];
    let offset = 0;
    
    while (true) {
      const query = `
        SELECT 
          id, content, category, importance,
          source, created_at, updated_at, metadata,
          embedding_model, access_count, last_accessed_at
        FROM memories 
        WHERE user_id = $1 
        AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `;
      
      const result = await this.dbPool.query(query, [userId, this.config.batchSize, offset]);
      
      if (result.rows.length === 0) break;
      
      for (const row of result.rows) {
        memories.push(this.sanitizeData(row));
      }
      
      offset += this.config.batchSize;
    }
    
    return {
      count: memories.length,
      items: memories,
    };
  }

  /**
   * Get user session data
   */
  async getSessionsData(userId) {
    const query = `
      SELECT 
        id, created_at, expires_at, last_activity_at,
        ip_address, user_agent, device_type, location
      FROM user_sessions 
      WHERE user_id = $1 
      AND created_at > NOW() - INTERVAL '1 year'
      ORDER BY created_at DESC
    `;
    
    const result = await this.dbPool.query(query, [userId]);
    return {
      count: result.rows.length,
      items: result.rows.map(row => this.sanitizeData(row)),
    };
  }

  /**
   * Get user integrations (without secrets)
   */
  async getIntegrationsData(userId) {
    const query = `
      SELECT 
        id, provider, integration_type, status,
        created_at, updated_at, last_sync_at,
        scopes, webhook_url
      FROM user_integrations 
      WHERE user_id = $1 
      AND deleted_at IS NULL
    `;
    
    const result = await this.dbPool.query(query, [userId]);
    
    // Explicitly exclude secrets/tokens
    return {
      count: result.rows.length,
      items: result.rows.map(row => {
        const sanitized = this.sanitizeData(row);
        delete sanitized.access_token;
        delete sanitized.refresh_token;
        delete sanitized.api_key;
        delete sanitized.client_secret;
        return sanitized;
      }),
      note: 'Integration secrets and tokens are excluded for security.',
    };
  }

  /**
   * Get user preferences
   */
  async getPreferencesData(userId) {
    const query = `
      SELECT 
        preference_key, preference_value, category, updated_at
      FROM user_preferences 
      WHERE user_id = $1
    `;
    
    const result = await this.dbPool.query(query, [userId]);
    return {
      count: result.rows.length,
      items: result.rows,
    };
  }

  /**
   * Get user consent records
   */
  async getConsentData(userId) {
    const query = `
      SELECT 
        consent_type, granted, granted_at, withdrawn_at,
        ip_address, user_agent, consent_version
      FROM user_consent 
      WHERE user_id = $1
      ORDER BY granted_at DESC
    `;
    
    const result = await this.dbPool.query(query, [userId]);
    return {
      count: result.rows.length,
      items: result.rows,
    };
  }

  /**
   * Get audit log for user
   */
  async getAuditLogData(userId) {
    const query = `
      SELECT 
        event_type, event_category, action,
        resource_type, resource_id, ip_address,
        user_agent, created_at, metadata
      FROM audit_logs 
      WHERE user_id = $1 
      AND created_at > NOW() - INTERVAL '1 year'
      ORDER BY created_at DESC
      LIMIT 10000
    `;
    
    const result = await this.dbPool.query(query, [userId]);
    return {
      count: result.rows.length,
      note: 'Last 10,000 audit events included. Full log available via separate request.',
      items: result.rows,
    };
  }

  /**
   * Generate export file and upload to storage
   */
  async generateExportFile(userId, requestId, data, options) {
    const filename = `gdpr-export-${userId}-${requestId}-${Date.now()}.json.gz`;
    const tempPath = path.join('/tmp', filename);
    
    try {
      // Write data to compressed file
      const writeStream = createWriteStream(tempPath);
      const gzip = createGzip();
      
      await pipeline(
        async function* () {
          yield JSON.stringify(data, null, 2);
        },
        gzip,
        writeStream
      );
      
      // Get file stats
      const fs = require('fs').promises;
      const stats = await fs.stat(tempPath);
      
      if (stats.size > this.config.maxFileSize) {
        throw new GDPRExportError(
          'Export file exceeds maximum size limit',
          'EXPORT_TOO_LARGE',
          413
        );
      }
      
      // Upload to storage
      let storageKey;
      if (this.config.storage.type === 's3') {
        storageKey = await this.uploadToS3(tempPath, filename);
      } else {
        storageKey = await this.saveToFilesystem(tempPath, filename);
      }
      
      // Generate signed URL
      const downloadUrl = await this.generateSignedUrl(storageKey);
      
      // Schedule deletion
      await this.scheduleDeletion(storageKey);
      
      return {
        requestId,
        filename,
        size: stats.size,
        format: 'json.gz',
        downloadUrl,
        expiresAt: new Date(Date.now() + this.config.signedUrlExpiry * 1000).toISOString(),
      };
    } finally {
      // Cleanup temp file
      try {
        const fs = require('fs');
        fs.unlinkSync(tempPath);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Upload file to S3 (EU region)
   */
  async uploadToS3(filePath, filename) {
    const fs = require('fs');
    const fileStream = fs.createReadStream(filePath);
    
    const key = `exports/${filename}`;
    
    const command = new PutObjectCommand({
      Bucket: this.config.storage.bucket,
      Key: key,
      Body: fileStream,
      ContentType: 'application/gzip',
      ServerSideEncryption: 'AES256',
      Metadata: {
        'x-amz-meta-purpose': 'gdpr-export',
        'x-amz-meta-retention-days': String(this.config.storage.retentionDays),
      },
    });
    
    await this.s3Client.send(command);
    
    return key;
  }

  /**
   * Save file to local filesystem
   */
  async saveToFilesystem(filePath, filename) {
    const fs = require('fs').promises;
    const destDir = '/opt/hivemind/exports';
    await fs.mkdir(destDir, { recursive: true });
    
    const destPath = path.join(destDir, filename);
    await fs.copyFile(filePath, destPath);
    await fs.chmod(destPath, 0o600);
    
    return destPath;
  }

  /**
   * Generate signed URL for download
   */
  async generateSignedUrl(storageKey) {
    if (this.config.storage.type === 's3') {
      const command = new GetObjectCommand({
        Bucket: this.config.storage.bucket,
        Key: storageKey,
      });
      
      return await getSignedUrl(this.s3Client, command, {
        expiresIn: this.config.signedUrlExpiry,
      });
    } else {
      // For filesystem storage, return internal API endpoint
      return `/api/gdpr/export/download?file=${encodeURIComponent(storageKey)}`;
    }
  }

  /**
   * Schedule file deletion after retention period
   */
  async scheduleDeletion(storageKey) {
    // Implementation depends on storage backend
    // For S3, use lifecycle policies or scheduled job
    // For filesystem, use at command or cron
    
    const deletionDate = new Date();
    deletionDate.setDate(deletionDate.getDate() + this.config.storage.retentionDays);
    
    // Log scheduled deletion
    await this.auditLogger.log({
      eventType: 'GDPR_EXPORT_SCHEDULED_DELETION',
      eventCategory: 'DATA_RETENTION',
      resourceType: 'EXPORT_FILE',
      resourceId: storageKey,
      action: 'SCHEDULE_DELETE',
      metadata: {
        scheduledFor: deletionDate.toISOString(),
      },
    });
  }

  /**
   * Get export status
   */
  async getExportStatus(requestId) {
    const job = await this.exportQueue.getJob(requestId);
    
    if (!job) {
      throw new GDPRExportError('Export request not found', 'NOT_FOUND', 404);
    }
    
    const state = await job.getState();
    
    return {
      requestId,
      status: state.toUpperCase(),
      progress: job.progress,
      result: job.returnvalue,
      failedReason: job.failedReason,
    };
  }

  /**
   * Get recent export count for rate limiting
   */
  async getRecentExportCount(userId) {
    const query = `
      SELECT COUNT(*) as count
      FROM audit_logs
      WHERE user_id = $1
      AND event_type = 'GDPR_EXPORT_REQUESTED'
      AND created_at > NOW() - INTERVAL '1 day'
    `;
    
    const result = await this.dbPool.query(query, [userId]);
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Sanitize data by removing sensitive fields
   */
  sanitizeData(data) {
    if (!data || typeof data !== 'object') return data;
    
    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
      // Skip excluded fields
      if (EXCLUDED_FIELDS.has(key.toLowerCase())) {
        continue;
      }
      
      // Recursively sanitize nested objects
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        sanitized[key] = this.sanitizeData(value);
      } else {
        sanitized[key] = value;
      }
    }
    
    return sanitized;
  }

  /**
   * Close connections
   */
  async close() {
    await this.dbPool.end();
    await this.exportQueue.close();
  }
}

class GDPRExportError extends Error {
  constructor(message, code, statusCode = 500) {
    super(message);
    this.name = 'GDPRExportError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

module.exports = {
  GDPRExportService,
  GDPRExportError,
  DATA_CATEGORIES,
};
