/**
 * HIVE-MIND Audit Logger
 * Implements NIS2 Article 23 and DORA ICT Risk Management
 * 7-year retention with structured JSON format
 */

const { Pool } = require('pg');
const crypto = require('crypto');
const { Kafka } = require('kafkajs');

// Configuration
const AUDIT_CONFIG = {
  // Retention period (7 years for NIS2/DORA)
  retentionDays: 7 * 365,
  
  // Batch settings for performance
  batchSize: 100,
  flushIntervalMs: 5000,
  
  // Storage options
  storage: {
    primary: 'postgresql',      // Primary storage
    archive: 's3',              // Long-term archive
    realtime: 'kafka',          // Real-time streaming
  },
  
  // Integrity protection
  integrity: {
    enabled: true,
    algorithm: 'sha256',
    chainHashing: true,         // Link events with previous hash
  },
  
  // Sensitive fields to mask
  sensitiveFields: [
    'password',
    'token',
    'secret',
    'api_key',
    'private_key',
    'credit_card',
    'ssn',
    'password_hash',
  ],
};

// Event categories
const EVENT_CATEGORIES = {
  AUTHENTICATION: 'AUTHENTICATION',
  AUTHORIZATION: 'AUTHORIZATION',
  DATA_ACCESS: 'DATA_ACCESS',
  DATA_MODIFICATION: 'DATA_MODIFICATION',
  DATA_DELETION: 'DATA_DELETION',
  SECURITY: 'SECURITY',
  ADMINISTRATIVE: 'ADMINISTRATIVE',
  SYSTEM: 'SYSTEM',
  COMPLIANCE: 'COMPLIANCE',
  CONSENT: 'CONSENT',
};

// Event types
const EVENT_TYPES = {
  // Authentication
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILURE: 'LOGIN_FAILURE',
  LOGOUT: 'LOGOUT',
  SESSION_CREATED: 'SESSION_CREATED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  MFA_ENABLED: 'MFA_ENABLED',
  MFA_DISABLED: 'MFA_DISABLED',
  MFA_CHALLENGE: 'MFA_CHALLENGE',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
  PASSWORD_RESET_COMPLETED: 'PASSWORD_RESET_COMPLETED',
  
  // Authorization
  ACCESS_DENIED: 'ACCESS_DENIED',
  PERMISSION_GRANTED: 'PERMISSION_GRANTED',
  PERMISSION_REVOKED: 'PERMISSION_REVOKED',
  ROLE_ASSIGNED: 'ROLE_ASSIGNED',
  ROLE_REMOVED: 'ROLE_REMOVED',
  
  // Data Access
  DATA_EXPORT_REQUESTED: 'DATA_EXPORT_REQUESTED',
  DATA_EXPORT_COMPLETED: 'DATA_EXPORT_COMPLETED',
  DATA_EXPORT_FAILED: 'DATA_EXPORT_FAILED',
  DATA_READ: 'DATA_READ',
  DATA_SEARCH: 'DATA_SEARCH',
  
  // Data Modification
  DATA_CREATED: 'DATA_CREATED',
  DATA_UPDATED: 'DATA_UPDATED',
  DATA_DELETED: 'DATA_DELETED',
  BULK_UPDATE: 'BULK_UPDATE',
  
  // Data Deletion (GDPR)
  GDPR_ERASURE_REQUESTED: 'GDPR_ERASURE_REQUESTED',
  GDPR_ERASURE_CANCELLED: 'GDPR_ERASURE_CANCELLED',
  GDPR_ERASURE_COMPLETED: 'GDPR_ERASURE_COMPLETED',
  
  // Security
  SUSPICIOUS_ACTIVITY: 'SUSPICIOUS_ACTIVITY',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  CSRF_TOKEN_INVALID: 'CSRF_TOKEN_INVALID',
  XSS_ATTEMPT_BLOCKED: 'XSS_ATTEMPT_BLOCKED',
  SQL_INJECTION_BLOCKED: 'SQL_INJECTION_BLOCKED',
  BRUTE_FORCE_DETECTED: 'BRUTE_FORCE_DETECTED',
  SECURITY_ALERT: 'SECURITY_ALERT',
  
  // Administrative
  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  USER_DELETED: 'USER_DELETED',
  CONFIG_CHANGED: 'CONFIG_CHANGED',
  
  // System
  SYSTEM_STARTUP: 'SYSTEM_STARTUP',
  SYSTEM_SHUTDOWN: 'SYSTEM_SHUTDOWN',
  BACKUP_COMPLETED: 'BACKUP_COMPLETED',
  BACKUP_FAILED: 'BACKUP_FAILED',
  KEY_ROTATION: 'KEY_ROTATION',
  
  // Compliance
  AUDIT_LOG_EXPORTED: 'AUDIT_LOG_EXPORTED',
  RETENTION_POLICY_ENFORCED: 'RETENTION_POLICY_ENFORCED',
  COMPLIANCE_REPORT_GENERATED: 'COMPLIANCE_REPORT_GENERATED',
  
  // Consent
  CONSENT_GRANTED: 'CONSENT_GRANTED',
  CONSENT_WITHDRAWN: 'CONSENT_WITHDRAWN',
};

class AuditLogger {
  constructor(config = {}) {
    this.config = { ...AUDIT_CONFIG, ...config };
    this.buffer = [];
    this.lastHash = null;
    
    // Initialize database pool
    this.dbPool = new Pool({
      host: process.env.AUDIT_DB_HOST || process.env.DB_HOST || 'localhost',
      port: process.env.AUDIT_DB_PORT || process.env.DB_PORT || 5432,
      database: process.env.AUDIT_DB_NAME || 'hivemind_audit',
      user: process.env.AUDIT_DB_USER || 'hivemind_audit',
      password: process.env.AUDIT_DB_PASSWORD,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max: 20, // Connection pool size
    });
    
    // Initialize Kafka for real-time streaming (optional)
    if (this.config.storage.realtime === 'kafka') {
      this.kafka = new Kafka({
        clientId: 'hivemind-audit',
        brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
      });
      this.kafkaProducer = this.kafka.producer();
      this.kafkaConnected = false;
    }
    
    // Start flush interval
    this.flushInterval = setInterval(() => this.flush(), this.config.flushIntervalMs);
    
    // Graceful shutdown
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
  }

  /**
   * Log an audit event
   * @param {Object} event - Audit event
   * @returns {Promise<void>}
   */
  async log(event) {
    try {
      const auditEvent = this.buildAuditEvent(event);
      
      // Add to buffer for batching
      this.buffer.push(auditEvent);
      
      // Flush if buffer is full
      if (this.buffer.length >= this.config.batchSize) {
        await this.flush();
      }
      
      // Also send to Kafka for real-time processing
      if (this.kafkaProducer && this.kafkaConnected) {
        await this.kafkaProducer.send({
          topic: 'audit-events',
          messages: [{ value: JSON.stringify(auditEvent) }],
        });
      }
    } catch (error) {
      // Never fail the main operation due to audit logging
      console.error('Audit logging error (non-blocking):', error);
    }
  }

  /**
   * Build structured audit event
   */
  buildAuditEvent(event) {
    const timestamp = new Date().toISOString();
    const eventId = crypto.randomUUID();
    
    // Build event structure
    const auditEvent = {
      // Core fields (NIS2/DORA required)
      id: eventId,
      timestamp,
      eventType: event.eventType,
      eventCategory: event.eventCategory || EVENT_CATEGORIES.SYSTEM,
      
      // Actor information
      userId: event.userId || null,
      userType: event.userType || 'USER', // USER, SERVICE, SYSTEM
      sessionId: event.sessionId || null,
      
      // Resource information
      resourceType: event.resourceType || null,
      resourceId: event.resourceId || null,
      
      // Action details
      action: event.action || null,
      actionResult: event.actionResult || 'SUCCESS', // SUCCESS, FAILURE, DENIED
      
      // Context
      ipAddress: this.maskIpAddress(event.ipAddress),
      userAgent: event.userAgent || null,
      requestId: event.requestId || null,
      
      // Metadata (sanitized)
      metadata: this.sanitizeMetadata(event.metadata || {}),
      
      // Integrity
      integrityHash: null, // Will be set after building
      previousHash: this.lastHash,
    };
    
    // Calculate integrity hash
    if (this.config.integrity.enabled) {
      auditEvent.integrityHash = this.calculateHash(auditEvent);
      this.lastHash = auditEvent.integrityHash;
    }
    
    return auditEvent;
  }

  /**
   * Calculate integrity hash for event
   */
  calculateHash(event) {
    const hashData = {
      id: event.id,
      timestamp: event.timestamp,
      eventType: event.eventType,
      userId: event.userId,
      resourceId: event.resourceId,
      action: event.action,
      previousHash: event.previousHash,
    };
    
    return crypto
      .createHash(this.config.integrity.algorithm)
      .update(JSON.stringify(hashData))
      .digest('hex');
  }

  /**
   * Mask IP address (preserve privacy)
   */
  maskIpAddress(ip) {
    if (!ip) return null;
    
    // IPv4 masking (keep first 3 octets)
    if (ip.includes('.')) {
      const parts = ip.split('.');
      if (parts.length === 4) {
        return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
      }
    }
    
    // IPv6 masking (keep first 4 segments)
    if (ip.includes(':')) {
      const parts = ip.split(':');
      return parts.slice(0, 4).join(':') + '::/64';
    }
    
    return ip;
  }

  /**
   * Sanitize metadata to remove sensitive data
   */
  sanitizeMetadata(metadata) {
    const sanitized = {};
    
    for (const [key, value] of Object.entries(metadata)) {
      // Check if field is sensitive
      const isSensitive = this.config.sensitiveFields.some(field => 
        key.toLowerCase().includes(field.toLowerCase())
      );
      
      if (isSensitive) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitizeMetadata(value);
      } else {
        sanitized[key] = value;
      }
    }
    
    return sanitized;
  }

  /**
   * Flush buffered events to database
   */
  async flush() {
    if (this.buffer.length === 0) return;
    
    const events = [...this.buffer];
    this.buffer = [];
    
    const client = await this.dbPool.connect();
    
    try {
      await client.query('BEGIN');
      
      for (const event of events) {
        const query = `
          INSERT INTO audit_logs (
            id, timestamp, event_type, event_category,
            user_id, user_type, session_id,
            resource_type, resource_id,
            action, action_result,
            ip_address, user_agent, request_id,
            metadata, integrity_hash, previous_hash
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        `;
        
        await client.query(query, [
          event.id,
          event.timestamp,
          event.eventType,
          event.eventCategory,
          event.userId,
          event.userType,
          event.sessionId,
          event.resourceType,
          event.resourceId,
          event.action,
          event.actionResult,
          event.ipAddress,
          event.userAgent,
          event.requestId,
          JSON.stringify(event.metadata),
          event.integrityHash,
          event.previousHash,
        ]);
      }
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      // Put events back in buffer for retry
      this.buffer.unshift(...events);
      console.error('Failed to flush audit events:', error);
    } finally {
      client.release();
    }
  }

  /**
   * Query audit logs
   * @param {Object} filters - Query filters
   * @returns {Promise<Array>} Audit events
   */
  async query(filters = {}) {
    const {
      userId,
      eventType,
      eventCategory,
      resourceType,
      resourceId,
      startDate,
      endDate,
      actionResult,
      limit = 100,
      offset = 0,
    } = filters;
    
    let query = `
      SELECT 
        id, timestamp, event_type, event_category,
        user_id, user_type, session_id,
        resource_type, resource_id,
        action, action_result,
        ip_address, user_agent, request_id,
        metadata, integrity_hash, previous_hash
      FROM audit_logs
      WHERE 1=1
    `;
    
    const params = [];
    let paramIndex = 1;
    
    if (userId) {
      query += ` AND user_id = $${paramIndex++}`;
      params.push(userId);
    }
    
    if (eventType) {
      query += ` AND event_type = $${paramIndex++}`;
      params.push(eventType);
    }
    
    if (eventCategory) {
      query += ` AND event_category = $${paramIndex++}`;
      params.push(eventCategory);
    }
    
    if (resourceType) {
      query += ` AND resource_type = $${paramIndex++}`;
      params.push(resourceType);
    }
    
    if (resourceId) {
      query += ` AND resource_id = $${paramIndex++}`;
      params.push(resourceId);
    }
    
    if (startDate) {
      query += ` AND timestamp >= $${paramIndex++}`;
      params.push(startDate);
    }
    
    if (endDate) {
      query += ` AND timestamp <= $${paramIndex++}`;
      params.push(endDate);
    }
    
    if (actionResult) {
      query += ` AND action_result = $${paramIndex++}`;
      params.push(actionResult);
    }
    
    query += ` ORDER BY timestamp DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(limit, offset);
    
    const result = await this.dbPool.query(query, params);
    return result.rows;
  }

  /**
   * Verify log integrity
   * @param {string} startDate - Start date for verification
   * @param {string} endDate - End date for verification
   * @returns {Promise<Object>} Verification result
   */
  async verifyIntegrity(startDate, endDate) {
    const query = `
      SELECT id, integrity_hash, previous_hash, timestamp
      FROM audit_logs
      WHERE timestamp >= $1 AND timestamp <= $2
      ORDER BY timestamp ASC
    `;
    
    const result = await this.dbPool.query(query, [startDate, endDate]);
    
    let violations = [];
    let previousHash = null;
    
    for (const row of result.rows) {
      // Verify chain integrity
      if (previousHash && row.previous_hash !== previousHash) {
        violations.push({
          eventId: row.id,
          timestamp: row.timestamp,
          issue: 'CHAIN_BREAK',
          expectedPreviousHash: previousHash,
          actualPreviousHash: row.previous_hash,
        });
      }
      
      previousHash = row.integrity_hash;
    }
    
    return {
      verified: violations.length === 0,
      totalEvents: result.rows.length,
      violations,
      startDate,
      endDate,
    };
  }

  /**
   * Connect to Kafka
   */
  async connectKafka() {
    if (this.kafkaProducer && !this.kafkaConnected) {
      await this.kafkaProducer.connect();
      this.kafkaConnected = true;
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    clearInterval(this.flushInterval);
    await this.flush();
    
    if (this.kafkaProducer && this.kafkaConnected) {
      await this.kafkaProducer.disconnect();
    }
    
    await this.dbPool.end();
  }
}

module.exports = {
  AuditLogger,
  EVENT_CATEGORIES,
  EVENT_TYPES,
  AUDIT_CONFIG,
};
