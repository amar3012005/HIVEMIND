/**
 * HIVE-MIND Audit Log Retention Manager
 * Implements 7-year retention policy per NIS2/DORA requirements
 * Handles archival and deletion of expired logs
 */

const { Pool } = require('pg');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { createGzip } = require('zlib');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const path = require('path');

// Retention configuration
const RETENTION_CONFIG = {
  // Retention periods by data type
  retentionDays: {
    audit_logs: 7 * 365,           // 7 years (NIS2/DORA)
    security_events: 7 * 365,      // 7 years
    authentication_logs: 7 * 365,  // 7 years
    access_logs: 2 * 365,          // 2 years
    error_logs: 90,                // 90 days
  },
  
  // Archival configuration
  archive: {
    enabled: true,
    storage: 's3',                 // 's3' or 'filesystem'
    bucket: process.env.AUDIT_ARCHIVE_BUCKET || 'hivemind-audit-archive',
    region: process.env.AUDIT_ARCHIVE_REGION || 'eu-west-3',
    prefix: 'audit-logs/',
    compression: 'gzip',
  },
  
  // Processing configuration
  batchSize: 10000,
  dryRun: false,                   // Set to true to preview without deleting
};

class RetentionManager {
  constructor(config = {}) {
    this.config = { ...RETENTION_CONFIG, ...config };
    
    // Database connection
    this.dbPool = new Pool({
      host: process.env.AUDIT_DB_HOST || process.env.DB_HOST || 'localhost',
      port: process.env.AUDIT_DB_PORT || process.env.DB_PORT || 5432,
      database: process.env.AUDIT_DB_NAME || 'hivemind_audit',
      user: process.env.AUDIT_DB_USER || 'hivemind_audit',
      password: process.env.AUDIT_DB_PASSWORD,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });
    
    // S3 client for archival
    if (this.config.archive.storage === 's3') {
      this.s3Client = new S3Client({
        region: this.config.archive.region,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      });
    }
  }

  /**
   * Enforce retention policy for all log types
   */
  async enforceRetentionPolicy() {
    const results = {};
    
    for (const [table, retentionDays] of Object.entries(this.config.retentionDays)) {
      console.log(`Processing retention for ${table} (${retentionDays} days)...`);
      
      try {
        const result = await this.processTableRetention(table, retentionDays);
        results[table] = result;
      } catch (error) {
        console.error(`Failed to process ${table}:`, error);
        results[table] = { error: error.message };
      }
    }
    
    return results;
  }

  /**
   * Process retention for a specific table
   */
  async processTableRetention(table, retentionDays) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    
    const result = {
      table,
      retentionDays,
      cutoffDate: cutoffDate.toISOString(),
      archived: 0,
      deleted: 0,
      errors: [],
    };
    
    // Get count of expired records
    const countQuery = `SELECT COUNT(*) as count FROM ${table} WHERE timestamp < $1`;
    const countResult = await this.dbPool.query(countQuery, [cutoffDate]);
    const expiredCount = parseInt(countResult.rows[0].count, 10);
    
    result.expiredRecords = expiredCount;
    
    if (expiredCount === 0) {
      return result;
    }
    
    console.log(`Found ${expiredCount} expired records in ${table}`);
    
    // Archive before deletion (if enabled)
    if (this.config.archive.enabled && !this.config.dryRun) {
      const archiveResult = await this.archiveExpiredRecords(table, cutoffDate);
      result.archived = archiveResult.archivedCount;
      result.archiveLocation = archiveResult.location;
    }
    
    // Delete expired records
    if (!this.config.dryRun) {
      const deleteResult = await this.deleteExpiredRecords(table, cutoffDate);
      result.deleted = deleteResult.deletedCount;
    } else {
      console.log(`[DRY RUN] Would delete ${expiredCount} records from ${table}`);
    }
    
    return result;
  }

  /**
   * Archive expired records to S3
   */
  async archiveExpiredRecords(table, cutoffDate) {
    const archiveDate = new Date().toISOString().split('T')[0];
    const archiveKey = `${this.config.archive.prefix}${table}/${archiveDate}-${table}.json.gz`;
    
    // Stream records to S3
    let archivedCount = 0;
    let lastId = null;
    
    // Create a readable stream
    const records = [];
    
    while (true) {
      const query = `
        SELECT * FROM ${table}
        WHERE timestamp < $1
        ${lastId ? `AND id > '${lastId}'` : ''}
        ORDER BY id
        LIMIT $2
      `;
      
      const result = await this.dbPool.query(query, [cutoffDate, this.config.batchSize]);
      
      if (result.rows.length === 0) break;
      
      records.push(...result.rows);
      archivedCount += result.rows.length;
      lastId = result.rows[result.rows.length - 1].id;
    }
    
    if (records.length === 0) {
      return { archivedCount: 0, location: null };
    }
    
    // Create JSON and compress
    const jsonData = JSON.stringify(records, null, 2);
    const compressed = await this.compressData(jsonData);
    
    // Upload to S3
    const command = new PutObjectCommand({
      Bucket: this.config.archive.bucket,
      Key: archiveKey,
      Body: compressed,
      ContentType: 'application/gzip',
      ServerSideEncryption: 'AES256',
      Metadata: {
        'x-amz-meta-table': table,
        'x-amz-meta-cutoff-date': cutoffDate.toISOString(),
        'x-amz-meta-record-count': String(archivedCount),
        'x-amz-meta-archive-date': new Date().toISOString(),
      },
    });
    
    await this.s3Client.send(command);
    
    console.log(`Archived ${archivedCount} records to s3://${this.config.archive.bucket}/${archiveKey}`);
    
    return {
      archivedCount,
      location: `s3://${this.config.archive.bucket}/${archiveKey}`,
    };
  }

  /**
   * Compress data using gzip
   */
  async compressData(data) {
    const { promisify } = require('util');
    const { gzip } = require('zlib');
    const gzipAsync = promisify(gzip);
    return gzipAsync(Buffer.from(data));
  }

  /**
   * Delete expired records
   */
  async deleteExpiredRecords(table, cutoffDate) {
    const query = `DELETE FROM ${table} WHERE timestamp < $1`;
    
    const result = await this.dbPool.query(query, [cutoffDate]);
    
    console.log(`Deleted ${result.rowCount} records from ${table}`);
    
    return { deletedCount: result.rowCount };
  }

  /**
   * Get retention statistics
   */
  async getRetentionStats() {
    const stats = {};
    
    for (const table of Object.keys(this.config.retentionDays)) {
      const query = `
        SELECT 
          COUNT(*) as total_records,
          MIN(timestamp) as oldest_record,
          MAX(timestamp) as newest_record,
          COUNT(CASE WHEN timestamp < NOW() - INTERVAL '${this.config.retentionDays[table]} days' THEN 1 END) as expired_records
        FROM ${table}
      `;
      
      try {
        const result = await this.dbPool.query(query);
        stats[table] = result.rows[0];
      } catch (error) {
        stats[table] = { error: error.message };
      }
    }
    
    return stats;
  }

  /**
   * Schedule retention job (to be called from cron)
   */
  async scheduleRetentionJob() {
    console.log('Starting scheduled retention enforcement...');
    
    const results = await this.enforceRetentionPolicy();
    
    // Log completion
    console.log('Retention enforcement completed:', JSON.stringify(results, null, 2));
    
    return results;
  }

  /**
   * Close connections
   */
  async close() {
    await this.dbPool.end();
  }
}

module.exports = {
  RetentionManager,
  RETENTION_CONFIG,
};
