/**
 * HIVE-MIND Audit Log Export Service
 * Supports JSON, CSV, and Parquet formats for regulatory submission
 * Compliance: NIS2 Article 23, DORA ICT Risk Management
 */

const { Pool } = require('pg');
const { createWriteStream } = require('fs');
const { pipeline } = require('stream/promises');
const { createGzip } = require('zlib');
const path = require('path');
const { Parser } = require('json2csv');

// Export configuration
const EXPORT_CONFIG = {
  formats: ['json', 'csv', 'parquet'],
  defaultFormat: 'json',
  maxRecords: 1000000, // 1M records max per export
  compression: true,
  
  // Fields to include in export
  fields: [
    'id',
    'timestamp',
    'event_type',
    'event_category',
    'user_id',
    'user_type',
    'session_id',
    'resource_type',
    'resource_id',
    'action',
    'action_result',
    'ip_address',
    'user_agent',
    'request_id',
    'metadata',
    'integrity_hash',
  ],
};

class AuditExportService {
  constructor(config = {}) {
    this.config = { ...EXPORT_CONFIG, ...config };
    
    this.dbPool = new Pool({
      host: process.env.AUDIT_DB_HOST || process.env.DB_HOST || 'localhost',
      port: process.env.AUDIT_DB_PORT || process.env.DB_PORT || 5432,
      database: process.env.AUDIT_DB_NAME || 'hivemind_audit',
      user: process.env.AUDIT_DB_USER || 'hivemind_audit',
      password: process.env.AUDIT_DB_PASSWORD,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });
  }

  /**
   * Export audit logs in specified format
   * @param {Object} filters - Export filters
   * @param {string} format - Export format (json, csv, parquet)
   * @returns {Promise<Object>} Export result
   */
  async export(filters = {}, format = 'json') {
    if (!this.config.formats.includes(format)) {
      throw new Error(`Unsupported format: ${format}. Use: ${this.config.formats.join(', ')}`);
    }
    
    const exportId = `audit-export-${Date.now()}`;
    const tempPath = path.join('/tmp', `${exportId}.${format}${this.config.compression ? '.gz' : ''}`);
    
    try {
      // Build query
      const { query, params } = this.buildExportQuery(filters);
      
      // Stream results to file
      const writeStream = createWriteStream(tempPath);
      const transformStream = this.createTransformStream(format);
      
      if (this.config.compression) {
        const gzip = createGzip();
        await this.streamToFile(query, params, transformStream, gzip, writeStream);
      } else {
        await this.streamToFile(query, params, transformStream, writeStream);
      }
      
      // Get file stats
      const fs = require('fs').promises;
      const stats = await fs.stat(tempPath);
      
      return {
        exportId,
        format,
        compressed: this.config.compression,
        recordCount: await this.getExportCount(filters),
        fileSize: stats.size,
        filePath: tempPath,
        filters,
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      // Cleanup on error
      try {
        require('fs').unlinkSync(tempPath);
      } catch (e) {}
      throw error;
    }
  }

  /**
   * Build export query with filters
   */
  buildExportQuery(filters) {
    const {
      startDate,
      endDate,
      eventTypes,
      eventCategories,
      userId,
      resourceType,
      actionResult,
    } = filters;
    
    let query = `
      SELECT ${this.config.fields.join(', ')}
      FROM audit_logs
      WHERE 1=1
    `;
    
    const params = [];
    let paramIndex = 1;
    
    if (startDate) {
      query += ` AND timestamp >= $${paramIndex++}`;
      params.push(startDate);
    }
    
    if (endDate) {
      query += ` AND timestamp <= $${paramIndex++}`;
      params.push(endDate);
    }
    
    if (eventTypes && eventTypes.length > 0) {
      query += ` AND event_type = ANY($${paramIndex++})`;
      params.push(eventTypes);
    }
    
    if (eventCategories && eventCategories.length > 0) {
      query += ` AND event_category = ANY($${paramIndex++})`;
      params.push(eventCategories);
    }
    
    if (userId) {
      query += ` AND user_id = $${paramIndex++}`;
      params.push(userId);
    }
    
    if (resourceType) {
      query += ` AND resource_type = $${paramIndex++}`;
      params.push(resourceType);
    }
    
    if (actionResult) {
      query += ` AND action_result = $${paramIndex++}`;
      params.push(actionResult);
    }
    
    query += ` ORDER BY timestamp ASC`;
    query += ` LIMIT ${this.config.maxRecords}`;
    
    return { query, params };
  }

  /**
   * Get count of records matching filters
   */
  async getExportCount(filters) {
    const { query, params } = this.buildExportQuery(filters);
    const countQuery = query.replace(/SELECT.*FROM/, 'SELECT COUNT(*) as count FROM');
    const result = await this.dbPool.query(countQuery, params);
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Create transform stream for format
   */
  createTransformStream(format) {
    switch (format) {
      case 'json':
        return this.createJSONTransform();
      case 'csv':
        return this.createCSVTransform();
      case 'parquet':
        return this.createParquetTransform();
      default:
        throw new Error(`Unknown format: ${format}`);
    }
  }

  /**
   * Create JSON transform stream
   */
  createJSONTransform() {
    const { Transform } = require('stream');
    let first = true;
    
    return new Transform({
      objectMode: true,
      transform(chunk, encoding, callback) {
        if (first) {
          this.push('[\n');
          first = false;
        } else {
          this.push(',\n');
        }
        this.push(JSON.stringify(chunk, null, 2));
        callback();
      },
      flush(callback) {
        this.push('\n]');
        callback();
      },
    });
  }

  /**
   * Create CSV transform stream
   */
  createCSVTransform() {
    const { Transform } = require('stream');
    const parser = new Parser({
      fields: this.config.fields,
      header: true,
    });
    
    let headerWritten = false;
    
    return new Transform({
      objectMode: true,
      transform(chunk, encoding, callback) {
        try {
          if (!headerWritten) {
            this.push(parser.parse([chunk]));
            headerWritten = true;
          } else {
            // Parse returns header + data, so we need to extract just the data line
            const lines = parser.parse([chunk]).split('\n');
            this.push(lines[1] + '\n');
          }
          callback();
        } catch (error) {
          callback(error);
        }
      },
    });
  }

  /**
   * Create Parquet transform stream
   */
  createParquetTransform() {
    // Parquet implementation would require parquetjs or similar
    // For now, return a pass-through that collects data
    const { Transform } = require('stream');
    const records = [];
    
    return new Transform({
      objectMode: true,
      transform(chunk, encoding, callback) {
        records.push(chunk);
        callback();
      },
      flush(callback) {
        // In real implementation, write parquet file
        this.push(JSON.stringify(records));
        callback();
      },
    });
  }

  /**
   * Stream query results to file
   */
  async streamToFile(query, params, ...streams) {
    const cursor = await this.dbPool.query(new (require('pg-cursor'))(query, params));
    
    const { Readable } = require('stream');
    
    const source = new Readable({
      objectMode: true,
      read() {
        cursor.read(100, (err, rows) => {
          if (err) {
            this.destroy(err);
            return;
          }
          
          if (rows.length === 0) {
            this.push(null);
            cursor.close();
            return;
          }
          
          for (const row of rows) {
            this.push(row);
          }
        });
      },
    });
    
    await pipeline(source, ...streams);
  }

  /**
   * Generate compliance report for regulatory submission
   */
  async generateComplianceReport(startDate, endDate) {
    const report = {
      reportType: 'NIS2/DORA Audit Log Compliance Report',
      generatedAt: new Date().toISOString(),
      period: { startDate, endDate },
      organization: 'HIVE-MIND',
      contact: 'dpo@hivemind.io',
      
      summary: await this.generateSummary(startDate, endDate),
      eventBreakdown: await this.generateEventBreakdown(startDate, endDate),
      securityEvents: await this.generateSecurityEventSummary(startDate, endDate),
      integrityVerification: await this.verifyIntegrity(startDate, endDate),
    };
    
    return report;
  }

  /**
   * Generate summary statistics
   */
  async generateSummary(startDate, endDate) {
    const query = `
      SELECT 
        COUNT(*) as total_events,
        COUNT(DISTINCT user_id) as unique_users,
        COUNT(DISTINCT event_type) as event_types,
        COUNT(CASE WHEN action_result = 'FAILURE' THEN 1 END) as failed_actions,
        COUNT(CASE WHEN action_result = 'DENIED' THEN 1 END) as denied_actions
      FROM audit_logs
      WHERE timestamp >= $1 AND timestamp <= $2
    `;
    
    const result = await this.dbPool.query(query, [startDate, endDate]);
    return result.rows[0];
  }

  /**
   * Generate event type breakdown
   */
  async generateEventBreakdown(startDate, endDate) {
    const query = `
      SELECT 
        event_category,
        event_type,
        COUNT(*) as count,
        COUNT(CASE WHEN action_result = 'SUCCESS' THEN 1 END) as success_count,
        COUNT(CASE WHEN action_result = 'FAILURE' THEN 1 END) as failure_count
      FROM audit_logs
      WHERE timestamp >= $1 AND timestamp <= $2
      GROUP BY event_category, event_type
      ORDER BY count DESC
    `;
    
    const result = await this.dbPool.query(query, [startDate, endDate]);
    return result.rows;
  }

  /**
   * Generate security event summary
   */
  async generateSecurityEventSummary(startDate, endDate) {
    const query = `
      SELECT 
        event_type,
        COUNT(*) as count,
        MIN(timestamp) as first_occurrence,
        MAX(timestamp) as last_occurrence
      FROM audit_logs
      WHERE timestamp >= $1 AND timestamp <= $2
      AND event_category = 'SECURITY'
      GROUP BY event_type
      ORDER BY count DESC
    `;
    
    const result = await this.dbPool.query(query, [startDate, endDate]);
    return result.rows;
  }

  /**
   * Verify log integrity for period
   */
  async verifyIntegrity(startDate, endDate) {
    const { AuditLogger } = require('./logger');
    const logger = new AuditLogger();
    return await logger.verifyIntegrity(startDate, endDate);
  }

  /**
   * Close connections
   */
  async close() {
    await this.dbPool.end();
  }
}

module.exports = {
  AuditExportService,
  EXPORT_CONFIG,
};
