/**
 * HIVE-MIND Consent Management Service
 * Implements GDPR Article 7 - Conditions for Consent
 * Compliance: GDPR Article 7, Article 8, Article 9 (special categories)
 */

const { Pool } = require('pg');
const crypto = require('crypto');
const { AuditLogger } = require('../audit/logger');

// Consent configuration
const CONSENT_CONFIG = {
  // Consent types and their requirements
  types: {
    TERMS_OF_SERVICE: {
      id: 'tos',
      name: 'Terms of Service',
      required: true,
      version: '1.0',
      description: 'Agreement to Terms of Service',
      url: '/legal/terms',
    },
    PRIVACY_POLICY: {
      id: 'privacy',
      name: 'Privacy Policy',
      required: true,
      version: '1.0',
      description: 'Agreement to Privacy Policy',
      url: '/legal/privacy',
    },
    DATA_PROCESSING: {
      id: 'data_processing',
      name: 'Data Processing',
      required: true,
      version: '1.0',
      description: 'Consent to process personal data for service provision',
      url: '/legal/data-processing',
    },
    AI_MEMORY: {
      id: 'ai_memory',
      name: 'AI Memory Storage',
      required: false,
      version: '1.0',
      description: 'Store conversations and facts for AI context',
      url: '/legal/ai-memory',
      granular: true,
      subOptions: [
        { id: 'conversation_memory', name: 'Conversation History' },
        { id: 'fact_extraction', name: 'Fact Extraction' },
        { id: 'cross_session', name: 'Cross-Session Memory' },
      ],
    },
    MARKETING: {
      id: 'marketing',
      name: 'Marketing Communications',
      required: false,
      version: '1.0',
      description: 'Receive product updates and marketing emails',
      url: '/legal/marketing',
      channels: ['email', 'in_app'],
    },
    ANALYTICS: {
      id: 'analytics',
      name: 'Analytics & Improvement',
      required: false,
      version: '1.0',
      description: 'Allow usage analytics for service improvement',
      url: '/legal/analytics',
    },
    THIRD_PARTY_INTEGRATIONS: {
      id: 'third_party',
      name: 'Third-Party Integrations',
      required: false,
      version: '1.0',
      description: 'Connect external services (GitHub, Linear, etc.)',
      url: '/legal/integrations',
      granular: true,
      subOptions: [
        { id: 'github', name: 'GitHub Integration' },
        { id: 'linear', name: 'Linear Integration' },
        { id: 'slack', name: 'Slack Integration' },
        { id: 'notion', name: 'Notion Integration' },
      ],
    },
    COOKIES: {
      id: 'cookies',
      name: 'Cookie Preferences',
      required: false,
      version: '1.0',
      description: 'Cookie and tracking preferences',
      url: '/legal/cookies',
      granular: true,
      categories: [
        { id: 'essential', name: 'Essential', required: true, description: 'Required for site functionality' },
        { id: 'functional', name: 'Functional', required: false, description: 'Enhanced functionality' },
        { id: 'analytics', name: 'Analytics', required: false, description: 'Usage analytics' },
        { id: 'marketing', name: 'Marketing', required: false, description: 'Marketing and advertising' },
      ],
    },
  },
  
  // Consent record retention (7 years for compliance)
  retentionYears: 7,
  
  // Re-consent triggers
  reconsentTriggers: {
    versionChange: true,
    significantChange: true,
    afterMonths: 12,
  },
};

class ConsentManager {
  constructor(config = {}) {
    this.config = { ...CONSENT_CONFIG, ...config };
    this.auditLogger = new AuditLogger();
    
    this.dbPool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'hivemind',
      user: process.env.DB_USER || 'hivemind',
      password: process.env.DB_PASSWORD,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });
  }

  /**
   * Get all consent types with current status for user
   * @param {string} userId - User ID
   * @returns {Promise<Array>} Consent types with status
   */
  async getConsentStatus(userId) {
    const consentTypes = Object.values(this.config.types);
    const statuses = [];
    
    for (const type of consentTypes) {
      const record = await this.getConsentRecord(userId, type.id);
      
      statuses.push({
        ...type,
        granted: record ? record.granted : false,
        grantedAt: record ? record.granted_at : null,
        withdrawnAt: record ? record.withdrawn_at : null,
        version: record ? record.consent_version : null,
        needsReconsent: await this.needsReconsent(userId, type.id),
        subOptions: type.granular && record ? record.sub_options : type.subOptions,
      });
    }
    
    return statuses;
  }

  /**
   * Record user consent
   * @param {string} userId - User ID
   * @param {Object} consentData - Consent data
   * @param {Object} context - Request context (IP, user agent)
   * @returns {Promise<Object>} Consent record
   */
  async recordConsent(userId, consentData, context) {
    const { consentType, granted, subOptions, metadata } = consentData;
    
    // Validate consent type
    const typeConfig = this.config.types[consentType];
    if (!typeConfig) {
      throw new ConsentError('Invalid consent type', 'INVALID_TYPE');
    }
    
    // Check if required consent is being denied
    if (typeConfig.required && !granted) {
      throw new ConsentError(
        `Consent for ${typeConfig.name} is required to use the service`,
        'REQUIRED_CONSENT'
      );
    }
    
    const timestamp = new Date().toISOString();
    const consentId = crypto.randomUUID();
    
    // Check for existing consent
    const existing = await this.getConsentRecord(userId, consentType);
    
    const client = await this.dbPool.connect();
    try {
      await client.query('BEGIN');
      
      // Withdraw existing consent if changing
      if (existing && existing.granted !== granted) {
        await client.query(`
          UPDATE user_consent
          SET withdrawn_at = $1,
              withdrawal_reason = $2
          WHERE id = $3
        `, [timestamp, granted ? 're-consent' : 'user_withdrawal', existing.id]);
      }
      
      // Insert new consent record
      const query = `
        INSERT INTO user_consent (
          id, user_id, consent_type, granted, granted_at,
          consent_version, ip_address, user_agent,
          sub_options, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
      `;
      
      const result = await client.query(query, [
        consentId,
        userId,
        consentType,
        granted,
        timestamp,
        typeConfig.version,
        context.ipAddress,
        context.userAgent,
        JSON.stringify(subOptions || {}),
        JSON.stringify(metadata || {}),
      ]);
      
      await client.query('COMMIT');
      
      // Audit log
      await this.auditLogger.log({
        userId,
        eventType: granted ? 'CONSENT_GRANTED' : 'CONSENT_WITHDRAWN',
        eventCategory: 'CONSENT',
        resourceType: 'CONSENT_RECORD',
        resourceId: consentId,
        action: granted ? 'GRANT' : 'WITHDRAW',
        metadata: {
          consentType,
          version: typeConfig.version,
          subOptions,
        },
      });
      
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Withdraw consent
   * @param {string} userId - User ID
   * @param {string} consentType - Consent type to withdraw
   * @param {Object} context - Request context
   * @returns {Promise<Object>} Withdrawal result
   */
  async withdrawConsent(userId, consentType, context) {
    const typeConfig = this.config.types[consentType];
    if (!typeConfig) {
      throw new ConsentError('Invalid consent type', 'INVALID_TYPE');
    }
    
    // Cannot withdraw required consent
    if (typeConfig.required) {
      throw new ConsentError(
        `Cannot withdraw required consent: ${typeConfig.name}`,
        'REQUIRED_CONSENT'
      );
    }
    
    const existing = await this.getConsentRecord(userId, consentType);
    if (!existing || !existing.granted) {
      return { message: 'Consent already withdrawn or never granted' };
    }
    
    const timestamp = new Date().toISOString();
    
    await this.dbPool.query(`
      UPDATE user_consent
      SET withdrawn_at = $1,
          withdrawal_ip = $2,
          withdrawal_user_agent = $3
      WHERE id = $4
    `, [timestamp, context.ipAddress, context.userAgent, existing.id]);
    
    // Handle withdrawal side effects
    await this.handleWithdrawalEffects(userId, consentType);
    
    // Audit log
    await this.auditLogger.log({
      userId,
      eventType: 'CONSENT_WITHDRAWN',
      eventCategory: 'CONSENT',
      resourceType: 'CONSENT_RECORD',
      resourceId: existing.id,
      action: 'WITHDRAW',
      metadata: { consentType },
    });
    
    return {
      consentType,
      withdrawnAt: timestamp,
      message: `Consent for ${typeConfig.name} has been withdrawn`,
    };
  }

  /**
   * Check if user has granted specific consent
   * @param {string} userId - User ID
   * @param {string} consentType - Consent type
   * @param {string} subOption - Optional sub-option
   * @returns {Promise<boolean>} Consent status
   */
  async hasConsent(userId, consentType, subOption = null) {
    const record = await this.getConsentRecord(userId, consentType);
    
    if (!record || !record.granted || record.withdrawn_at) {
      return false;
    }
    
    // Check sub-option if specified
    if (subOption && record.sub_options) {
      const options = typeof record.sub_options === 'string' 
        ? JSON.parse(record.sub_options) 
        : record.sub_options;
      return options[subOption] === true;
    }
    
    return true;
  }

  /**
   * Check if user has all required consents
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Validation result
   */
  async validateRequiredConsents(userId) {
    const requiredTypes = Object.entries(this.config.types)
      .filter(([_, config]) => config.required)
      .map(([key, _]) => key);
    
    const missing = [];
    const granted = [];
    
    for (const type of requiredTypes) {
      const hasConsent = await this.hasConsent(userId, type);
      if (hasConsent) {
        granted.push(type);
      } else {
        missing.push(type);
      }
    }
    
    return {
      valid: missing.length === 0,
      granted,
      missing,
      canUseService: missing.length === 0,
    };
  }

  /**
   * Check if re-consent is needed
   * @param {string} userId - User ID
   * @param {string} consentType - Consent type
   * @returns {Promise<boolean>} Whether re-consent is needed
   */
  async needsReconsent(userId, consentType) {
    const record = await this.getConsentRecord(userId, consentType);
    
    if (!record || !record.granted) {
      return true;
    }
    
    const typeConfig = this.config.types[consentType];
    
    // Check version change
    if (this.config.reconsentTriggers.versionChange && 
        record.consent_version !== typeConfig.version) {
      return true;
    }
    
    // Check time-based re-consent
    if (this.config.reconsentTriggers.afterMonths) {
      const grantedDate = new Date(record.granted_at);
      const monthsSince = (new Date() - grantedDate) / (1000 * 60 * 60 * 24 * 30);
      if (monthsSince >= this.config.reconsentTriggers.afterMonths) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Get consent record for user and type
   */
  async getConsentRecord(userId, consentType) {
    const query = `
      SELECT *
      FROM user_consent
      WHERE user_id = $1
      AND consent_type = $2
      AND withdrawn_at IS NULL
      ORDER BY granted_at DESC
      LIMIT 1
    `;
    
    const result = await this.dbPool.query(query, [userId, consentType]);
    return result.rows[0] || null;
  }

  /**
   * Handle side effects of consent withdrawal
   */
  async handleWithdrawalEffects(userId, consentType) {
    switch (consentType) {
      case 'AI_MEMORY':
        // Disable memory features
        await this.dbPool.query(`
          UPDATE user_preferences
          SET preference_value = 'false'::jsonb
          WHERE user_id = $1
          AND preference_key IN ('memory_enabled', 'fact_extraction')
        `, [userId]);
        break;
        
      case 'MARKETING':
        // Unsubscribe from marketing
        await this.dbPool.query(`
          UPDATE user_preferences
          SET preference_value = 'false'::jsonb
          WHERE user_id = $1
          AND preference_key LIKE 'marketing_%'
        `, [userId]);
        break;
        
      case 'ANALYTICS':
        // Disable analytics tracking
        await this.dbPool.query(`
          UPDATE user_preferences
          SET preference_value = 'false'::jsonb
          WHERE user_id = $1
          AND preference_key = 'analytics_enabled'
        `, [userId]);
        break;
        
      case 'THIRD_PARTY_INTEGRATIONS':
        // Revoke integration tokens
        await this.dbPool.query(`
          UPDATE user_integrations
          SET status = 'consent_withdrawn'
          WHERE user_id = $1
        `, [userId]);
        break;
    }
  }

  /**
   * Get consent history for user
   * @param {string} userId - User ID
   * @returns {Promise<Array>} Consent history
   */
  async getConsentHistory(userId) {
    const query = `
      SELECT 
        consent_type,
        granted,
        granted_at,
        withdrawn_at,
        consent_version,
        ip_address,
        user_agent
      FROM user_consent
      WHERE user_id = $1
      ORDER BY granted_at DESC
    `;
    
    const result = await this.dbPool.query(query, [userId]);
    return result.rows;
  }

  /**
   * Generate consent report for compliance
   * @param {Object} filters - Report filters
   * @returns {Promise<Object>} Consent report
   */
  async generateConsentReport(filters = {}) {
    const { startDate, endDate, consentType } = filters;
    
    let query = `
      SELECT 
        consent_type,
        COUNT(CASE WHEN granted = true AND withdrawn_at IS NULL THEN 1 END) as active_grants,
        COUNT(CASE WHEN granted = true THEN 1 END) as total_grants,
        COUNT(CASE WHEN withdrawn_at IS NOT NULL THEN 1 END) as withdrawals,
        MIN(granted_at) as first_consent,
        MAX(granted_at) as latest_consent
      FROM user_consent
      WHERE 1=1
    `;
    
    const params = [];
    let paramIndex = 1;
    
    if (startDate) {
      query += ` AND granted_at >= $${paramIndex++}`;
      params.push(startDate);
    }
    
    if (endDate) {
      query += ` AND granted_at <= $${paramIndex++}`;
      params.push(endDate);
    }
    
    if (consentType) {
      query += ` AND consent_type = $${paramIndex++}`;
      params.push(consentType);
    }
    
    query += ' GROUP BY consent_type';
    
    const result = await this.dbPool.query(query, params);
    
    return {
      generatedAt: new Date().toISOString(),
      filters,
      summary: result.rows,
    };
  }

  /**
   * Close database connections
   */
  async close() {
    await this.dbPool.end();
  }
}

class ConsentError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ConsentError';
    this.code = code;
  }
}

module.exports = {
  ConsentManager,
  ConsentError,
  CONSENT_CONFIG,
};
